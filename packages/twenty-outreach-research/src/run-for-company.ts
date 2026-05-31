// Company-level research driver. For a commercial company, research the ORG as
// a whole (one brief + org selling angles), recommend who to reach out to
// (1–2 business + 1–2 technical contacts), deep-research the technical picks
// (full per-person Stage 3), and give business picks a light role-hook.
//
// Labs are NOT run through this — research lab members individually with
// run-for-person.ts instead.
//
// Usage:
//   tsx src/run-for-company.ts --company-id <uuid>
//   tsx src/run-for-company.ts --company-id <uuid> --dry-run   # no writes / no paid deep-research
import 'dotenv/config';
import { printRouterConfig } from './lib/llm-router.js';
import { gatherCompanyInputs } from './research/gather-company-inputs.js';
import { synthesizeBrief } from './research/synthesize-brief.js';
import { brainstormAngles } from './research/brainstorm-angles.js';
import { selectRecommendedContacts, type RecommendedContact } from './contacts/select-recommended.js';
import { writeCompanyResults } from './ingest/write-company-results.js';
import { runForPerson } from './run-for-person.js';
import {
  fetchCompanyWithPeople,
  recomputeCompanyOutreachStage,
} from './lib/twenty-client.js';

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

const label = (c: RecommendedContact): string =>
  `${[c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)'} — ${c.jobTitle ?? '?'} [${c.tier}] ${c.email ? '✉' : '∅'}`;

// Statuses that already carry a research package — don't re-run (waste credits).
const ALREADY_RESEARCHED = new Set(['RESEARCH_DONE', 'DRAFTING', 'DRAFTED', 'APPROVED', 'SENT', 'REPLIED']);

export const runForCompany = async (
  companyId: string,
  opts: { dryRun?: boolean } = {},
): Promise<void> => {
  const company = await fetchCompanyWithPeople(companyId);
  const domain = company.domainName?.primaryLinkUrl ?? undefined;
  console.log(
    `[run-company] ${company.name} (accountType=${company.accountType ?? '?'}, ${company.people.length} people${domain ? ', ' + domain : ''})`,
  );
  if (company.accountType && company.accountType !== 'COMPANY') {
    console.warn(
      `[run-company] NOTE: accountType is ${company.accountType}, not COMPANY. The company flow treats this org as a whole; for academic labs prefer run-for-person per researcher.`,
    );
  }

  const inputs = await gatherCompanyInputs({
    name: company.name ?? 'Unknown',
    ...(domain && { domain }),
    ...(company.labPageUrl && { siteUrl: company.labPageUrl }),
  });

  console.log('[run-company] synthesizing company brief…');
  const brief = await synthesizeBrief(inputs, { subject: 'company' });
  console.log(`[run-company] brief: ${brief.oneLineSummary}`);

  console.log('[run-company] brainstorming org selling angles…');
  const brainstorm = await brainstormAngles(brief, { subject: 'company' });
  console.log(`[run-company] top angle: ${brainstorm.topAngleHeadline}`);

  const picks = selectRecommendedContacts(company.people);
  console.log('[run-company] recommended contacts:');
  console.log('  business:');
  picks.business.forEach((c) => console.log(`    • ${c.outreachRole}: ${label(c)}`));
  console.log('  technical:');
  picks.technical.forEach((c) => console.log(`    • ${c.outreachRole}: ${label(c)}`));

  if (opts.dryRun) {
    console.log('\n[run-company] DRY RUN — no CRM writes, no paid deep-research.');
    console.log(JSON.stringify({ brief, brainstorm, picks }, null, 2));
    return;
  }

  // Deep per-person research on technical picks (skip any already researched).
  for (const c of picks.technical) {
    if (c.researchStatus && ALREADY_RESEARCHED.has(c.researchStatus)) {
      console.log(`[run-company] technical pick ${c.id} already ${c.researchStatus} — skipping deep research`);
      continue;
    }
    console.log(`[run-company] deep research → ${label(c)}`);
    await runForPerson(c.id).catch((err) => {
      console.warn(`[run-company] deep research failed for ${c.id}: ${err instanceof Error ? err.message : err}`);
    });
  }

  await writeCompanyResults({
    companyId,
    companyName: company.name ?? 'Unknown',
    brief,
    brainstorm,
    business: picks.business,
    technical: picks.technical,
  });

  await recomputeCompanyOutreachStage(companyId).catch((err) => {
    console.warn(`[run-company] outreachStage recompute skipped: ${err instanceof Error ? err.message : err}`);
  });

  console.log('[run-company] done.');
};

const main = async () => {
  printRouterConfig();
  const args = parseArgs(process.argv.slice(2));
  const companyId = args.get('company-id');
  if (!companyId) {
    console.error('Usage: tsx src/run-for-company.ts --company-id <uuid> [--dry-run]');
    process.exit(2);
  }
  const dryRun = args.get('dry-run') === 'true';
  await runForCompany(companyId, { dryRun });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
