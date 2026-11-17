import crypto from 'crypto';
import { cleanText, isEmail, json, queueAgentTasks, usableUrl, validServiceIds, websiteLeadTasks } from './_shared.js';
import { store, CONFIG, connectBlobs } from './_blobs.js';
import { notifyOwner } from './_notify.js';
import { logger } from './_log.js';

const log = logger('contact');

// Each accepted enquiry starts several paid AI agent runs, so cap how many one
// visitor can send. Counted per hashed IP (the raw address is never stored) in
// a rolling one-hour window. Any storage failure fails open: losing a genuine
// lead is worse than letting one extra message through.
const MAX_ENQUIRIES_PER_HOUR = Number(process.env.CONTACT_MAX_PER_HOUR || 5);
const WINDOW_MS = 60 * 60 * 1000;

function clientKey(event) {
  const headers = event.headers || {};
  const ip =
    headers['x-nf-client-connection-ip'] ||
    headers['client-ip'] ||
    String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

async function overRateLimit(event, rid) {
  const key = clientKey(event);
  if (!key) return false;

  try {
    const s = store(CONFIG);
    const blobKey = `rate/contact/${key}`;
    const now = Date.now();
    const current = (await s.get(blobKey, { type: 'json' })) || { windowStart: now, count: 0 };
    const active = now - current.windowStart < WINDOW_MS ? current : { windowStart: now, count: 0 };

    if (active.count >= MAX_ENQUIRIES_PER_HOUR) return true;

    await s.setJSON(blobKey, { windowStart: active.windowStart, count: active.count + 1 });
    return false;
  } catch (err) {
    log.warn('rate-limit-check-failed', { rid, error: err.message });
    return false;
  }
}

export async function handler(event) {
  const rid = log.requestId();
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    log.warn('invalid-json', { rid, error: err.message });
    return json(400, { error: 'Invalid JSON body.' });
  }

  // Spam checks. Bots that fill the hidden honeypot, or scripts that POST straight
  // to this endpoint without the browser form's fields, get a normal-looking
  // response but are discarded.
  const trippedHoneypot = cleanText(body.company_website, 200).length > 0;
  const missingFormToken = cleanText(body.js_check, 20) !== 'human';
  const missingAcknowledgement = body.advisory_acknowledgement !== 'on' && body.advisory_acknowledgement !== true;

  if (trippedHoneypot || missingFormToken || missingAcknowledgement) {
    log.warn('rejected-as-spam', { rid, trippedHoneypot, missingFormToken, missingAcknowledgement });
    return json(201, { message: 'Thanks. Your enquiry has been received.' });
  }

  const lead = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name: cleanText(body.name, 120),
    business: cleanText(body.business, 160),
    email: cleanText(body.email, 180).toLowerCase(),
    service: cleanText(body.service, 80),
    message: cleanText(body.message, 2000),
    source: 'bucuriedigital.com'
  };

  const errors = [];
  if (lead.name.length < 2) errors.push('Enter your name.');
  if (!isEmail(lead.email)) errors.push('Enter a valid email address.');
  if (!lead.message || lead.message.length < 10) errors.push('Add a short message.');
  if (lead.service && !validServiceIds.has(lead.service)) errors.push('Choose a valid service.');

  if (errors.length > 0) {
    log.info('validation-failed', { rid, errors });
    return json(400, { errors });
  }

  if (await overRateLimit(event, rid)) {
    log.warn('rate-limited', { rid });
    return json(429, { error: 'You have sent several requests recently. Please try again in an hour, or email contact@bucuriedigital.com.' });
  }

  // Always record the lead so it is never silently lost, even with no webhook configured.
  log.info('lead-received', { rid, leadId: lead.id, email: lead.email, service: lead.service || 'unspecified' });

  const webhookUrl = usableUrl(process.env.LEAD_WEBHOOK_URL);
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead)
      });

      if (!response.ok) {
        log.error('lead-webhook-failed', { rid, leadId: lead.id, status: response.status, body: await response.text() });
      }
    } catch (err) {
      // The lead is already logged above; do not fail the visitor's request.
      log.error('lead-webhook-error', { rid, leadId: lead.id, error: err.message });
    }
  }

  await notifyOwner({
    rid,
    replyTo: lead.email,
    subject: `New enquiry: ${lead.name}${lead.business ? ` (${lead.business})` : ''}`,
    text: [
      `Name: ${lead.name}`,
      `Business: ${lead.business || '-'}`,
      `Email: ${lead.email}`,
      `Service: ${lead.service || 'not sure'}`,
      `Received: ${lead.createdAt}`,
      '',
      lead.message,
      '',
      'Reply to this email to answer them directly.'
    ].join('\n')
  });

  try {
    await queueAgentTasks(websiteLeadTasks(lead));
  } catch (err) {
    log.error('agent-task-queue-error', { rid, leadId: lead.id, error: err.message });
  }

  return json(201, { message: 'Thanks. Your enquiry has been received.' });
}
