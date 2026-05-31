// Polls Gmail for replies to outreach threads and updates Twenty.
//
// Strategy:
//   1. List inbox messages newer than the watcher's last-checked timestamp.
//   2. For each, fetch the thread + look up the matching Person via
//      Person.gmailThreadId.
//   3. If the message wasn't sent by us and isn't already processed, classify
//      it, flip Person.researchStatus → REPLIED, set replyDisposition, attach a
//      Twenty Task so the human knows to follow up.
//
// The watcher persists its high-water-mark internalDate in a small JSON file
// under `.state/reply-watcher.json` next to this package, so re-runs are
// incremental and idempotent on restart.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gmail_v1, google } from 'googleapis';

import {
  createTaskForPerson,
  findPeopleAwaitingSendConfirmation,
  findPersonByGmailThreadId,
  recomputeOutreachStageForPerson,
  updatePersonFields,
} from '../lib/twenty-client.js';

import { gmailOAuthClient } from './google-auth.js';
import { classifyReply } from './reply-classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../../.state');
const STATE_FILE = path.join(STATE_DIR, 'reply-watcher.json');

type WatcherState = { lastInternalDate?: string };

const loadState = async (): Promise<WatcherState> => {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as WatcherState;
  } catch {
    return {};
  }
};

const saveState = async (state: WatcherState): Promise<void> => {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
};

const headerValue = (
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined =>
  headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? undefined;

// Walk message parts looking for text/plain; fall back to text/html stripped.
const extractBodyText = (payload: gmail_v1.Schema$MessagePart | undefined): string => {
  if (!payload) return '';
  const parts: gmail_v1.Schema$MessagePart[] = [payload];
  let plain = '';
  let html = '';
  while (parts.length) {
    const p = parts.shift()!;
    if (p.parts?.length) parts.push(...p.parts);
    const mime = p.mimeType ?? '';
    const data = p.body?.data;
    if (!data) continue;
    const decoded = Buffer.from(data, 'base64url').toString('utf-8');
    if (mime === 'text/plain' && !plain) plain = decoded;
    if (mime === 'text/html' && !html) html = decoded;
  }
  if (plain) return plain;
  if (html) return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return '';
};

type ProcessableMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  from: string;
  subject: string;
  body: string;
};

const fetchReplies = async (
  gmail: gmail_v1.Gmail,
  afterInternalDate: string | undefined,
): Promise<ProcessableMessage[]> => {
  // Query: incoming mail (not from us) in the last day, excluding chats.
  // 'newer_than:1d' bounds the scan even if the persisted watermark is fresh.
  const query = ['-in:chats', '-from:me', 'newer_than:1d'].join(' ');

  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  const messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);

  const results: ProcessableMessage[] = [];
  for (const id of messageIds) {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    if (!msg.id || !msg.threadId || !msg.internalDate) continue;
    if (afterInternalDate && msg.internalDate <= afterInternalDate) continue;

    results.push({
      id: msg.id,
      threadId: msg.threadId,
      internalDate: msg.internalDate,
      from: headerValue(msg.payload?.headers ?? undefined, 'From') ?? '',
      subject: headerValue(msg.payload?.headers ?? undefined, 'Subject') ?? '',
      body: extractBodyText(msg.payload ?? undefined),
    });
  }
  return results;
};

type WatcherStats = {
  scanned: number;
  matched: number;
  classified: number;
  sentConfirmed: number;
  bounced: number;
  errors: number;
};

// Walk a thread's messages and decide:
//   - has Mateo actually sent the draft (any message without the DRAFT label)?
//   - did the message bounce (a mailer-daemon delivery failure replying back)?
type ThreadInspection = {
  sent: boolean;
  sentAtIso?: string;
  bounced: boolean;
};

const inspectThreadForOutbound = async (
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<ThreadInspection> => {
  const { data: thread } = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject', 'X-Failed-Recipients'],
  });

  let sent = false;
  let sentAtIso: string | undefined;
  let bounced = false;
  for (const msg of thread.messages ?? []) {
    const labels = msg.labelIds ?? [];
    if (!labels.includes('DRAFT') && labels.includes('SENT')) {
      sent = true;
      if (!sentAtIso && msg.internalDate) {
        sentAtIso = new Date(Number(msg.internalDate)).toISOString();
      }
    }
    const from = headerValue(msg.payload?.headers ?? undefined, 'From') ?? '';
    const failed =
      headerValue(msg.payload?.headers ?? undefined, 'X-Failed-Recipients') ?? '';
    if (/mailer-daemon|postmaster/i.test(from) || failed) {
      bounced = true;
    }
  }
  return { sent, bounced, ...(sentAtIso && { sentAtIso }) };
};

export const replyWatchOnce = async (
  opts: { dryRun?: boolean } = {},
): Promise<WatcherStats> => {
  const state = await loadState();
  const oauth = gmailOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth: oauth });

  const messages = await fetchReplies(gmail, state.lastInternalDate);
  console.log(`[reply-watch] scanned ${messages.length} new messages`);

  const stats: WatcherStats = {
    scanned: messages.length,
    matched: 0,
    classified: 0,
    sentConfirmed: 0,
    bounced: 0,
    errors: 0,
  };
  let highWater = state.lastInternalDate ?? '0';

  for (const msg of messages) {
    if (msg.internalDate > highWater) highWater = msg.internalDate;
    try {
      const person = await findPersonByGmailThreadId(msg.threadId);
      if (!person) continue;
      stats.matched += 1;

      console.log(`[reply-watch] match ${person.id} ← thread ${msg.threadId}`);
      if (opts.dryRun) {
        console.log(`  subject: ${msg.subject}`);
        console.log(`  body: ${msg.body.slice(0, 300)}…`);
        continue;
      }

      const classification = await classifyReply(msg.body, { sentSubject: msg.subject });
      stats.classified += 1;

      const fields: Record<string, unknown> = {
        researchStatus: classification.disposition === 'UNSUBSCRIBE' ? 'SKIPPED' : 'REPLIED',
        replyDisposition: classification.disposition,
      };
      await updatePersonFields(person.id, fields);

      // Advance the account's Company Kanban stage (→ IN_CONVERSATION on a reply).
      await recomputeOutreachStageForPerson(person.id).catch((err) => {
        console.warn(
          `[reply-watch] outreachStage recompute skipped: ${err instanceof Error ? err.message : err}`,
        );
      });

      const taskBody = [
        `**Reply disposition:** ${classification.disposition}`,
        `**Why:** ${classification.oneLineReason}`,
        `**Suggested next step:** ${classification.suggestedNextStep}`,
        '',
        '---',
        `**From:** ${msg.from}`,
        `**Subject:** ${msg.subject}`,
        '',
        msg.body.slice(0, 1500),
      ].join('\n');

      await createTaskForPerson({
        personId: person.id,
        title: `Reply (${classification.disposition}) — ${msg.from}`,
        bodyMarkdown: taskBody,
      });
    } catch (err) {
      console.error(`[reply-watch] msg ${msg.id} failed:`, err);
      stats.errors += 1;
    }
  }

  // Second pass: APPROVED People with a thread but no confirmed-sent state.
  // Walk each thread and flip → SENT (or SKIPPED on bounce) when Mateo has
  // actually clicked Send in Gmail.
  const awaiting = await findPeopleAwaitingSendConfirmation();
  for (const person of awaiting) {
    if (!person.gmailThreadId) continue;
    try {
      const inspection = await inspectThreadForOutbound(gmail, person.gmailThreadId);
      if (inspection.bounced) {
        if (!opts.dryRun) {
          await updatePersonFields(person.id, {
            researchStatus: 'SKIPPED',
            replyDisposition: 'NEGATIVE',
            ...(inspection.sentAtIso && { lastSentAt: inspection.sentAtIso }),
          });
          await createTaskForPerson({
            personId: person.id,
            title: 'Outreach bounced',
            bodyMarkdown:
              'Gmail returned a delivery failure for this address. Marked SKIPPED — verify the email before retrying.',
          });
        }
        stats.bounced += 1;
        console.log(`[reply-watch] bounced ${person.id}`);
        continue;
      }
      if (inspection.sent) {
        if (!opts.dryRun) {
          await updatePersonFields(person.id, {
            researchStatus: 'SENT',
            ...(inspection.sentAtIso && { lastSentAt: inspection.sentAtIso }),
          });
          // Advance the account's Company Kanban stage (→ OUTREACH_SENT).
          await recomputeOutreachStageForPerson(person.id).catch((err) => {
            console.warn(
              `[reply-watch] outreachStage recompute skipped: ${err instanceof Error ? err.message : err}`,
            );
          });
        }
        stats.sentConfirmed += 1;
        console.log(`[reply-watch] SENT ${person.id} (${inspection.sentAtIso ?? 'no date'})`);
      }
    } catch (err) {
      console.error(`[reply-watch] sent-check ${person.id} failed:`, err);
      stats.errors += 1;
    }
  }

  if (!opts.dryRun) {
    await saveState({ lastInternalDate: highWater });
  }
  return stats;
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const stats = await replyWatchOnce({ dryRun });
  console.log('[reply-watch] done', stats);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
