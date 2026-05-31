// Qualification pass — classify every Person in the CRM against the
// academic-lenient / company-strict fit bar, and (optionally) soft-delete the
// poor-fit ones so the paid research pipeline never runs on them.
//
// SAFE BY DEFAULT: a plain run is a dry run that prints exactly who would be
// cut and why. Deletion only happens with --delete, only soft-deletes
// (recoverable in Twenty's deleted-records view), and ONLY ever touches
// contacts still at NEEDS_RESEARCH / untouched — anyone already further along
// the pipeline (RESEARCHING…REPLIED, or manually SKIPPED) is never deleted.
//
// Usage:
//   tsx src/qualify/qualify-contacts.ts                 # dry run — report only
//   tsx src/qualify/qualify-contacts.ts --llm           # dry run + LLM tie-break on ambiguous
//   tsx src/qualify/qualify-contacts.ts --delete         # soft-delete poor-fit contacts
//   tsx src/qualify/qualify-contacts.ts --delete --llm   # both
//   tsx src/qualify/qualify-contacts.ts --limit 50       # cap how many deletes to perform
import 'dotenv/config';
import {
  deletePerson,
  listAllPeopleForQualification,
  type PersonForQualification,
} from '../lib/twenty-client.js';
import { classifyFitWithLlm } from './classify-fit-llm.js';
import type { FitVerdict } from './classify-fit.js';

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

// Only fresh / untouched contacts are eligible for deletion. Anyone already in
// the outreach flow is off-limits regardless of fit.
const isDeletable = (status?: string | null): boolean =>
  !status || status === 'NEEDS_RESEARCH';

const label = (p: PersonForQualification): string =>
  `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim() || p.id;

type Scored = { person: PersonForQualification; verdict: FitVerdict };

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.get('delete') === 'true';
  const useLlm = args.get('llm') === 'true';
  const limit = args.has('limit') ? Number.parseInt(args.get('limit')!, 10) : Infinity;

  console.log(`[qualify] mode: ${apply ? 'DELETE (soft)' : 'DRY RUN'}${useLlm ? ' + LLM tie-break' : ''}`);
  const people = await listAllPeopleForQualification();
  console.log(`[qualify] fetched ${people.length} People from CRM\n`);

  const scored: Scored[] = [];
  for (const person of people) {
    const verdict = await classifyFitWithLlm(
      {
        jobTitle: person.jobTitle,
        companyName: person.company?.name,
        accountType: person.company?.accountType,
      },
      { useLlm },
    );
    scored.push({ person, verdict });
  }

  const keep = scored.filter((s) => s.verdict.decision === 'keep');
  const review = scored.filter((s) => s.verdict.decision === 'review');
  const flaggedDelete = scored.filter((s) => s.verdict.decision === 'delete');
  // Split the delete bucket by whether the contact is actually eligible.
  const toDelete = flaggedDelete.filter((s) => isDeletable(s.person.researchStatus));
  const protectedFromDelete = flaggedDelete.filter((s) => !isDeletable(s.person.researchStatus));

  const fmt = (s: Scored) =>
    `   • ${label(s.person).padEnd(28)} ${(s.person.jobTitle ?? '—').padEnd(34)} @ ${
      s.person.company?.name ?? '—'
    }  — ${s.verdict.reason}`;

  console.log(`── POOR FIT → DELETE (${toDelete.length}) ─────────────────────────────`);
  toDelete.forEach((s) => console.log(fmt(s)));

  if (protectedFromDelete.length > 0) {
    console.log(
      `\n── POOR FIT but PROTECTED — already in pipeline, left alone (${protectedFromDelete.length}) ──`,
    );
    protectedFromDelete.forEach((s) =>
      console.log(`${fmt(s)}   [status=${s.person.researchStatus}]`),
    );
  }

  console.log(`\n── UNCERTAIN → kept, review manually (${review.length}) ───────────`);
  review.forEach((s) => console.log(fmt(s)));

  // Keep summary by tier (don't dump every qualified row — just the counts).
  const keepByTier = keep.reduce<Record<string, number>>((acc, s) => {
    acc[s.verdict.tier] = (acc[s.verdict.tier] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n── QUALIFIED → kept (${keep.length}) ──────────────────────────────`);
  Object.entries(keepByTier).forEach(([tier, n]) => console.log(`   ${tier.padEnd(22)} ${n}`));

  console.log(
    `\n[qualify] summary: keep=${keep.length} review=${review.length} delete=${toDelete.length} protected=${protectedFromDelete.length} total=${people.length}`,
  );

  if (!apply) {
    console.log(`\n[qualify] DRY RUN — no records changed. Re-run with --delete to soft-delete the ${toDelete.length} poor-fit contact(s).`);
    return;
  }

  const targets = toDelete.slice(0, Number.isFinite(limit) ? limit : toDelete.length);
  console.log(`\n[qualify] soft-deleting ${targets.length} contact(s)…`);
  let ok = 0;
  let failed = 0;
  for (const s of targets) {
    try {
      await deletePerson(s.person.id);
      ok++;
      console.log(`   ✓ deleted ${label(s.person)}`);
    } catch (err) {
      failed++;
      console.error(`   ✗ ${label(s.person)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n[qualify] done. deleted=${ok} failed=${failed}. (Recoverable in Twenty's deleted-records view.)`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
