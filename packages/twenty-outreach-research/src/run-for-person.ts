// End-to-end pipeline driver: pull a Person from Twenty, run gather → synth →
// brainstorm, write the brief + selling-angles back to the CRM.
//
// Usage:
//   tsx src/run-for-person.ts --person-id <uuid>
//   tsx src/run-for-person.ts --person-id <uuid> --dry-run    # no CRM writes
import 'dotenv/config';
import { printRouterConfig } from './lib/llm-router.js';
import { gatherInputs } from './research/gather-inputs.js';
import { synthesizeBrief } from './research/synthesize-brief.js';
import { brainstormAngles } from './research/brainstorm-angles.js';
import { loadTarget } from './ingest/load-target.js';
import { writeResultsToCRM } from './ingest/write-results.js';
import { updatePersonFields } from './lib/twenty-client.js';

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

export const runForPerson = async (
  personId: string,
  opts: { dryRun?: boolean } = {},
): Promise<void> => {
  const { person, spec } = await loadTarget(personId);
  console.log(`[run] target: ${spec.name} @ ${spec.affiliation} (role=${spec.role})`);

  if (!opts.dryRun) {
    await updatePersonFields(personId, { researchStatus: 'RESEARCHING' });
  }

  try {
    const inputs = await gatherInputs(spec);

    console.log('[run] L2 synthesizing brief…');
    const brief = await synthesizeBrief(inputs);
    if (!opts.dryRun) {
      await updatePersonFields(personId, { researchStatus: 'RESEARCH_DONE' });
    }
    console.log(`[run] brief: ${brief.oneLineSummary}`);

    console.log('[run] L3 brainstorming selling angles…');
    if (!opts.dryRun) {
      await updatePersonFields(personId, { researchStatus: 'DRAFTING' });
    }
    const brainstorm = await brainstormAngles(brief);
    console.log(`[run] top angle: ${brainstorm.topAngleHeadline}`);
    console.log(
      `[run] ${brainstorm.angles.length} angles, ${brainstorm.openerIdeas.length} opener ideas, ${brainstorm.avoid.length} anti-angles`,
    );

    if (opts.dryRun) {
      console.log('[run] DRY RUN — skipping CRM writes. Brief + brainstorm:');
      console.log(JSON.stringify({ brief, brainstorm }, null, 2));
      return;
    }

    await writeResultsToCRM({
      personId,
      ...(person.company?.id && { companyId: person.company.id }),
      ...(person.name?.firstName && { firstName: person.name.firstName }),
      brief,
      brainstorm,
    });
  } catch (err) {
    console.error(`[run] FAILED for ${personId}:`, err);
    if (!opts.dryRun) {
      await updatePersonFields(personId, { researchStatus: 'NEEDS_RESEARCH' }).catch(() => {});
    }
    throw err;
  }
};

const main = async () => {
  printRouterConfig();
  const args = parseArgs(process.argv.slice(2));
  const personId = args.get('person-id');
  if (!personId) {
    console.error('Usage: tsx src/run-for-person.ts --person-id <uuid> [--dry-run]');
    process.exit(2);
  }
  const dryRun = args.get('dry-run') === 'true';
  await runForPerson(personId, { dryRun });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
