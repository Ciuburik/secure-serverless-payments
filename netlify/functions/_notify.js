import { sendEmail, gmailConfigured } from './_gmail.js';
import { logger } from './_log.js';

const log = logger('notify');

// Emails the business owner directly about a new enquiry or paid order.
// Independent of AGENT_MODE and the kill switch, so a lead always reaches a
// person even while the agents are off. Never throws: a failed notification
// must not lose the visitor's request or make Stripe retry a webhook.
export async function notifyOwner({ subject, text, replyTo, rid }) {
  const to = process.env.OWNER_NOTIFY_EMAIL || process.env.AGENT_OPERATOR_EMAIL;

  if (!to) {
    log.warn('owner-notify-skipped', { rid, reason: 'no OWNER_NOTIFY_EMAIL or AGENT_OPERATOR_EMAIL set' });
    return false;
  }
  if (!gmailConfigured()) {
    log.warn('owner-notify-skipped', { rid, reason: 'gmail-not-configured' });
    return false;
  }

  try {
    await sendEmail({ to, subject, text, replyTo });
    log.info('owner-notified', { rid, subject });
    return true;
  } catch (err) {
    log.error('owner-notify-failed', { rid, error: err.message });
    return false;
  }
}
