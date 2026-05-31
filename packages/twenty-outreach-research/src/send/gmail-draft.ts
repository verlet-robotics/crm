// Creates a Gmail draft for an APPROVED Person.
//
// Inputs come from Twenty:
//   - person.emails.primaryEmail → To
//   - person.emailDraftFinal (markdown) → body; fall back to emailDraftV1
//   - subject derived from first line of body (if it looks like a subject) or
//     a sensible default referencing the person's hookSummary.
//
// Outputs:
//   - Gmail draft created
//   - gmailDraftId + gmailThreadId stored back on Person
//   - researchStatus stays APPROVED (Mateo flips to SENT manually when he hits
//     Send in Gmail; the reply watcher will also auto-flip on outbound detection)
import { google } from 'googleapis';

import {
  fetchPersonForGmail,
  type PersonForGmail,
  updatePersonFields,
} from '../lib/twenty-client.js';

import { buildMime, encodeRaw } from './compose-mime.js';
import { gmailOAuthClient } from './google-auth.js';

const SENDER = process.env.OUTREACH_DEFAULT_OWNER_EMAIL;

const stripMarkdownToText = (md: string): string =>
  md
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();

const extractSubjectAndBody = (
  raw: string,
  fallbackHook: string | null | undefined,
): { subject: string; body: string } => {
  const text = stripMarkdownToText(raw);
  // Common pattern: "Subject: ..." on line 1.
  const subjectMatch = text.match(/^Subject:\s*(.+?)\s*\n+/i);
  if (subjectMatch) {
    return {
      subject: subjectMatch[1].trim(),
      body: text.slice(subjectMatch[0].length).trim(),
    };
  }
  // Otherwise short fallback referencing the hook.
  const subject = fallbackHook?.trim()
    ? fallbackHook.slice(0, 78)
    : 'Quick note — Verlet Robotics';
  return { subject, body: text };
};

const getDraftBody = (
  person: PersonForGmail,
): { source: 'emailDraftFinal' | 'emailDraftV1' | 'emailDraftV2'; markdown: string } | null => {
  if (person.emailDraftFinal && 'markdown' in person.emailDraftFinal && person.emailDraftFinal.markdown) {
    return { source: 'emailDraftFinal', markdown: person.emailDraftFinal.markdown };
  }
  if (person.emailDraftV1?.markdown) {
    return { source: 'emailDraftV1', markdown: person.emailDraftV1.markdown };
  }
  if (person.emailDraftV2?.markdown) {
    return { source: 'emailDraftV2', markdown: person.emailDraftV2.markdown };
  }
  return null;
};

export const createGmailDraftForPerson = async (
  personId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{
  personId: string;
  status: 'created' | 'already-drafted' | 'no-email' | 'no-body';
  draftId?: string;
  threadId?: string;
}> => {
  const person = await fetchPersonForGmail(personId);
  if (person.gmailDraftId) {
    return { personId, status: 'already-drafted', draftId: person.gmailDraftId };
  }
  const to = person.emails?.primaryEmail;
  if (!to) {
    console.warn(`[gmail-draft] ${personId} has no primaryEmail — skipping`);
    return { personId, status: 'no-email' };
  }
  // Soft deliverability gate — warn (don't block; Mateo reviews before send)
  // when drafting to an unverified address so a likely bounce is visible.
  if (person.emailConfidence === 'GUESSED' || person.emailConfidence === 'RISKY') {
    console.warn(
      `[gmail-draft] ⚠ ${personId} email ${to} is ${person.emailConfidence} — verify before sending (bounce risk)`,
    );
  }

  const draftBody = getDraftBody(person);
  if (!draftBody) {
    console.warn(`[gmail-draft] ${personId} has no email body filled — skipping`);
    return { personId, status: 'no-body' };
  }

  if (!SENDER) {
    throw new Error('OUTREACH_DEFAULT_OWNER_EMAIL is not set');
  }

  const { subject, body } = extractSubjectAndBody(draftBody.markdown, person.hookSummary);
  const mime = buildMime({ from: SENDER, to, subject, bodyText: body });
  const raw = encodeRaw(mime);

  if (opts.dryRun) {
    console.log(`[gmail-draft] DRY RUN ${personId} → ${to}`);
    console.log(`  subject: ${subject}`);
    console.log(`  body source: ${draftBody.source}`);
    console.log(`  body preview: ${body.slice(0, 200)}…`);
    return { personId, status: 'created' };
  }

  const oauth = gmailOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth: oauth });
  const { data } = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });

  if (!data.id || !data.message?.id) {
    throw new Error(`Gmail draft create returned no id (${JSON.stringify(data)})`);
  }

  const draftId = data.id;
  const messageId = data.message.id;
  const threadId = data.message.threadId ?? messageId;

  await updatePersonFields(personId, {
    gmailDraftId: draftId,
    gmailMessageId: messageId,
    gmailThreadId: threadId,
  });

  console.log(`[gmail-draft] + ${personId} → ${to} draft=${draftId} thread=${threadId}`);
  return { personId, status: 'created', draftId, threadId };
};
