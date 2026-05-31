// Bulk-enqueue research jobs from the current backlog of NEEDS_RESEARCH People.
// Run on demand or wire into a cron via enqueue-cron.ts.
import 'dotenv/config';

import { findPeopleByResearchStatus } from '../lib/twenty-client.js';
import { researchGate } from '../qualify/should-research.js';

import { researchQueue } from './queues.js';

const main = async () => {
  const all = await findPeopleByResearchStatus('NEEDS_RESEARCH', 100);
  // Gate out investors + poor-fit roles before queuing — no point spending
  // research credits on contacts run-pending would skip anyway.
  const people = all.filter((person) => {
    const gate = researchGate(person);
    if (!gate.research) {
      const name = `${person.name?.firstName ?? ''} ${person.name?.lastName ?? ''}`.trim() || person.id;
      console.log(`[enqueue:research] ⤼ skipping: ${name} — ${gate.reason}`);
    }
    return gate.research;
  });
  console.log(
    `[enqueue:research] ${all.length} NEEDS_RESEARCH; ${people.length} pass the gate (${all.length - people.length} skipped)`,
  );

  for (const person of people) {
    await researchQueue.add(
      'research',
      { personId: person.id },
      // jobId = personId guarantees we don't double-queue the same row.
      { jobId: person.id },
    );
  }
  console.log(`[enqueue:research] enqueued ${people.length} jobs`);
  await researchQueue.close();
};

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
