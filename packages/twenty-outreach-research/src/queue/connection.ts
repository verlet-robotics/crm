// BullMQ + Redis connection. Reuses Twenty's REDIS_URL by default; falls back
// to a local Redis for development.
//
// BullMQ requires connections with maxRetriesPerRequest=null for blocking
// operations to behave correctly — ioredis defaults this to 20 retries which
// breaks worker pull behavior.
import IORedis, { type Redis } from 'ioredis';

let redisInstance: Redis | null = null;

export const redis = (): Redis => {
  if (redisInstance) return redisInstance;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  redisInstance = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  redisInstance.on('error', (err) => {
    console.error('[redis] error:', err.message);
  });
  return redisInstance;
};

// Queue names — kept as constants so workers + enqueuers stay in sync.
// BullMQ disallows `:` in queue names (it uses `:` internally as the Redis key
// separator); use `.` as the namespace separator instead.
export const Q = {
  research: 'outreach.research',
  company: 'outreach.company',
  gmailPoll: 'outreach.gmail-poll',
  replyWatch: 'outreach.reply-watch',
  discover: 'outreach.discover',
} as const;
