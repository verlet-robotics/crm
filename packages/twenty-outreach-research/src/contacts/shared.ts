// Shared building blocks for both Stage 2 finders.
//
// What lives here:
//   - Concurrency helpers (settled, sleep)
//   - Candidate utilities (normName, candidateKey, merge, splitName)
//   - Source-to-Candidate normalizers (fromApollo, fromTeamMember, fromLinkedIn, fromS2Coauthor)
//   - Title taxonomies (BUSINESS/FOUNDER/TECHNICAL/ACADEMIC) + tier classifier + score
//   - probeTeamPages — path-iterating Firecrawl wrapper (commercial OR academic paths)
//   - enrichWithHunter — universal email pattern enrichment (works for both finders)
import type { ApolloPerson } from '../discover/apollo.js';
import type { TeamMember } from '../research/scrapers/firecrawl.js';

import { findEmail, domainSearch, applyPattern } from './hunter.js';
import type { Candidate, EmailConfidence, SourceTag, Tier } from './types.js';

// Map Hunter's verification status + source count to our tri-state confidence.
// sourceCount>0 = Hunter scraped it off a real page → VERIFIED. A 'valid'
// verifier verdict is also VERIFIED. accept_all/webmail/unknown = RISKY (catch-
// all or non-corporate; may bounce). invalid/disposable or pattern-only = GUESSED.
export const emailConfidenceFrom = (
  verification: Candidate['emailVerification'],
  sourceCount: number | undefined,
): EmailConfidence => {
  if ((sourceCount ?? 0) > 0) return 'VERIFIED';
  if (verification === 'valid') return 'VERIFIED';
  if (verification === 'accept_all' || verification === 'webmail' || verification === 'unknown') return 'RISKY';
  return 'GUESSED';
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const settled = async <T>(label: string, p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    console.warn(`[stage2:contacts] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
};

// ─── Title tiers ──────────────────────────────────────────────────────
//
// Commercial side (data-sales targeting):
// Tier A (buyers): business-side, owns vendor decisions → weight 1.0
// Tier B (founders): at small/Series-A co's the CEO IS the buyer → weight 0.75
// Tier C (champions): technical leads who can advocate internally → weight 0.45

export const BUSINESS_TITLES = [
  'COO',
  'Chief Operating Officer',
  'Head of Partnerships',
  'Director of Partnerships',
  'VP Partnerships',
  'Vice President Partnerships',
  'Vice President of Partnerships',
  'Strategic Partnerships',
  'VP Business Development',
  'Vice President Business Development',
  'Vice President of Business Development',
  'Head of Business Development',
  'Head of BD',
  'Director of Business Development',
  'Head of Data Operations',
  'Director of Operations',
  'VP Operations',
];

export const FOUNDER_TITLES = ['CEO', 'Founder', 'Co-Founder', 'Co-founder', 'Cofounder'];

export const TECHNICAL_TITLES = [
  'Head of AI',
  'Head of Data',
  'Head of ML',
  'VP Engineering',
  'CTO',
  'Director of Research',
  'Robot Learning Lead',
  'Foundation Model',
];

export const DEFAULT_TITLES = [...BUSINESS_TITLES, ...FOUNDER_TITLES, ...TECHNICAL_TITLES];

export const ACADEMIC_TITLES = [
  'Professor',
  'Assistant Professor',
  'Associate Professor',
  'Principal Investigator',
  'Research Scientist',
  'Postdoc',
];

// Academic role-detection keywords. Order matters — earlier entries win on
// overlapping matches (e.g. "Postdoctoral Researcher" must hit POSTDOC before
// any RESEARCH_ENG fallback).
const ACADEMIC_ROLE_RULES: { tier: Tier; weight: number; keywords: string[] }[] = [
  {
    tier: 'PI',
    weight: 1.0,
    keywords: ['professor', 'principal investigator', 'lab director', 'group leader', 'faculty'],
  },
  {
    tier: 'POSTDOC',
    weight: 0.9,
    keywords: ['postdoc', 'postdoctoral', 'post-doc', 'research fellow'],
  },
  {
    tier: 'PHD_STUDENT',
    weight: 0.85,
    keywords: ['phd student', 'phd candidate', 'ph.d.', 'doctoral student', 'doctoral candidate', 'graduate student', 'grad student'],
  },
  {
    tier: 'RESEARCH_ENG',
    weight: 0.75,
    keywords: ['research engineer', 'research scientist', 'staff engineer', 'lab engineer'],
  },
  {
    tier: 'MASTERS_STUDENT',
    weight: 0.5,
    keywords: ['masters student', 'ms student', 'm.s. ', 'msc student'],
  },
  {
    tier: 'LAB_STAFF',
    weight: 0.6,
    keywords: ['lab manager', 'research coordinator', 'administrator', 'lab administrator'],
  },
];

// Commercial tier table. Title-keyword match against current title string.
const COMMERCIAL_TIER_WEIGHTS: { tier: Tier; titles: string[]; weight: number }[] = [
  { tier: 'BUYER', titles: BUSINESS_TITLES, weight: 1.0 },
  { tier: 'FOUNDER', titles: FOUNDER_TITLES, weight: 0.75 },
  { tier: 'ACADEMIC', titles: ACADEMIC_TITLES, weight: 0.85 },
  { tier: 'TECHNICAL', titles: TECHNICAL_TITLES, weight: 0.45 },
];

export const classifyTier = (title: string | undefined, fallback: Tier = 'OTHER'): Tier => {
  if (!title) return fallback;
  const lower = title.toLowerCase();
  // Academic rules first — they're more specific (e.g. "PhD candidate" should
  // hit PHD_STUDENT, not slip past into the commercial table).
  for (const rule of ACADEMIC_ROLE_RULES) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) return rule.tier;
    }
  }
  for (const { tier, titles } of COMMERCIAL_TIER_WEIGHTS) {
    for (const kw of titles) {
      if (lower.includes(kw.toLowerCase())) return tier;
    }
  }
  return fallback;
};

export const tierWeight = (tier: Tier): number => {
  for (const rule of ACADEMIC_ROLE_RULES) {
    if (rule.tier === tier) return rule.weight;
  }
  for (const row of COMMERCIAL_TIER_WEIGHTS) {
    if (row.tier === tier) return row.weight;
  }
  return 0;
};

export const titleMatchScore = (title: string | undefined, defaultTier?: Tier): number => {
  const tier = classifyTier(title, defaultTier ?? 'OTHER');
  return tierWeight(tier);
};

export const scoreCandidate = (c: Candidate): number => {
  const title = titleMatchScore(c.title, c.defaultTier) * 40;
  const email = c.email ? 30 : 0;
  const sourceDiversity = Math.min(c.sources.size, 3) * 6.67;
  const linkedin = c.linkedinUrl ? 10 : 0;
  // Co-authorship frequency bonus — rewards real lab members (who repeatedly
  // co-author with their PI) over one-off external collaborators. Caps at +20
  // so it doesn't completely dominate other signals.
  const coauthorship = Math.min(c.paperCount ?? 0, 5) * 4;
  return Math.round(title + email + sourceDiversity + linkedin + coauthorship);
};

// ─── Candidate utilities ──────────────────────────────────────────────

export const normName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Common nickname → canonical first name, so "Nick Paine" and "Nicholas Paine"
// dedup to one person (different on-file emails defeat email-dedup). Mapped to
// a canonical root; entries chosen so distinct real names don't collide
// (greg→gregory and stephen→steven stay separate, so two different COOs aren't
// merged). Applied only to the first name.
const NICKNAMES: Record<string, string> = {
  nick: 'nicholas', mike: 'michael', mickey: 'michael', bob: 'robert', rob: 'robert', robbie: 'robert',
  bill: 'william', will: 'william', billy: 'william', jim: 'james', jimmy: 'james', tom: 'thomas',
  tommy: 'thomas', dave: 'david', dan: 'daniel', danny: 'daniel', chris: 'christopher', matt: 'matthew',
  joe: 'joseph', joey: 'joseph', tony: 'anthony', alex: 'alexander', sam: 'samuel', sammy: 'samuel',
  ben: 'benjamin', benny: 'benjamin', greg: 'gregory', steve: 'steven', stephen: 'steven',
  andy: 'andrew', drew: 'andrew', ed: 'edward', eddie: 'edward', rick: 'richard', rich: 'richard',
  richie: 'richard', ken: 'kenneth', kenny: 'kenneth', jack: 'john', johnny: 'john', pat: 'patrick',
  nate: 'nathan', gabe: 'gabriel', charlie: 'charles', kate: 'katherine', katie: 'katherine',
  liz: 'elizabeth', beth: 'elizabeth', abby: 'abigail', josh: 'joshua', zach: 'zachary',
};

export const canonicalFirstName = (first: string): string => {
  const n = normName(first);
  return NICKNAMES[n] ?? n;
};

export const candidateKey = (c: Pick<Candidate, 'firstName' | 'lastName'>): string =>
  `${canonicalFirstName(c.firstName)} ${normName(c.lastName)}`;

export const merge = (a: Candidate, b: Candidate): Candidate => ({
  ...a,
  title: a.title ?? b.title,
  email: a.email ?? b.email,
  linkedinUrl: a.linkedinUrl ?? b.linkedinUrl,
  city: a.city ?? b.city,
  apolloId: a.apolloId ?? b.apolloId,
  defaultTier: a.defaultTier ?? b.defaultTier,
  paperCount: Math.max(a.paperCount ?? 0, b.paperCount ?? 0) || undefined,
  s2AuthorId: a.s2AuthorId ?? b.s2AuthorId,
  s2Affiliations: a.s2Affiliations ?? b.s2Affiliations,
  inferredTier: a.inferredTier ?? b.inferredTier,
  sources: new Set([...a.sources, ...b.sources]),
  rawNotes: [...a.rawNotes, ...b.rawNotes],
});

export const splitName = (full: string): { firstName: string; lastName: string } | null => {
  const cleaned = full.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  if (parts.length === 1) return null;
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
};

export const dedupCandidates = (raw: Candidate[]): Candidate[] => {
  const merged = new Map<string, Candidate>();
  for (const c of raw) {
    const key = candidateKey(c);
    const existing = merged.get(key);
    merged.set(key, existing ? merge(existing, c) : c);
  }
  return [...merged.values()];
};

// Secondary dedup pass keyed on lowercased email. Run AFTER Hunter enrichment
// to collapse candidates that came in with name variants but resolve to the
// same person (e.g. S2 returns "Soroush Nasiriany" + "Sepehr Nasiriany" as
// separate authors; Hunter finds both map to snasiriany@utexas.edu → merge).
// When merging by email, prefer the candidate with stronger signal:
//   - higher paperCount wins; ties go to first occurrence
//   - keeps the longer firstName (more specific) when paperCounts match
export const dedupByEmail = (cands: Candidate[]): Candidate[] => {
  const byEmail = new Map<string, Candidate>();
  const noEmail: Candidate[] = [];
  for (const c of cands) {
    if (!c.email) {
      noEmail.push(c);
      continue;
    }
    const key = c.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, c);
      continue;
    }
    const winner = pickStrongerCandidate(existing, c);
    const loser = winner === existing ? c : existing;
    byEmail.set(key, mergePreservingName(winner, loser));
  }
  return [...byEmail.values(), ...noEmail];
};

const pickStrongerCandidate = (a: Candidate, b: Candidate): Candidate => {
  const aCount = a.paperCount ?? 0;
  const bCount = b.paperCount ?? 0;
  if (aCount !== bCount) return aCount > bCount ? a : b;
  // Tie on paperCount — prefer the longer first name (more specific spelling).
  if (a.firstName.length !== b.firstName.length) {
    return a.firstName.length > b.firstName.length ? a : b;
  }
  return a;
};

// Like merge() but preserves the winner's firstName/lastName instead of taking
// from a/b in field order. Used by email-based dedup where the "winner" has
// the more reliable name spelling.
const mergePreservingName = (winner: Candidate, loser: Candidate): Candidate => {
  const m = merge(winner, loser);
  m.firstName = winner.firstName;
  m.lastName = winner.lastName;
  return m;
};

// ─── Source-to-Candidate normalizers ──────────────────────────────────

export const fromApollo = (p: ApolloPerson): Candidate | null => {
  if (!p.firstName) return null;
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    ...(p.title && { title: p.title }),
    ...(p.email && { email: p.email }),
    ...(p.linkedinUrl && { linkedinUrl: p.linkedinUrl }),
    ...(p.city && { city: p.city }),
    apolloId: p.id,
    sources: new Set(['apollo' as SourceTag]),
    rawNotes: [`Apollo: ${p.title ?? '?'}`],
  };
};

export const fromTeamMember = (m: TeamMember): Candidate | null => {
  let firstName = m.firstName;
  let lastName = m.lastName;
  if ((!firstName || !lastName) && m.fullName) {
    const split = splitName(m.fullName);
    if (split) ({ firstName, lastName } = split);
  }
  if (!firstName || !lastName) return null;
  return {
    firstName,
    lastName,
    ...(m.title && { title: m.title }),
    ...(m.email && { email: m.email }),
    ...(m.linkedinUrl && { linkedinUrl: m.linkedinUrl }),
    sources: new Set(['firecrawl' as SourceTag]),
    rawNotes: [`Firecrawl team page: ${m.title ?? '?'}`],
  };
};

export const fromLinkedIn = (
  hit: { firstName?: string; lastName?: string; title?: string; url: string; raw: string },
): Candidate | null => {
  if (!hit.firstName || !hit.lastName) return null;
  return {
    firstName: hit.firstName,
    lastName: hit.lastName,
    ...(hit.title && { title: hit.title }),
    linkedinUrl: hit.url,
    sources: new Set(['exa' as SourceTag]),
    rawNotes: [`Exa LinkedIn: ${hit.raw}`],
  };
};

// S2 author from a recent-paper authors list. role is inferred from paper
// position by the caller (first author → PHD_STUDENT, last author → PI,
// middle → POSTDOC). paperHint is a short reference string for rawNotes.
export const fromS2Coauthor = (
  author: { name: string; authorId?: string },
  defaultTier: Tier,
  paperHint: string,
  paperCount = 1,
): Candidate | null => {
  const split = splitName(author.name);
  if (!split) return null;
  // Skip single-letter first names ("J. Sui" — can't use for outreach).
  if (split.firstName.replace(/[.\s]/g, '').length < 2) return null;
  return {
    firstName: split.firstName,
    lastName: split.lastName,
    defaultTier,
    paperCount,
    ...(author.authorId && { s2AuthorId: author.authorId }),
    sources: new Set(['s2' as SourceTag]),
    rawNotes: [`S2 co-author×${paperCount} (${paperHint})`],
  };
};

// ─── Firecrawl team-page probe ────────────────────────────────────────
//
// Iterates a list of common team/member subpaths on a domain. Returns the
// first path that yields any members. Caller passes the appropriate path list
// (COMMERCIAL_TEAM_PATHS or ACADEMIC_TEAM_PATHS) — academic labs use very
// different conventions from commercial sites.

export const COMMERCIAL_TEAM_PATHS = [
  '/team',
  '/about',
  '/people',
  '/company/team',
  '/about-us',
  '/our-team',
];

export const ACADEMIC_TEAM_PATHS = [
  '/people',
  '/members',
  '/team',
  '/group/members',
  '/lab/members',
  '/people/current',
  '/lab/people',
  '/group',
  '/about/people',
];

type TeamPageProbeResult = { members?: TeamMember[] };

export const probeTeamPages = async (
  domain: string,
  override: string | undefined,
  paths: string[],
  extract: (url: string) => Promise<TeamPageProbeResult>,
): Promise<TeamPageProbeResult | null> => {
  if (override) {
    // Override URL was explicitly provided — failures here are loud (likely a
    // credit/billing issue, an extractor bug, or a wrong URL the user typed),
    // so surface them instead of returning null silently.
    try {
      return await extract(override);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[stage2:contacts] team-page extract failed for ${override}: ${msg.slice(0, 300)}`);
      return null;
    }
  }
  // Path-iteration mode — quiet on individual failures (most subpaths 404)
  // but report when nothing worked.
  let lastErr: string | null = null;
  for (const p of paths) {
    try {
      const result = await extract(`https://${domain}${p}`);
      if (result?.members && result.members.length > 0) return result;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (lastErr) {
    console.warn(`[stage2:contacts] team-page probe found nothing on ${domain}; last error: ${lastErr.slice(0, 200)}`);
  }
  return null;
};

// ─── Hunter email enrichment ──────────────────────────────────────────
//
// Universal across both finders. Domain-search first (pattern + verified
// emails), then per-candidate find for anyone still without an email. Skips
// cands that already have email + title to save credits.

// Strong signal the candidate is actually at the target institution. Without
// this, Hunter pattern-guess fabricates emails for external collaborators
// (e.g. S2 returns Ken Goldberg as a one-off co-author → @utexas.edu guess
// even though he's at Berkeley). Requirements (ANY of):
//   - Apollo or Firecrawl source (Apollo confirms employment; Firecrawl roster
//     scrape confirms lab membership)
//   - S2 affiliation cross-ref hit (real S2 affiliations include this institution)
//   - S2 with paperCount >= 2 (multiple co-authorships = likely lab member)
//   - Hunter domain-search verified email already present
const hasInstitutionSignal = (c: Candidate): boolean => {
  if (c.sources.has('apollo') || c.sources.has('firecrawl')) return true;
  // s2Affiliations populated AND non-empty → cross-ref ran and matched.
  if (c.s2Affiliations && c.s2Affiliations.length > 0) return true;
  if (c.sources.has('s2') && (c.paperCount ?? 0) >= 2) return true;
  return false;
};

// First-name agreement check. Both names are normalized to lowercase letters.
// Rules:
//   - Full names must match exactly.
//   - An initialed name ("Y" or "Y.") on either side must match the other's
//     first letter. An initial alone is a weak signal, so we only accept it
//     when one side is clearly using the abbreviated form.
//   - Distinct full names ("Yunzhu" vs "Yandong") → reject.
const firstNamesAgree = (a: string, b: string): boolean => {
  const na = a.toLowerCase().replace(/[^a-z]/g, '');
  const nb = b.toLowerCase().replace(/[^a-z]/g, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Either side a bare initial → letter-match check.
  if (na.length === 1 || nb.length === 1) return na[0] === nb[0];
  return false;
};

// Does the email's local part look like it actually belongs to this person?
// Hunter returns score=99 for ANY pattern-derivable address ("ed@utexas.edu"
// for "Edward Adelson") even when no such person exists at the domain. The
// distinguishing signal is whether the local part contains a meaningful
// chunk of the person's actual name.
//
// Heuristic: local part must contain a substring of >=4 chars from EITHER
// the candidate's firstName OR lastName. Names shorter than 4 chars (Zhu,
// Li, Wu) can't be validated this way — fall back to checking that the
// local part contains the full name, and require local part >=5 chars to
// reject pure-initial guesses ("y.li", "x.li").
const emailMatchesName = (email: string, firstName: string, lastName: string): boolean => {
  const local = email.split('@')[0].toLowerCase();
  const first = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const last = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (local.length < 5) return false; // "ed", "ken", "y.li" — too short to be specific.
  // First character of local part must match firstName or lastName initial.
  // Catches "eprather" for "Aaron Prather" (Hunter found an unrelated E. Prather
  // at the domain) — "e" doesn't match "a" or "p".
  if (local[0] !== first[0] && local[0] !== last[0]) return false;
  const firstSlice = first.slice(0, Math.min(first.length, 6));
  const lastSlice = last.slice(0, Math.min(last.length, 6));
  if (firstSlice.length >= 4 && local.includes(firstSlice)) return true;
  if (lastSlice.length >= 4 && local.includes(lastSlice)) return true;
  // Both name parts short (e.g. "Yuke Zhu" — Yuke=4, Zhu=3). Accept when
  // local contains BOTH first (>=3) AND last (>=2) substrings.
  if (first.length >= 3 && last.length >= 2 && local.includes(first) && local.includes(last.slice(0, 1))) return true;
  return false;
};

type HunterEnrichOptions = {
  // When true, all Hunter results (find AND pattern guess) require
  // hasInstitutionSignal to be true. Use for academic mode where Hunter
  // findEmail returns score 99 for any pattern-derivable address — including
  // emails of completely unrelated external academics who happen to share a
  // name with someone at the domain.
  requireInstitutionSignal?: boolean;
  // When true, skip Hunter findEmail for candidates already tiered OTHER
  // with no inferredTier (no chance of tier upgrade) — saves ~30-40% of
  // Hunter lookups in academic mode where many S2 co-authors are external
  // collaborators we won't reach out to anyway. Candidates with inferredTier
  // (demoted from a real position by strict paperCount gate) still get
  // Hunter so they can be tier-upgraded back if confirmed.
  skipFindForNoiseOther?: boolean;
};

export const enrichWithHunter = async (
  cands: Candidate[],
  domain: string,
  opts: HunterEnrichOptions = {},
): Promise<void> => {
  let pattern: string | null = null;
  try {
    const result = await domainSearch(domain);
    pattern = result.pattern;
    const byName = new Map<string, { email: string; position?: string; firstName: string; lastName: string; confidence: number }>();
    for (const p of result.people) {
      if (p.firstName && p.lastName && p.email) {
        byName.set(candidateKey({ firstName: p.firstName, lastName: p.lastName }), {
          email: p.email,
          firstName: p.firstName,
          lastName: p.lastName,
          confidence: p.confidence,
          ...(p.position && { position: p.position }),
        });
      }
    }
    for (const c of cands) {
      const hit = byName.get(candidateKey(c));
      if (!hit) continue;
      // False-positive guard: Hunter's domain-search returns whoever's at this
      // domain with the same normalized name. If we're tracking "Yunzhu Li" at
      // Columbia and Hunter has some "Y. Li" at UT — the normalized keys both
      // become "y li" and we'd fake-confirm. Require strict first-name match
      // when both sides have a full first name; only allow initial-match when
      // one side is clearly an initial too.
      if (!firstNamesAgree(c.firstName, hit.firstName)) {
        c.rawNotes.push(`Hunter name-mismatch skipped: ${hit.firstName} ${hit.lastName} != ${c.firstName} ${c.lastName}`);
        continue;
      }
      if (!c.email) {
        c.email = hit.email;
        c.sources.add('hunter');
        c.rawNotes.push(`Hunter domain-search match: ${hit.email}`);
        // Domain-search emails are real DB records → confidence from Hunter's
        // own confidence score.
        c.emailConfidence = hit.confidence >= 70 ? 'VERIFIED' : 'RISKY';
      }
      if (!c.title && hit.position) {
        c.title = hit.position;
        c.rawNotes.push(`Hunter title: ${hit.position}`);
      }
    }
  } catch (err) {
    console.warn('[stage2:contacts] hunter domain-search failed:', err instanceof Error ? err.message : err);
  }
  let skipped = 0;
  for (const c of cands) {
    if (c.email && c.title) continue;
    // No last name → can't query Hunter (findEmail 400s) and can't form a
    // sensible pattern guess. Common for Apollo people-search hits whose
    // last_name wasn't unlocked by enrichment. Nothing to do here.
    if (!c.lastName) continue;
    // Skip findEmail for OTHER-tier noise without upgrade potential — these
    // are external co-authors we'd never email; spending a Hunter credit on
    // them is wasted. Domain-search Map already ran and would have caught
    // them if Hunter had a real record.
    if (
      opts.skipFindForNoiseOther &&
      !c.email &&
      c.defaultTier === 'OTHER' &&
      !c.inferredTier &&
      !c.sources.has('apollo') &&
      !c.sources.has('firecrawl')
    ) {
      skipped += 1;
      continue;
    }
    try {
      const found = await findEmail(c.firstName, c.lastName, domain);
      if (found && !c.title && found.position) {
        c.title = found.position;
        c.rawNotes.push(`Hunter title: ${found.position}`);
      }
      if (c.email) {
        await sleep(250);
        continue;
      }
      // Hunter findEmail returns score=99 for any pattern-derivable address
      // even when no real person exists at the domain. The distinguishing
      // signal is the EMAIL'S STRUCTURE: real Hunter DB hits contain a
      // meaningful chunk of the person's name (yukez@, huihanl@, snasiriany@);
      // pure pattern guesses are generic (ed@, ken@, y.li@).
      //
      // Academic mode requires emailMatchesName for findEmail acceptance.
      // Commercial mode trusts Hunter score (Apollo provides the institution
      // signal upstream).
      const findFirstNameOk = !!found?.firstName && firstNamesAgree(c.firstName, found.firstName);
      const emailLooksReal = !!found?.email && emailMatchesName(found.email, c.firstName, c.lastName);
      const findGateOk = opts.requireInstitutionSignal
        ? findFirstNameOk && (emailLooksReal || hasInstitutionSignal(c))
        : findFirstNameOk;
      if (found && found.score >= 50 && findGateOk) {
        c.email = found.email;
        c.sources.add('hunter');
        if (found.verification) c.emailVerification = found.verification;
        c.emailSourceCount = found.sourceCount;
        c.emailConfidence = emailConfidenceFrom(found.verification, found.sourceCount);
        c.rawNotes.push(
          `Hunter find (score=${found.score}, sources=${found.sourceCount}, verify=${found.verification ?? '?'}): ${found.email}`,
        );
      } else if (found) {
        const reasons: string[] = [];
        if (!findFirstNameOk) reasons.push(found.firstName ? `name=${found.firstName} ${found.lastName ?? ''}` : 'no firstName');
        if (opts.requireInstitutionSignal && !emailLooksReal && !hasInstitutionSignal(c)) {
          reasons.push('email shape unlikely real');
        }
        c.rawNotes.push(
          `Hunter find skipped — ${reasons.join('; ')}; score=${found.score}, email=${found.email}`,
        );
      }
      // Pattern-guess fallback — only when candidate has strong "at this
      // institution" signal (Apollo/Firecrawl/S2-affiliation/S2-paperCount>=2).
      if (!c.email && pattern && hasInstitutionSignal(c)) {
        // Pattern guess only when we have a strong signal this person is
        // actually at this institution. Without this gate, S2-discovered
        // external co-authors get fake @institution.edu emails fabricated.
        const guess = applyPattern(pattern, c.firstName, c.lastName, domain);
        c.email = guess;
        c.emailSourceCount = 0;
        c.emailConfidence = 'GUESSED';
        c.rawNotes.push(`Hunter pattern guess (${pattern}): ${guess}`);
      }
    } catch (err) {
      console.warn(
        `[stage2:contacts] hunter find failed for ${c.firstName} ${c.lastName}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await sleep(250);
  }
  if (skipped > 0) console.log(`[stage2:contacts] hunter findEmail skipped ${skipped} noise-OTHER candidates`);
};
