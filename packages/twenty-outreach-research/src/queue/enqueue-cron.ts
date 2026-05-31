// Installs BullMQ repeating jobs for the periodic 3-stage pipeline.
//
// Run once after the worker is up — BullMQ stores repeat configuration in
// Redis, so re-running this script is safe (existing repeats are deduped by
// their `repeat.key` derived from {name, pattern}).
//
// 3-stage cron schedule (2026-05-28 refactor):
//   STAGE 1 — outreach.discover[institutions]   Monday 04:00 UTC (weekly)
//   STAGE 2 — (no cron; per-org on-demand via yarn stage2:contacts)
//   STAGE 3 — outreach.discover[research-pending] every 15min (enqueues
//             researchQueue jobs for every Person at NEEDS_RESEARCH)
//   L6    — outreach.gmail-poll                  every 5min
//   L6    — outreach.reply-watch                 every 15min
//
// The legacy per-source discovery crons (arxiv/apollo/similar) have been
// removed. Those scripts still exist and can be triggered manually via
// `yarn stage2:legacy-{arxiv,apollo,similar,citations,coauthors,github}` for
// targeted batch sweeps.
import 'dotenv/config';

import { discoverQueue, gmailPollQueue, replyWatchQueue } from './queues.js';

const main = async () => {
  console.log('[enqueue:cron] installing 3-stage repeat schedules…');

  // L6 send + reply
  await gmailPollQueue.add('gmail-poll', {}, { repeat: { pattern: '*/5 * * * *' } });
  await replyWatchQueue.add('reply-watch', {}, { repeat: { pattern: '*/15 * * * *' } });

  // Stage 1 — weekly institution scan
  await discoverQueue.add(
    'stage1-institutions',
    { source: 'institutions' },
    { repeat: { pattern: '0 4 * * 1' } },
  );

  // Stage 3 — every-15-min research-pending sweep
  await discoverQueue.add(
    'stage3-research-pending',
    { source: 'research-pending' },
    { repeat: { pattern: '*/15 * * * *' } },
  );

  // Print whatever the queues now have registered so you can verify.
  for (const queue of [gmailPollQueue, replyWatchQueue, discoverQueue]) {
    const schedulers = await queue.getJobSchedulers();
    console.log(`  ${queue.name}: ${schedulers.length} scheduler(s)`);
    for (const s of schedulers) {
      console.log(`    - ${s.id ?? s.name} :: ${s.pattern ?? s.every ?? '?'}`);
    }
  }

  await Promise.all([
    gmailPollQueue.close(),
    replyWatchQueue.close(),
    discoverQueue.close(),
  ]);
};

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
