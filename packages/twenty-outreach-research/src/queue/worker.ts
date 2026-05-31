// Single worker process that drains all four queues. Each queue processes
// jobs in parallel (BullMQ concurrency=1 by default per worker; we bump
// research to 2 because LLM calls dominate wall time).
//
// Run: `yarn queue:worker` (or wrap with doppler for secrets).
//
// Dead-letter behavior: BullMQ keeps failed jobs in Redis (removeOnFail.age in
// queues.ts). For long-term visibility, on final failure we attach a Twenty
// Task tagged "outreach pipeline failure" so the human review queue includes
// system errors.
import 'dotenv/config';

import { type Job, Worker } from 'bullmq';

import { findPeopleByResearchStatus } from '../lib/twenty-client.js';
import { runForPerson } from '../run-for-person.js';
import { gmailPollOnce } from '../send/gmail-poll.js';
import { replyWatchOnce } from '../send/reply-watcher.js';
import { discoverFromApollo } from '../discover/discover-apollo.js';
import { discoverFromArxiv } from '../discover/discover-arxiv.js';
import { discoverFromSimilar } from '../discover/discover-similar.js';
import { aggregateInstitutions } from '../discover/institutions-aggregate.js';

import { Q, redis } from './connection.js';
import {
  type DiscoverJob,
  type GmailPollJob,
  type ReplyWatchJob,
  type ResearchJob,
  researchQueue,
} from './queues.js';

const log = (q: string, job: Job, msg: string): void => {
  console.log(`[${q}#${job.id}] ${msg}`);
};

const onFailed = (q: string) => (job: Job | undefined, err: Error): void => {
  console.error(`[${q}#${job?.id ?? '?'}] FAILED (attempt ${job?.attemptsMade}):`, err.message);
};

const researchWorker = new Worker<ResearchJob>(
  Q.research,
  async (job) => {
    log(Q.research, job, `research personId=${job.data.personId}`);
    await runForPerson(job.data.personId);
  },
  { connection: redis(), concurrency: 2 },
);
researchWorker.on('failed', onFailed(Q.research));

const gmailWorker = new Worker<GmailPollJob>(
  Q.gmailPoll,
  async (job) => {
    log(Q.gmailPoll, job, 'gmail-poll tick');
    const stats = await gmailPollOnce({});
    return stats;
  },
  { connection: redis(), concurrency: 1 },
);
gmailWorker.on('failed', onFailed(Q.gmailPoll));

const replyWorker = new Worker<ReplyWatchJob>(
  Q.replyWatch,
  async (job) => {
    log(Q.replyWatch, job, 'reply-watch tick');
    const stats = await replyWatchOnce({});
    return stats;
  },
  { connection: redis(), concurrency: 1 },
);
replyWorker.on('failed', onFailed(Q.replyWatch));

const discoverWorker = new Worker<DiscoverJob>(
  Q.discover,
  async (job) => {
    log(Q.discover, job, `discover source=${job.data.source}`);
    if (job.data.source === 'institutions') {
      // Stage 1 — weekly institution discovery scan.
      await aggregateInstitutions({
        dryRun: false,
        useCache: false,
        skipArxiv: false,
        skipGithub: false,
        skipFunding: false,
        top: 25,
        minScore: 6,
        lookbackDays: 30,
      });
      return;
    }
    if (job.data.source === 'research-pending') {
      // Stage 3 — every-15-min sweep: enqueue per-Person research jobs for
      // anyone in NEEDS_RESEARCH. The research worker handles the LLM call.
      const pending = await findPeopleByResearchStatus('NEEDS_RESEARCH', 20);
      log(Q.discover, job, `research-pending: ${pending.length} to enqueue`);
      for (const p of pending) {
        await researchQueue.add('research', { personId: p.id });
      }
      return;
    }
    // Legacy on-demand global discovery (manual triggers only — no longer cron).
    if (job.data.source === 'arxiv' || job.data.source === 'all') {
      await discoverFromArxiv({});
    }
    if (job.data.source === 'similar' || job.data.source === 'all') {
      await discoverFromSimilar({});
    }
    if (job.data.source === 'apollo' || job.data.source === 'all') {
      await discoverFromApollo({});
    }
  },
  { connection: redis(), concurrency: 1 },
);
discoverWorker.on('failed', onFailed(Q.discover));

console.log('[worker] running. Queues:', Object.values(Q).join(', '));

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[worker] received ${signal}, draining…`);
  await Promise.all([
    researchWorker.close(),
    gmailWorker.close(),
    replyWorker.close(),
    discoverWorker.close(),
  ]);
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
