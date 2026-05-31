// Minimal RFC-822 builder. The Gmail API's drafts.create accepts the raw
// message base64url-encoded; we build a basic text/html message with both
// plain-text and HTML alternatives.
//
// We deliberately don't pull in nodemailer (which the twenty-server side uses)
// to keep this package's dep footprint small. The downside is no attachments;
// outreach emails are plain prose so that's fine.

export type MimeMessage = {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
};

const encodeHeader = (value: string): string => {
  // RFC 2047 encoded-word for UTF-8 — Gmail expects 7-bit-safe headers.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const textToHtml = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

export const buildMime = (msg: MimeMessage): string => {
  const boundary = `=_verlet_${Math.random().toString(36).slice(2)}`;
  const html = msg.bodyHtml ?? textToHtml(msg.bodyText);

  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');

  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    msg.bodyText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return `${headers}\r\n${body}`;
};

export const encodeRaw = (mime: string): string =>
  Buffer.from(mime, 'utf-8').toString('base64url');
