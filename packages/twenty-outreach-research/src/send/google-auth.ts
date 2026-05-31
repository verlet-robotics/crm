// One-time OAuth dance to mint a Gmail refresh token for outreach drafts.
//
// Why standalone (rather than reading Twenty's encrypted ConnectedAccount.refreshToken)?
//   - The outreach package runs as a tsx script outside the NestJS app.
//   - We reuse Twenty's GOOGLE_OAUTH_CLIENT_ID/SECRET so there's still only one
//     OAuth client across the system; we just store a separate refresh_token
//     scoped to gmail.send + gmail.modify (no PII scopes).
//   - The decrypt path requires the workspace's encryption key + the
//     ConnectedAccountTokenEncryptionService dependency tree. Not worth pulling
//     in for a 4-person team with one sender.
//
// Usage:
//   yarn auth:gmail
//   → prints a Google authorization URL
//   → you paste the redirect URL back
//   → script prints GMAIL_REFRESH_TOKEN=... for Doppler.
import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { type Auth, google } from 'googleapis';

const REDIRECT_URI = 'http://localhost:53456/oauth/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose', // create drafts
  'https://www.googleapis.com/auth/gmail.modify', // read replies, label, send
];

export const buildOAuthClient = (): Auth.OAuth2Client => {
  // Reuse Twenty's existing Google OAuth client when present; fall back to
  // GOOGLE_OAUTH_CLIENT_ID/SECRET for standalone setups.
  const clientId =
    process.env.AUTH_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret =
    process.env.AUTH_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Set AUTH_GOOGLE_CLIENT_ID + AUTH_GOOGLE_CLIENT_SECRET in Doppler (or GOOGLE_OAUTH_CLIENT_ID/_SECRET).',
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
};

// Build a Gmail-authorized OAuth client using the stored refresh token. This
// is the function the rest of the pipeline (gmail-poll, reply-watcher) calls.
export const gmailOAuthClient = (): Auth.OAuth2Client => {
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      'GMAIL_REFRESH_TOKEN is not set. Run `yarn auth:gmail` once and store the printed token in Doppler.',
    );
  }
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
};

const runFlow = async (): Promise<void> => {
  const client = buildOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n  1. Open this URL in your browser:');
  console.log(`\n     ${authUrl}\n`);
  console.log('  2. Sign in as the account that will SEND outreach.');
  console.log('  3. Approve the requested scopes (compose + modify).');
  console.log('  4. The browser will redirect to localhost:53456 — this script will catch it.\n');

  const code = await waitForCode();
  console.log('\n[auth:gmail] received auth code, exchanging for refresh token…');
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      '\n[auth:gmail] ERROR: Google did not return a refresh_token. This usually means you\'ve already approved this client and Google reused an existing grant.',
    );
    console.error('  Revoke the existing grant at https://myaccount.google.com/permissions and re-run.');
    process.exit(1);
  }

  console.log('\n=== STORE THIS IN DOPPLER (crm / dev_verlet) ===');
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('=================================================\n');
};

const waitForCode = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        error
          ? `<h1>auth error</h1><pre>${error}</pre>`
          : `<h1>ok</h1><p>You can close this tab and return to the terminal.</p>`,
      );
      server.close();
      if (error) reject(new Error(error));
      else if (code) resolve(code);
      else reject(new Error('no code in callback'));
    });
    server.listen(53456, () => {
      console.log('[auth:gmail] callback server listening on http://localhost:53456');
    });
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  runFlow().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
