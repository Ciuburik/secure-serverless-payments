import crypto from 'crypto';
import { json } from './_shared.js';
import { connectBlobs } from './_blobs.js';
import { agentStatus, setKillSwitch } from './_agent-status.js';
import { sendTelegram, telegramConfigured } from './_telegram.js';
import { logger } from './_log.js';

const log = logger('telegram-webhook');

// Commands from the owner's Telegram chat.
//
// Security:
//   - Telegram sends TELEGRAM_WEBHOOK_SECRET in X-Telegram-Bot-Api-Secret-Token
//     (set when the webhook is registered); anything without it gets 401.
//   - Only messages from TELEGRAM_CHAT_ID (the owner) are acted on; everyone
//     else is ignored without a reply, so the bot reveals nothing to strangers.
//   - Commands older than 5 minutes are ignored, so a delayed or replayed
//     delivery can't flip the kill switch long after it was sent.
//   - Stopping the agents is one step; restarting them needs a confirmation.

const MAX_AGE_SECONDS = 300;

const HELP = [
  'Bucurie Digital bot commands:',
  '/status – agent mode, kill switch, tasks waiting, last activity',
  '/kill – stop all agent processing now',
  '/resume – restart the agents (asks for confirmation)',
  '/help – this list'
].join('\n');

function secretOk(event) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (expected.length < 32) return false;
  const provided = event.headers['x-telegram-bot-api-secret-token'] || event.headers['X-Telegram-Bot-Api-Secret-Token'] || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function londonTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function statusText() {
  const s = await agentStatus({ includeLastActivity: true });
  return [
    s.killSwitch ? '🛑 Agents STOPPED (kill switch on)' : '🟢 Agents running',
    `Mode: ${s.mode}`,
    `Tasks waiting: ${s.pendingTasks}`,
    `Awaiting your approval: ${s.awaitingApproval}`,
    `Emails sent this hour: ${s.emailsSentThisHour}`,
    `Last agent activity: ${londonTime(s.lastActivityAt)}`,
    s.killSwitchChangedAt ? `Kill switch last changed: ${londonTime(s.killSwitchChangedAt)}` : null,
    s.anthropicConfigured ? null : '⚠️ AI key missing',
    s.gmailConfigured ? null : '⚠️ Gmail not configured'
  ].filter(Boolean).join('\n');
}

async function runCommand(text, rid) {
  const [raw, arg] = text.trim().split(/\s+/);
  const command = raw.toLowerCase().replace(/@.*$/, ''); // "/status@your_bot" → "/status"

  switch (command) {
    case '/status':
      return statusText();

    case '/kill': {
      await setKillSwitch(true);
      log.warn('killswitch-toggled', { rid, on: true, via: 'telegram' });
      return '🛑 Kill switch ON. The agents will not process anything until you send /resume.';
    }

    case '/resume': {
      if ((arg || '').toLowerCase() !== 'confirm') {
        return 'This restarts the agents. Send "/resume confirm" to go ahead.';
      }
      await setKillSwitch(false);
      log.warn('killswitch-toggled', { rid, on: false, via: 'telegram' });
      return `🟢 Kill switch OFF. Agents resume on their next run (within 2 minutes).\nMode: ${(process.env.AGENT_MODE || 'dry-run').toLowerCase()}`;
    }

    case '/start':
    case '/help':
      return HELP;

    default:
      return `Unknown command.\n\n${HELP}`;
  }
}

export async function handler(event) {
  const rid = log.requestId();

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (!secretOk(event)) {
    log.warn('unauthorised', { rid });
    return json(401, { error: 'Unauthorised.' });
  }

  // From here on always answer 200, otherwise Telegram keeps redelivering.
  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch {
    log.warn('invalid-json', { rid });
    return json(200, { ok: true });
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') return json(200, { ok: true });

  const owner = String(process.env.TELEGRAM_CHAT_ID || '');
  if (!owner || String(message.chat?.id) !== owner || String(message.from?.id) !== owner) {
    log.warn('ignored-non-owner', { rid, chatType: message.chat?.type });
    return json(200, { ok: true });
  }

  if (Date.now() / 1000 - Number(message.date || 0) > MAX_AGE_SECONDS) {
    log.warn('ignored-stale-command', { rid, ageSeconds: Math.round(Date.now() / 1000 - Number(message.date || 0)) });
    return json(200, { ok: true });
  }

  if (!message.text.startsWith('/')) {
    if (telegramConfigured()) await sendTelegram(HELP).catch(() => {});
    return json(200, { ok: true });
  }

  connectBlobs(event);

  let reply;
  try {
    reply = await runCommand(message.text, rid);
    log.info('command', { rid, command: message.text.split(/\s+/)[0] });
  } catch (err) {
    log.error('command-failed', { rid, error: err.message });
    reply = `⚠️ That didn't work: ${err.message}`;
  }

  try {
    await sendTelegram(reply);
  } catch (err) {
    log.error('reply-failed', { rid, error: err.message });
  }
  return json(200, { ok: true });
}
