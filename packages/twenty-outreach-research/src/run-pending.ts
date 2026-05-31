// Batch driver — process every Person in Twenty whose researchStatus is
// NEEDS_RESEARCH. Runs sequentially with per-target failure isolation.
//
// Usage:
//   tsx src/run-pending.ts                # process up to 20 by default
//   tsx src/run-pending.ts --limit 5      # only first N
//   tsx src/run-pending.ts --dry-run      # no CRM writes
import 'dotenv/config';
import { printRouterConfig } from './lib/llm-router.js';
import { findPeopleByResearchStatus } from './lib/twenty-client.js';
import { researchGate } from './qualify/should-research.js';
import { runForPerson } from './run-for-person.js';

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

const main = async () => {
  printRouterConfig();
  const args = parseArgs(process.argv.slice(2));
  const limit = Number.parseInt(args.get('limit') ?? '20', 10);
  const dryRun = args.get('dry-run') === 'true';

  const pending = await findPeopleByResearchStatus('NEEDS_RESEARCH', limit);
  console.log(`[batch] ${pending.length} pending Person(s)`);

  // Research gate — never spend research credits on investors or obvious
  // poor-fit roles. Rule-based only (no API cost); ambiguous contacts always
  // pass through. Run the dedicated qualify pass (src/qualify/qualify-contacts.ts)
  // to additionally clean poor-fit roles out of the CRM entirely.
  const eligible = pending.filter((p) => {
    const gate = researchGate(p);
    if (!gate.research) {
      const name = `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim() || p.id;
      console.log(`[batch] ⤼ skipping: ${name} — ${gate.reason}`);
      return false;
    }
    return true;
  });
  if (eligible.length !== pending.length) {
    console.log(`[batch] ${pending.length - eligible.length} skipped by gate; ${eligible.length} to research`);
  }

  let ok = 0;
  let failed = 0;
  for (const p of eligible) {
    const label = `${p.name?.firstName ?? ''} ${p.name?.lastName ?? ''}`.trim() || p.id;
    console.log(`\n[batch] ▶ ${label} (${p.id})`);
    try {
      await runForPerson(p.id, { dryRun });
      ok++;
    } catch (err) {
      console.error(`[batch] ✗ ${label}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n[batch] done. ok=${ok} failed=${failed}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
