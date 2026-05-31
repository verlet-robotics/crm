// Polls Twenty for People with researchStatus=APPROVED and creates a Gmail
// draft for each. Designed to run as a cron (every 5 min) or be invoked
// directly by BullMQ.
//
// Twenty webhooks would be more elegant, but the outreach package runs as a
// standalone tsx process and the polling cadence is fine for outreach volume.
import 'dotenv/config';

import { findPeopleByResearchStatus } from '../lib/twenty-client.js';

import { createGmailDraftForPerson } from './gmail-draft.js';

export const gmailPollOnce = async (
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<{ processed: number; created: number; errors: number }> => {
  const approved = await findPeopleByResearchStatus('APPROVED', opts.limit ?? 20);
  console.log(`[gmail-poll] ${approved.length} APPROVED People`);

  let created = 0;
  let errors = 0;
  for (const person of approved) {
    try {
      const result = await createGmailDraftForPerson(person.id, opts);
      if (result.status === 'created') created += 1;
    } catch (err) {
      console.error(`[gmail-poll] ${person.id} failed:`, err);
      errors += 1;
    }
  }
  return { processed: approved.length, created, errors };
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await gmailPollOnce({ dryRun });
  console.log('[gmail-poll] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
