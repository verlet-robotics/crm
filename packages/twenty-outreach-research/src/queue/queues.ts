// Typed queue helpers. Each queue gets a Job data type so enqueuers + workers
// can't drift.
import { Queue } from 'bullmq';

import { Q, redis } from './connection.js';

export type ResearchJob = { personId: string };
export type CompanyResearchJob = { companyId: string };
export type GmailPollJob = Record<string, never>;
export type ReplyWatchJob = Record<string, never>;
export type DiscoverJob = {
  source: 'arxiv' | 'similar' | 'apollo' | 'all' | 'institutions' | 'research-pending';
};

export const researchQueue = new Queue<ResearchJob>(Q.research, {
  connection: redis(),
  defaultJobOptions: {
    // 3 attempts, exponential backoff: 30s, 2m, 8m.
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600 }, // keep failures around for debugging
  },
});

export const companyResearchQueue = new Queue<CompanyResearchJob>(Q.company, {
  connection: redis(),
  defaultJobOptions: {
    // Company research deep-researches multiple people; give it the same
    // 3-attempt exponential backoff as person research.
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

export const gmailPollQueue = new Queue<GmailPollJob>(Q.gmailPoll, {
  connection: redis(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { age: 24 * 3600, count: 100 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export const replyWatchQueue = new Queue<ReplyWatchJob>(Q.replyWatch, {
  connection: redis(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { age: 24 * 3600, count: 100 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export const discoverQueue = new Queue<DiscoverJob>(Q.discover, {
  connection: redis(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5 * 60_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

export const queues = {
  research: researchQueue,
  company: companyResearchQueue,
  gmailPoll: gmailPollQueue,
  replyWatch: replyWatchQueue,
  discover: discoverQueue,
};
