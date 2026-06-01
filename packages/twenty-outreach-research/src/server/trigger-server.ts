// HTTP trigger server. This is the bridge between Twenty's UI and the BullMQ
// pipeline: Twenty record buttons (manual-trigger workflows with an HTTP
// Request action) POST here, we enqueue a job and return 202 immediately. The
// queue worker (`queue:worker`) does the slow LLM work out-of-band.
//
// Why a separate process from the worker: the button must get a fast response
// (research runs take minutes), so the web dyno only enqueues. Run the worker
// alongside it to actually drain the queues.
//
// Run: `yarn trigger:server` (or wrap with doppler for secrets).
//
// Auth: every /triggers/* call must send `Authorization: Bearer <token>` where
// the token matches OUTREACH_TRIGGER_TOKEN. /health is unauthenticated so
// Railway/uptime checks work.
import 'dotenv/config';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { companyResearchQueue, discoverQueue, researchQueue } from '../queue/queues.js';
import { findPeopleByResearchStatus } from '../lib/twenty-client.js';
import { researchGate } from '../qualify/should-research.js';

const PORT = Number(process.env.OUTREACH_TRIGGER_PORT ?? process.env.PORT ?? 8787);
const TOKEN = process.env.OUTREACH_TRIGGER_TOKEN;

// Basic UUID shape check — Twenty record ids are v4 UUIDs. Guards against the
// HTTP action firing with an unrendered template string (e.g. "{{record.id}}").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
};

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('invalid JSON body');
  }
};

const isAuthorized = (req: IncomingMessage): boolean => {
  if (!TOKEN) return false;
  const header = req.headers.authorization ?? '';
  const expected = `Bearer ${TOKEN}`;
  // Length check first so timing-safe compare doesn't throw on mismatched sizes.
  if (header.length !== expected.length) return false;
  return header === expected;
};

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error('[trigger-server] unhandled:', err);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
  });
});

const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && (url === '/health' || url === '/')) {
    json(res, 200, {
      ok: true,
      service: 'outreach-trigger',
      queues: ['research', 'company', 'discover'],
    });
    return;
  }

  if (method !== 'POST') {
    json(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  if (!isAuthorized(req)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { ok: false, error: 'invalid JSON body' });
    return;
  }

  if (url === '/triggers/research-person') {
    const personId = String(body.personId ?? '').trim();
    if (!UUID_RE.test(personId)) {
      json(res, 400, { ok: false, error: 'personId must be a UUID' });
      return;
    }
    // jobId = personId makes the enqueue idempotent — clicking the button twice
    // while a job is still queued won't double-research the same person.
    const job = await researchQueue.add('research', { personId }, { jobId: personId });
    console.log(`[trigger-server] enqueued research personId=${personId} job=${job.id}`);
    json(res, 202, { ok: true, queued: 'research', personId, jobId: job.id });
    return;
  }

  if (url === '/triggers/research-company') {
    const companyId = String(body.companyId ?? '').trim();
    if (!UUID_RE.test(companyId)) {
      json(res, 400, { ok: false, error: 'companyId must be a UUID' });
      return;
    }
    const job = await companyResearchQueue.add('company', { companyId }, { jobId: companyId });
    console.log(`[trigger-server] enqueued company companyId=${companyId} job=${job.id}`);
    json(res, 202, { ok: true, queued: 'company', companyId, jobId: job.id });
    return;
  }

  // Global: sweep the NEEDS_RESEARCH backlog and enqueue each gated Person.
  // Record-less — wired to a global manual-trigger workflow / command-menu item.
  if (url === '/triggers/run-pending') {
    const rawLimit = Number(body.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
    const all = await findPeopleByResearchStatus('NEEDS_RESEARCH', limit);
    // Same gate enqueue-research.ts uses — skip investors + poor-fit roles
    // before spending research credits.
    const eligible = all.filter((person) => researchGate(person).research);
    for (const person of eligible) {
      await researchQueue.add('research', { personId: person.id }, { jobId: person.id });
    }
    console.log(
      `[trigger-server] run-pending: ${all.length} NEEDS_RESEARCH, ${eligible.length} enqueued (limit=${limit})`,
    );
    json(res, 202, {
      ok: true,
      queued: 'research',
      found: all.length,
      enqueued: eligible.length,
      skipped: all.length - eligible.length,
    });
    return;
  }

  // Global: kick off the Stage 1 institution/discovery scan (arXiv + GitHub +
  // funding). No static jobId on purpose: the discover queue retains completed
  // jobs for days, so pinning a fixed id would silently block re-running the
  // scan. The discover worker runs at concurrency 1, so overlapping enqueues
  // queue up rather than run concurrently.
  if (url === '/triggers/discovery-scan') {
    const job = await discoverQueue.add('discover', { source: 'institutions' });
    console.log(`[trigger-server] enqueued discovery scan job=${job.id}`);
    json(res, 202, { ok: true, queued: 'discover', source: 'institutions', jobId: job.id });
    return;
  }

  json(res, 404, { ok: false, error: 'not found', path: url });
};

if (!TOKEN) {
  // Fail fast: without a token every trigger call would 401, so a missing token
  // is a misconfiguration, not a thing to silently run with.
  console.error('[trigger-server] OUTREACH_TRIGGER_TOKEN is not set — refusing to start.');
  process.exit(1);
}

// Touch randomUUID so the import is used even if not referenced above; keeps a
// single obvious place to mint correlation ids if we add request tracing later.
void randomUUID;

server.listen(PORT, () => {
  console.log(`[trigger-server] listening on :${PORT} (POST /triggers/research-person, /triggers/research-company)`);
});

const shutdown = (signal: string): void => {
  console.log(`[trigger-server] received ${signal}, closing…`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
