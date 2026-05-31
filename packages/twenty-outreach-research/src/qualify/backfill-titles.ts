// Title backfill — fill missing Person.jobTitle so the fit classifier can
// actually judge contacts (most migrated rows have no title). Two segments,
// dispatched by Company.accountType:
//   • Commercial (COMPANY / MISC / no type): Apollo /people/match by
//     name + employer domain → title. Hunter email-finder `position` as a
//     free-ish fallback.
//   • Academic (LAB / INSTITUTION): Exa web search ("<name> <org>") + a free
//     NIM extractor that pulls a title ONLY when one is explicitly stated in
//     the snippets (grounded — no guessing).
// Investors are skipped entirely (the research gate already drops them).
//
// CREDIT SAFETY: a plain run is SCOPE mode — it lists targets + estimated
// credit cost and makes NO API calls. `--apply` performs the lookups + writes.
// jobTitle is only written when found AND currently empty (never clobbered).
//
// Usage:
//   tsx src/qualify/backfill-titles.ts                    # scope only, no API calls
//   tsx src/qualify/backfill-titles.ts --apply             # query + write titles
//   tsx src/qualify/backfill-titles.ts --apply --segment commercial
//   tsx src/qualify/backfill-titles.ts --apply --no-hunter --limit 10
import 'dotenv/config';
import { matchPersonByName } from '../discover/apollo.js';
import { findEmail } from '../contacts/hunter.js';
import { callJson } from '../lib/llm-router.js';
import { z } from 'zod';
import {
  listAllPeopleForQualification,
  updatePersonFields,
  type PersonForQualification,
} from '../lib/twenty-client.js';
import { classifyFit } from './classify-fit.js';

const parseArgs = (argv: string[]) => {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].replace(/^--/, '');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        m.set(k, next);
        i++;
      } else {
        m.set(k, 'true');
      }
    }
  }
  return m;
};

const isAcademic = (accountType?: string | null): boolean =>
  accountType === 'LAB' || accountType === 'INSTITUTION';
const isInvestor = (accountType?: string | null): boolean => accountType === 'INVESTOR';

// Strip protocol / path / www / port down to a bare domain Apollo accepts.
const bareDomain = (raw?: string | null): string => {
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .replace(/:\d+$/, '')
    .toLowerCase()
    .trim();
};

const label = (p: PersonForQualification): string =>
  `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim() || p.id;

// A returned title is only trusted if it actually looks like a role — guards
// against the academic extractor echoing a stray phrase from a snippet.
const LOOKS_LIKE_TITLE =
  /professor|\bprof\b|faculty|lecturer|postdoc|\bph\.?\s?d\b|doctoral|student|research(er| scientist| fellow| engineer| associate| assistant)?|scientist|\bdirector\b|\bvp\b|\bhead\b|founder|chief|\bc[etfoi]o\b|manager|engineer|scholar|principal investigator|\bpi\b/i;

const titleSchema = z.object({
  title: z.string(),
  confidence: z.enum(['high', 'low']),
});

// Academic title via Exa snippets + grounded NIM extraction. Returns '' when no
// title is clearly stated. Imported lazily so a missing EXA key only errors in
// --apply academic runs, not at module load.
const academicTitle = async (person: PersonForQualification): Promise<string> => {
  const { searchNews } = await import('../research/scrapers/exa.js');
  const name = label(person);
  const org = person.company?.name ?? '';
  // searchNews fans a neural query "<name> <affiliation> robotics manipulation"
  // with text snippets — good enough to surface a bio line stating the title.
  const hits = await searchNews(name, org, 1095).catch(() => []);
  const snippets = hits
    .map((h) => `${h.title}. ${h.summary}`)
    .join('\n')
    .slice(0, 4000);
  if (!snippets.trim()) return '';

  const prompt = `From the web snippets below, extract the CURRENT primary academic/professional title of ${name}${
    org ? ` (affiliated with ${org})` : ''
  }. Examples of valid titles: "Professor", "Assistant Professor", "Associate Professor", "PhD Student", "Postdoctoral Researcher", "Research Scientist", "Lab Director". Return the title ONLY if it is explicitly stated in the snippets. If no clear title is stated, return an empty string. Set confidence to "high" only when a snippet plainly states the title for this exact person.

Snippets:
${snippets}`;

  try {
    const out = await callJson('extractor', prompt, titleSchema);
    const title = out.title.trim();
    if (!title || out.confidence !== 'high') return '';
    // Grounding guards: must look like a role AND appear in the snippet text.
    if (!LOOKS_LIKE_TITLE.test(title)) return '';
    if (!snippets.toLowerCase().includes(title.toLowerCase().split(/\s+/)[0])) return '';
    return title;
  } catch {
    return '';
  }
};

// Commercial title via Apollo match, then Hunter position fallback.
const commercialTitle = async (
  person: PersonForQualification,
  domain: string,
  opts: { useHunter: boolean },
): Promise<{ title: string; source: string }> => {
  const first = person.name?.firstName ?? '';
  const last = person.name?.lastName ?? '';
  if (!first || !last) return { title: '', source: '' };

  const apollo = await matchPersonByName(first, last, domain).catch(() => null);
  if (apollo?.title?.trim()) return { title: apollo.title.trim(), source: 'apollo' };

  if (opts.useHunter) {
    const hunter = await findEmail(first, last, domain).catch(() => null);
    if (hunter?.position?.trim()) return { title: hunter.position.trim(), source: 'hunter' };
  }
  return { title: '', source: '' };
};

type Target = {
  person: PersonForQualification;
  segment: 'commercial' | 'academic' | 'skip';
  domain: string;
  skipReason?: string;
};

const triage = (p: PersonForQualification): Target => {
  const accountType = p.company?.accountType;
  const domain = bareDomain(p.company?.domainName?.primaryLinkUrl);
  if (isInvestor(accountType)) return { person: p, segment: 'skip', domain, skipReason: 'investor' };
  if (isAcademic(accountType)) {
    if (!p.company?.name) return { person: p, segment: 'skip', domain, skipReason: 'academic, no org name' };
    return { person: p, segment: 'academic', domain };
  }
  // Commercial — needs a domain to match on.
  if (!domain) return { person: p, segment: 'skip', domain, skipReason: 'no company domain' };
  return { person: p, segment: 'commercial', domain };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.get('apply') === 'true';
  const segmentFilter = args.get('segment'); // commercial | academic | undefined(all)
  const useHunter = args.get('no-hunter') !== 'true';
  const useApollo = args.get('no-apollo') !== 'true';
  const useExa = args.get('no-exa') !== 'true';
  const limit = args.has('limit') ? Number.parseInt(args.get('limit')!, 10) : Infinity;

  const people = await listAllPeopleForQualification();
  const untitled = people.filter((p) => !p.jobTitle || !p.jobTitle.trim());

  let targets = untitled.map(triage);
  if (segmentFilter === 'commercial') targets = targets.map((t) => (t.segment === 'academic' ? { ...t, segment: 'skip', skipReason: 'segment=commercial' } : t));
  if (segmentFilter === 'academic') targets = targets.map((t) => (t.segment === 'commercial' ? { ...t, segment: 'skip', skipReason: 'segment=academic' } : t));

  const commercial = targets.filter((t) => t.segment === 'commercial');
  const academic = targets.filter((t) => t.segment === 'academic');
  const skipped = targets.filter((t) => t.segment === 'skip');

  console.log(`[backfill-titles] ${untitled.length} untitled People — commercial=${commercial.length} academic=${academic.length} skip=${skipped.length}`);
  console.log(`[backfill-titles] mode: ${apply ? 'APPLY (spends credits)' : 'SCOPE (no API calls)'}`);

  if (!apply) {
    console.log(`\n── Commercial → Apollo match (${commercial.length}) ────────────────`);
    commercial.slice(0, 200).forEach((t) => console.log(`   • ${label(t.person).padEnd(26)} @ ${t.person.company?.name ?? '—'}  [${t.domain}]`));
    console.log(`\n── Academic → Exa + NIM extract (${academic.length}) ───────────────`);
    academic.slice(0, 200).forEach((t) => console.log(`   • ${label(t.person).padEnd(26)} @ ${t.person.company?.name ?? '—'}`));
    const skipReasons = skipped.reduce<Record<string, number>>((a, t) => { a[t.skipReason ?? '?'] = (a[t.skipReason ?? '?'] ?? 0) + 1; return a; }, {});
    console.log(`\n── Skipped (${skipped.length}) ──`, skipReasons);
    console.log(
      `\n[backfill-titles] estimated cost on --apply: ~${commercial.length} Apollo credits${useHunter ? ` (+ up to ${commercial.length} Hunter lookups for Apollo misses)` : ''} + ~${academic.length} Exa searches + NIM calls.`,
    );
    console.log('[backfill-titles] SCOPE only — nothing queried or written. Re-run with --apply to execute.');
    return;
  }

  const work = [...commercial, ...academic].slice(0, Number.isFinite(limit) ? limit : undefined);
  let found = 0;
  let written = 0;
  const wouldDelete: string[] = [];

  for (const t of work) {
    let title = '';
    let source = '';
    if (t.segment === 'commercial' && useApollo) {
      const r = await commercialTitle(t.person, t.domain, { useHunter });
      title = r.title;
      source = r.source;
    } else if (t.segment === 'academic' && useExa) {
      title = await academicTitle(t.person);
      source = title ? 'exa+nim' : '';
    }

    if (!title) {
      console.log(`   – ${label(t.person).padEnd(26)} no title found`);
      continue;
    }
    found++;

    // Show the downstream fit effect (report-only — no deletion here).
    const verdict = classifyFit({
      jobTitle: title,
      companyName: t.person.company?.name,
      accountType: t.person.company?.accountType,
    });
    const flag = verdict.decision === 'delete' ? '  ⚠ now flagged poor-fit' : '';
    if (verdict.decision === 'delete') wouldDelete.push(`${label(t.person)} — "${title}" (${verdict.reason})`);
    console.log(`   ✓ ${label(t.person).padEnd(26)} "${title}" [${source}] → ${verdict.decision}${flag}`);

    try {
      await updatePersonFields(t.person.id, { jobTitle: title });
      written++;
    } catch (err) {
      console.error(`     ✗ write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n[backfill-titles] done. processed=${work.length} found=${found} written=${written}`);
  if (wouldDelete.length > 0) {
    console.log(`\n[backfill-titles] ${wouldDelete.length} newly-titled contact(s) the fit bar would now drop — NOT deleted. Run qualify-contacts to review:`);
    wouldDelete.forEach((s) => console.log(`   • ${s}`));
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
