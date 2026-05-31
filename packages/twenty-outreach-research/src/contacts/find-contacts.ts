// Stage 2 — Person Discovery. Per-org-on-demand contact finder.
//
// Given ONE Company (by id or domain), dispatches to a commercial or academic
// finder based on accountType, then runs shared Hunter enrichment + tier
// balancing + Twenty commit.
//
// Commercial path (accountType=COMPANY or LAB):
//   Apollo people search + Apollo enrichment + Firecrawl /team + Exa LinkedIn
//
// Academic path (accountType=INSTITUTION):
//   Firecrawl lab roster (probes /people, /members, /group, etc.) + S2 PI
//   co-author expansion + Exa LinkedIn. Captures grad students + postdocs.
//
// CLI:
//   yarn stage2:contacts --company-id <uuid> [--limit 10] [--dry-run]
//   yarn stage2:contacts --domain sereact.ai [--limit 10] [--dry-run]
//   yarn stage2:contacts --domain yale.edu --lab-url <url> --lab-pi "Name" [--limit 20]
//   yarn stage2:contacts --domain mistral.ai --program [--lead "Name"] [--program-url <url>]
//
// Flags:
//   --titles "a,b,c"           override the default title filter
//   --lab-url <url>            academic: lab roster page to scrape
//   --lab-pi "Name"            academic: PI name for S2 co-author lookup
//   --program[=a,b,c]          program-scoped commercial mode: gate a big
//                              company down to its robotics program (default
//                              robotics keywords, or a custom comma list)
//   --lead "Name"              program: known program lead for S2 co-author hop
//   --program-url <url>        program: research/team page to scrape
//   --no-apollo / --no-exa /   disable individual sources
//     --no-firecrawl / --no-s2 / --no-hunter
//   --no-leads                 disable the agentic role-finder (org-chart/news
//                              → LLM → Apollo match; on by default, commercial+program)
//   --no-verify                disable the Hunter email-verification gate
//   --dry-run                  print candidates; no CRM writes (default = commit)
import 'dotenv/config';

import {
  fetchCompanyById,
  fetchCompanyByDomain,
  upsertCompanyByDomain,
  updateCompanyFields,
  updatePersonFields,
  recomputeCompanyOutreachStage,
  upsertPersonFromDiscovery,
  type CompanyForLookup,
} from '../lib/twenty-client.js';
import { ICP_COMPANIES, INSTITUTION_ALLOWLIST } from '../discover/sources.js';

import { findAcademicContacts } from './academic-finder.js';
import { findCommercialContacts, type FinderResult } from './commercial-finder.js';
import { findProgramContacts, DEFAULT_PROGRAM_KEYWORDS } from './program-finder.js';
import { findRoleLeads } from './find-leads.js';
import { verifyEmail } from './hunter.js';
import {
  ACADEMIC_TITLES,
  BUSINESS_TITLES,
  DEFAULT_TITLES,
  FOUNDER_TITLES,
  classifyTier,
  dedupByEmail,
  dedupCandidates,
  emailConfidenceFrom,
  enrichWithHunter,
  scoreCandidate,
  sleep,
} from './shared.js';
import { classifyRole } from './role-taxonomy.js';
import type { AccountType, Candidate, FinderTarget, Tier } from './types.js';

type Args = {
  companyId?: string;
  domain?: string;
  labUrl?: string;
  piName?: string;
  titles?: string[];
  // Program-scoped commercial mode: robotics keywords used to gate a big
  // company down to its robotics program. Presence routes to the program
  // finder; --lead / --program-url alias to piName / labUrl.
  program?: string[];
  limit: number;
  dryRun: boolean;
  forceInstitution: boolean;
  skipApollo: boolean;
  skipFirecrawl: boolean;
  skipExa: boolean;
  skipS2: boolean;
  skipHunter: boolean;
  // Agentic role-finder (org-chart/news → LLM → Apollo match). On by default for
  // commercial + program targets; --no-leads disables. Email verification gate
  // (Hunter verifier on the final top-N); --no-verify disables.
  noLeads: boolean;
  noVerify: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const get = (flag: string): string | undefined =>
    argv.find((a) => a.startsWith(`${flag}=`))?.replace(`${flag}=`, '');
  // --lead / --program-url are friendlier aliases for --lab-pi / --lab-url in
  // program mode; CLI value wins, else the academic flag.
  const piName = get('--lead') ?? get('--lab-pi');
  const labUrl = get('--program-url') ?? get('--lab-url');
  // --program enables program-scoped mode. Accept "--program=a,b,c" (custom
  // keywords) or a bare "--program" (robotics defaults).
  const programRaw = get('--program');
  const programMode = programRaw !== undefined || argv.includes('--program');
  return {
    ...(get('--company-id') && { companyId: get('--company-id') }),
    ...(get('--domain') && { domain: get('--domain') }),
    ...(labUrl && { labUrl }),
    ...(piName && { piName }),
    ...(get('--titles') && { titles: get('--titles')!.split(',').map((s) => s.trim()) }),
    ...(programMode && {
      program: programRaw
        ? programRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_PROGRAM_KEYWORDS,
    }),
    limit: Number(get('--limit') ?? '0') || 0,
    dryRun: argv.includes('--dry-run'),
    forceInstitution: argv.includes('--institution'),
    skipApollo: argv.includes('--no-apollo'),
    skipFirecrawl: argv.includes('--no-firecrawl'),
    skipExa: argv.includes('--no-exa'),
    skipS2: argv.includes('--no-s2'),
    skipHunter: argv.includes('--no-hunter'),
    noLeads: argv.includes('--no-leads'),
    noVerify: argv.includes('--no-verify'),
  };
};

// Default --limit varies by account type: academic explicitly captures grad
// students + postdocs so the default is higher than commercial's tighter top-N.
const defaultLimitFor = (accountType: AccountType): number =>
  accountType === 'INSTITUTION' ? 20 : 10;

const composeTarget = (c: CompanyForLookup, args: Args): FinderTarget => {
  const accountType: AccountType = c.accountType ?? 'COMPANY';
  const icpRow = ICP_COMPANIES.find((row) => row.domain === c.domainName);
  let titleKeywords: string[];
  if (args.titles) {
    titleKeywords = args.titles;
  } else if (accountType === 'INSTITUTION') {
    titleKeywords = ACADEMIC_TITLES;
  } else if (icpRow) {
    titleKeywords = [...BUSINESS_TITLES, ...FOUNDER_TITLES, ...icpRow.titleMatchers];
  } else {
    titleKeywords = DEFAULT_TITLES;
  }
  return {
    companyId: c.id,
    name: c.name,
    domain: c.domainName,
    accountType,
    titleKeywords,
    // Custom-field fallbacks — set on the Twenty Company record by Stage 1
    // review, but CLI flags always win.
    ...(args.labUrl ?? c.labPageUrl ? { labUrl: args.labUrl ?? c.labPageUrl } : {}),
    ...(args.piName ?? c.principalInvestigator ? { piName: args.piName ?? c.principalInvestigator } : {}),
  };
};

const resolveTarget = async (args: Args): Promise<FinderTarget> => {
  if (args.companyId) {
    const c = await fetchCompanyById(args.companyId);
    if (!c) throw new Error(`Company id ${args.companyId} not found in Twenty`);
    return composeTarget(c, args);
  }
  if (args.domain) {
    const crmHit = await fetchCompanyByDomain(args.domain);
    if (crmHit) return composeTarget(crmHit, args);
    const icp = ICP_COMPANIES.find((c) => c.domain === args.domain);
    if (icp) {
      return {
        name: icp.name,
        domain: icp.domain,
        accountType: 'COMPANY',
        titleKeywords: args.titles ?? [...BUSINESS_TITLES, ...FOUNDER_TITLES, ...icp.titleMatchers],
        ...(args.labUrl && { labUrl: args.labUrl }),
        ...(args.piName && { piName: args.piName }),
      };
    }
    const inst = INSTITUTION_ALLOWLIST.find((i) => i.domain === args.domain);
    if (inst) {
      return {
        name: inst.name,
        domain: inst.domain,
        accountType: inst.accountType,
        titleKeywords: args.titles ?? ACADEMIC_TITLES,
        // Allowlist may provide curated defaults; CLI flags override.
        ...((args.labUrl ?? inst.defaultLabUrl) && { labUrl: args.labUrl ?? inst.defaultLabUrl }),
        ...((args.piName ?? inst.defaultPi) && { piName: args.piName ?? inst.defaultPi }),
      };
    }
    return {
      name: args.domain,
      domain: args.domain,
      accountType: args.forceInstitution ? 'INSTITUTION' : 'COMPANY',
      titleKeywords: args.titles ?? (args.forceInstitution ? ACADEMIC_TITLES : DEFAULT_TITLES),
      ...(args.labUrl && { labUrl: args.labUrl }),
      ...(args.piName && { piName: args.piName }),
    };
  }
  throw new Error('Provide --company-id <uuid> or --domain <d>');
};

// ─── Balanced selection ───────────────────────────────────────────────
//
// Commercial: cap any one tier at ~50% so the top-N has a mix of buyers,
// founders, and technical champions for A/B-testing what converts.
//
// Academic: explicitly capture broad — at most 1 PI (single decision-maker),
// MASTERS_STUDENT capped at ~20% (short tenure), no caps on POSTDOC /
// PHD_STUDENT / RESEARCH_ENG (Mateo wants all grad + postgrad students).
const balanceCommercial = (cands: Candidate[], limit: number): Candidate[] => {
  const maxPerTier = Math.max(2, Math.ceil(limit / 2));
  const counts = new Map<Tier, number>();
  const picked: Candidate[] = [];
  const overflow: Candidate[] = [];
  for (const c of cands) {
    const tier = classifyTier(c.title, c.defaultTier);
    const n = counts.get(tier) ?? 0;
    if (n < maxPerTier) {
      picked.push(c);
      counts.set(tier, n + 1);
    } else {
      overflow.push(c);
    }
    if (picked.length === limit) break;
  }
  while (picked.length < limit && overflow.length > 0) picked.push(overflow.shift()!);
  return picked;
};

const balanceAcademic = (cands: Candidate[], limit: number): Candidate[] => {
  const mastersMax = Math.max(1, Math.ceil(limit * 0.2));
  let piCount = 0;
  let mastersCount = 0;
  const picked: Candidate[] = [];
  const overflow: Candidate[] = [];
  for (const c of cands) {
    const tier = classifyTier(c.title, c.defaultTier);
    if (tier === 'PI') {
      if (piCount >= 1) {
        overflow.push(c);
        continue;
      }
      piCount += 1;
    } else if (tier === 'MASTERS_STUDENT') {
      if (mastersCount >= mastersMax) {
        overflow.push(c);
        continue;
      }
      mastersCount += 1;
    }
    picked.push(c);
    if (picked.length === limit) break;
  }
  while (picked.length < limit && overflow.length > 0) picked.push(overflow.shift()!);
  return picked;
};

// Program-scoped: the finder already content-gated to robotics people, so
// there's no business-vs-technical mix to balance — just take the top-N by
// score (candidates arrive pre-sorted).
const balanceProgram = (cands: Candidate[], limit: number): Candidate[] => cands.slice(0, limit);

// ─── Orchestrator ─────────────────────────────────────────────────────

type CommitStats = { created: number; skipped: number; errors: number };

export const findContacts = async (
  args: Args,
): Promise<{ candidates: Candidate[]; commit: CommitStats }> => {
  const target = await resolveTarget(args);
  // Program mode overlays robotics keywords onto the (commercial) target so the
  // program finder can gate to the robotics sub-org. --lead / --program-url
  // already landed on piName / labUrl via parseArgs.
  if (args.program) target.programKeywords = args.program;
  const limit = args.limit > 0 ? args.limit : defaultLimitFor(target.accountType);

  console.log(
    `[stage2:contacts] target: ${target.name} (${target.domain}) — ${target.accountType}; limit=${limit}` +
      (args.program ? `; PROGRAM=[${args.program.join(', ')}]` : '') +
      (target.labUrl ? `; ${args.program ? 'program-url' : 'lab-url'}=${target.labUrl}` : '') +
      (target.piName ? `; ${args.program ? 'lead' : 'pi'}="${target.piName}"` : ''),
  );

  // Dispatch: program-scoped (big-company robotics sub-org) > academic > commercial.
  const finderResult: FinderResult = args.program
    ? await findProgramContacts(target, {
        ...(args.skipApollo && { skipApollo: true }),
        ...(args.skipFirecrawl && { skipFirecrawl: true }),
        ...(args.skipExa && { skipExa: true }),
        ...(args.skipS2 && { skipS2: true }),
      })
    : target.accountType === 'INSTITUTION'
      ? await findAcademicContacts(target, {
          ...(args.skipFirecrawl && { skipFirecrawl: true }),
          ...(args.skipS2 && { skipS2: true }),
          ...(args.skipExa && { skipExa: true }),
        })
      : await findCommercialContacts(target, {
          ...(args.skipApollo && { skipApollo: true }),
          ...(args.skipFirecrawl && { skipFirecrawl: true }),
          ...(args.skipExa && { skipExa: true }),
          enrichTopN: limit,
        });

  let cands = finderResult.candidates;
  const stats = finderResult.stats;

  // Agentic role-finder — names leaders the title signal misses (the Olivier
  // fix), seeded by the standardized role list. Commercial + program only
  // (academic discovery is roster/publication-driven, not org-chart). Trusted
  // candidates merge by name into the finder pool, then go through Hunter +
  // scoring like everyone else.
  if (!args.noLeads && target.accountType !== 'INSTITUTION') {
    const leads = await findRoleLeads(target).catch((err) => {
      console.warn(`[stage2:contacts] lead-finder failed: ${err instanceof Error ? err.message : err}`);
      return [];
    });
    if (leads.length > 0) cands = dedupCandidates([...cands, ...leads]);
  }

  // Hunter enrichment on top scorers (universal). Caps at 2× limit to keep
  // credit usage proportional to what we'll actually upsert.
  if (!args.skipHunter && cands.length > 0) {
    cands.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const topForEnrichment = cands.slice(0, Math.min(limit * 2, 30));
    // Academic mode: require strong institution signal to trust Hunter results
    // (blocks fake @utexas.edu fabrications) AND skip Hunter findEmail for
    // OTHER-tier noise candidates (cuts ~30-40% of Hunter spend by not
    // looking up external co-authors we'd never email anyway).
    await enrichWithHunter(topForEnrichment, target.domain, {
      requireInstitutionSignal: target.accountType === 'INSTITUTION',
      skipFindForNoiseOther: target.accountType === 'INSTITUTION',
    });
  }

  // Post-Hunter tier upgrade: candidates demoted to OTHER (typically S2
  // paperCount=1 hits without affiliation data) get restored to their
  // position-inferred tier IF Hunter independently confirmed their email
  // at this domain. Hunter-verified email is a strong "at this institution"
  // signal — it means Hunter actually has them in their .edu database, not
  // just a pattern guess.
  let upgraded = 0;
  for (const c of cands) {
    if (c.defaultTier === 'OTHER' && c.inferredTier && c.sources.has('hunter')) {
      c.defaultTier = c.inferredTier;
      c.rawNotes.push(`Tier upgraded ${c.defaultTier} via Hunter confirmation`);
      upgraded += 1;
    }
  }
  if (upgraded > 0) console.log(`[stage2:contacts] tier-upgraded ${upgraded} via Hunter confirm`);

  // Secondary dedup by email — collapses cases where S2 returns slight name
  // variants ("Soroush" + "Sepehr Nasiriany") that Hunter resolves to the
  // same address.
  const beforeEmailDedup = cands.length;
  cands = dedupByEmail(cands);
  if (cands.length < beforeEmailDedup) {
    console.log(`[stage2:contacts] email-dedup collapsed ${beforeEmailDedup - cands.length} duplicate(s)`);
  }

  // Final score + balanced selection per account type.
  cands.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  cands = args.program
    ? balanceProgram(cands, limit)
    : target.accountType === 'INSTITUTION'
      ? balanceAcademic(cands, limit)
      : balanceCommercial(cands, limit);

  // Email verification gate — final deliverability check on the top-N we'll
  // commit. Only verify emails not already proven VERIFIED by Hunter (covers
  // Apollo-sourced + pattern-guessed addresses); bounded to the committed set.
  if (!args.noVerify) {
    for (const c of cands) {
      if (!c.email || c.emailConfidence === 'VERIFIED') continue;
      const v = await verifyEmail(c.email).catch(() => null);
      // Hunter's verifier is strictly rate-limited (429s under burst); throttle
      // between calls. Bounded set (top-N committed), so this stays short.
      await sleep(600);
      if (!v) continue;
      c.emailVerification = v.status;
      c.emailConfidence = emailConfidenceFrom(v.status, c.emailSourceCount);
      c.rawNotes.push(`Hunter verify: ${v.status} (score=${v.score})`);
    }
  }

  const withEmail = cands.filter((c) => c.email).length;

  // Resolve Twenty Company.id for the upsert step.
  let companyId = target.companyId;
  if (!companyId && !args.dryRun) {
    const company = await upsertCompanyByDomain({
      name: target.name,
      domainName: target.domain,
      accountType: target.accountType,
    });
    companyId = company.id;
  }

  // Persist the lab roster URL + PI onto the Company so Stage 3 (and future
  // Stage 2 runs) can auto-scrape the roster without re-passing CLI flags.
  // Only writes the fields we actually have — never clobbers with blanks.
  if (companyId && !args.dryRun && (target.labUrl || target.piName)) {
    const labFields: Record<string, unknown> = {};
    if (target.labUrl) labFields.labPageUrl = target.labUrl;
    if (target.piName) labFields.principalInvestigator = target.piName;
    await updateCompanyFields(companyId, labFields).catch((err) => {
      console.warn(
        `[stage2:contacts] failed to persist labPageUrl/PI: ${err instanceof Error ? err.message : err}`,
      );
    });
    console.log(
      `[stage2:contacts] persisted to Company: ${Object.keys(labFields).join(', ')}`,
    );
  }

  // Print candidates.
  console.log('');
  console.log('─'.repeat(120));
  console.log(
    `score  role                  name${' '.repeat(18)}title${' '.repeat(24)}email                            conf      srcs`,
  );
  console.log('─'.repeat(135));
  for (const c of cands) {
    const score = scoreCandidate(c);
    const role = classifyRole(c.title);
    const roleLabel = (role.function ? role.label : classifyTier(c.title, c.defaultTier)).padEnd(20).slice(0, 20);
    const name = `${c.firstName} ${c.lastName}`.padEnd(22).slice(0, 22);
    const title = (c.title ?? '').padEnd(28).slice(0, 28);
    const email = (c.email ?? '').padEnd(32).slice(0, 32);
    const conf = (c.emailConfidence ?? '—').padEnd(8).slice(0, 8);
    const srcs = [...c.sources].join(',');
    console.log(`${String(score).padStart(4)}   ${roleLabel}  ${name}  ${title}  ${email}  ${conf}  ${srcs}`);
    if (process.env.STAGE2_DEBUG_NOTES === '1') {
      for (const n of c.rawNotes) console.log(`        | ${n}`);
    }
  }
  console.log('─'.repeat(120));

  const tierBreakdown = new Map<Tier, number>();
  for (const c of cands) {
    const t = classifyTier(c.title, c.defaultTier);
    tierBreakdown.set(t, (tierBreakdown.get(t) ?? 0) + 1);
  }
  const tierStr = [...tierBreakdown.entries()].map(([t, n]) => `${t}=${n}`).join(' ');
  console.log(
    `[stage2:contacts] apollo=${stats.apolloHits} firecrawl=${stats.firecrawlHits} exa=${stats.exaHits} s2=${stats.s2Hits} → dedup=${stats.afterDedup} → top=${cands.length} (email=${withEmail}) | tiers: ${tierStr}`,
  );

  const commit: CommitStats = { created: 0, skipped: 0, errors: 0 };

  if (args.dryRun) {
    console.log('[stage2:contacts] DRY RUN — no CRM writes');
    return { candidates: cands, commit };
  }

  for (const c of cands) {
    if (!c.lastName) {
      commit.skipped += 1;
      continue;
    }
    try {
      const result = await upsertPersonFromDiscovery({
        firstName: c.firstName,
        lastName: c.lastName,
        ...(c.email && { primaryEmail: c.email }),
        ...(c.title && { jobTitle: c.title }),
        ...(c.linkedinUrl && { linkedinUrl: c.linkedinUrl }),
        ...(c.city && { city: c.city }),
        ...(companyId && { companyId }),
        discoverySource: 'ENRICHMENT',
        discoveryRef: [...c.sources].sort().join(','),
      });
      if (result.created) commit.created += 1;
      else commit.skipped += 1;
      // Persist deliverability confidence (covers both created + existing).
      if (c.emailConfidence) {
        await updatePersonFields(result.id, { emailConfidence: c.emailConfidence }).catch((err) => {
          console.warn(
            `[stage2:contacts] emailConfidence write failed for ${result.id}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    } catch (err) {
      console.warn(
        `[stage2:contacts] upsert failed for ${c.firstName} ${c.lastName}:`,
        err instanceof Error ? err.message : err,
      );
      commit.errors += 1;
    }
  }

  console.log(
    `[stage2:contacts] committed: created=${commit.created} skipped=${commit.skipped} errors=${commit.errors}`,
  );

  // Advance the account's Company Kanban stage now that a roster exists
  // (→ CANDIDATES_FOUND, or RESEARCHING if any contact already has research).
  if (companyId) {
    const stage = await recomputeCompanyOutreachStage(companyId).catch((err) => {
      console.warn(
        `[stage2:contacts] outreachStage recompute failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });
    if (stage) console.log(`[stage2:contacts] Company outreachStage → ${stage}`);
  }

  return { candidates: cands, commit };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await findContacts(args);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
