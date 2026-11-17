// Minimal Gmail API sender using an OAuth2 refresh token. No SDK dependency.
//
// One-time setup (see DEPLOYMENT.md):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET  — from a Google Cloud OAuth "Web" client
//   GMAIL_REFRESH_TOKEN                    — obtained once via the consent flow
//   GMAIL_SENDER                           — the address to send from (e.g. contact@bucuriedigital.com)

import { logger } from './_log.js';

const log = logger('gmail');

let cachedToken = { value: null, expiresAt: 0 };

export function gmailConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GMAIL_SENDER
  );
}

async function accessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await res.json();
  if (!res.ok) {
    log.error('token-refresh-failed', { status: res.status, error: data.error, errorDescription: data.error_description });
    throw new Error(`Gmail token refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000
  };
  return cachedToken.value;
}

function encodeHeader(value) {
  // RFC 2047 for non-ASCII in headers (subject / display name).
  return /[^\x20-\x7E]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value;
}

function buildRaw({ to, from, subject, text, cc, bcc, replyTo }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ].filter(Boolean);

  const message = `${headers.join('\r\n')}\r\n\r\n${text}`;
  return Buffer.from(message, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Send a plain-text email. Returns { id, threadId }.
 */
export async function sendEmail({ to, subject, text, cc, bcc, replyTo }) {
  if (!gmailConfigured()) throw new Error('Gmail is not configured.');

  const token = await accessToken();
  const raw = buildRaw({
    to,
    from: process.env.GMAIL_SENDER,
    subject,
    text,
    cc,
    bcc,
    replyTo: replyTo || process.env.GMAIL_SENDER
  });

  const started = Date.now();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });

  const data = await res.json();
  if (!res.ok) {
    log.error('send-failed', { status: res.status, error: data.error, ms: Date.now() - started });
    throw new Error(`Gmail send failed: ${res.status} ${JSON.stringify(data)}`);
  }
  log.info('send-ok', { gmailId: data.id, ms: Date.now() - started });
  return { id: data.id, threadId: data.threadId };
}
