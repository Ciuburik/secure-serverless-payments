import { sendEmail, gmailConfigured } from './_gmail.js';
import { sendTelegram, telegramConfigured } from './_telegram.js';
import { logger } from './_log.js';

const log = logger('notify');

// Tells the business owner directly about a new enquiry or paid order, by
// email and/or Telegram, whichever is configured.
// Independent of AGENT_MODE and the kill switch, so a lead always reaches a
// person even while the agents are off. Never throws: a failed notification
// must not lose the visitor's request or make Stripe retry a webhook.
export async function notifyOwner({ subject, text, replyTo, rid }) {
  const results = await Promise.all([viaEmail({ subject, text, replyTo, rid }), viaTelegram({ subject, text, replyTo, rid })]);
  return results.some(Boolean);
}

async function viaEmail({ subject, text, replyTo, rid }) {
  const to = process.env.OWNER_NOTIFY_EMAIL || process.env.AGENT_OPERATOR_EMAIL;

  if (!to) {
    log.warn('owner-notify-skipped', { rid, channel: 'email', reason: 'no OWNER_NOTIFY_EMAIL or AGENT_OPERATOR_EMAIL set' });
    return false;
  }
  if (!gmailConfigured()) {
    log.warn('owner-notify-skipped', { rid, channel: 'email', reason: 'gmail-not-configured' });
    return false;
  }

  try {
    await sendEmail({ to, subject, text, replyTo });
    log.info('owner-notified', { rid, channel: 'email', subject });
    return true;
  } catch (err) {
    log.error('owner-notify-failed', { rid, channel: 'email', error: err.message });
    return false;
  }
}

async function viaTelegram({ subject, text, replyTo, rid }) {
  if (!telegramConfigured()) return false;

  const message = [subject, replyTo ? `Reply to: ${replyTo}` : null, '', text].filter((line) => line !== null).join('\n');

  try {
    await sendTelegram(message);
    log.info('owner-notified', { rid, channel: 'telegram', subject });
    return true;
  } catch (err) {
    log.error('owner-notify-failed', { rid, channel: 'telegram', error: err.message });
    return false;
  }
}
