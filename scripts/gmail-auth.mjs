/**
 * One-time helper to obtain a Gmail API refresh token for the site's sender.
 *
 *   node scripts/gmail-auth.mjs
 *
 * Reads GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET from .env.local (or the
 * environment), opens Google's consent flow, and writes GMAIL_REFRESH_TOKEN
 * into .env.local. The token is never printed, so it does not end up in
 * terminal history or logs. Copy the GMAIL_* values from .env.local into
 * Netlify afterwards.
 *
 * Prereqs in Google Cloud Console:
 *   1. Create a project, enable the "Gmail API".
 *   2. Google Auth Platform: External audience, scope
 *      https://www.googleapis.com/auth/gmail.send, publishing status
 *      "In production" (in "Testing" the token expires after 7 days).
 *   3. Clients -> Create client -> type "Web application".
 *      Authorised redirect URI: http://localhost:53682/callback
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(import.meta.dirname, '..', '.env.local');

function readEnvFile() {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function saveToEnvFile(key, value) {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

const fileEnv = readEnvFile();
const clientId = process.env.GMAIL_CLIENT_ID || fileEnv.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET || fileEnv.GMAIL_CLIENT_SECRET;
const port = 53682;
const redirectUri = `http://localhost:${port}/callback`;
const scope = 'https://www.googleapis.com/auth/gmail.send';

if (!clientId || !clientSecret) {
  console.error('Fill in GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env.local first, then run this again.');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent'
  });

console.log('\nOpen this URL in your browser, sign in with the Gmail account that should send the emails, and approve access:\n');
console.log(authUrl + '\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (error || !code) {
    console.error(`\nGoogle did not grant access: ${error || 'no code returned'}`);
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Access was not granted. Check the terminal.');
    setTimeout(() => server.close(), 500);
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      throw new Error(`Google returned no refresh token (${data.error || tokenRes.status}: ${data.error_description || 'unknown'}).`);
    }

    saveToEnvFile('GMAIL_REFRESH_TOKEN', data.refresh_token);
    console.log('\n=== SUCCESS ===');
    console.log(`GMAIL_REFRESH_TOKEN was saved into ${envPath} (not printed here).\n`);
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Done. You can close this tab and go back to the terminal.');
  } catch (err) {
    console.error(`\n${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Something went wrong. Check the terminal.');
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(port, () => console.log(`Waiting for Google to send you back to ${redirectUri} ...`));
