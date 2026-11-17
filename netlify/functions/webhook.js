import { checkoutCompletedTasks, json, queueAgentTasks } from './_shared.js';
import { getStripe } from './_stripe.js';
import { store, CONFIG, connectBlobs } from './_blobs.js';
import { notifyOwner } from './_notify.js';
import { logger } from './_log.js';

const log = logger('webhook');

// Events that mean "money is in": `completed` for instant methods (card),
// `async_payment_succeeded` for delayed methods (bank debits, vouchers).
const PAID_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded'
]);

export async function handler(event) {
  const rid = log.requestId();
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    log.error('not-configured', { rid });
    return json(503, { error: 'Stripe webhook is not configured.' });
  }

  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const payload = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    log.error('signature-verification-failed', { rid, error: err.message });
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Invalid signature.'
    };
  }

  if (!PAID_EVENTS.has(stripeEvent.type)) {
    log.info('event-ignored', { rid, type: stripeEvent.type, eventId: stripeEvent.id });
    return json(200, { received: true });
  }

  const session = stripeEvent.data.object;

  // `checkout.session.completed` can arrive while a delayed payment is still
  // pending; wait for `async_payment_succeeded` in that case.
  if (stripeEvent.type === 'checkout.session.completed' && session.payment_status === 'unpaid') {
    log.info('awaiting-async-payment', { rid, sessionId: session.id });
    return json(200, { received: true });
  }

  // Stripe resends an event when it does not get a fast 2xx, and both
  // `completed` and `async_payment_succeeded` can arrive for one session.
  // Handle each paid session once. Storage errors fail open (process anyway).
  const marker = `paid-session/${session.id}`;
  try {
    if (await store(CONFIG).get(marker)) {
      log.info('duplicate-ignored', { rid, type: stripeEvent.type, sessionId: session.id, eventId: stripeEvent.id });
      return json(200, { received: true, duplicate: true });
    }
    await store(CONFIG).set(marker, new Date().toISOString());
  } catch (err) {
    log.warn('dedupe-check-failed', { rid, sessionId: session.id, error: err.message });
  }

  log.info('payment-confirmed', {
    rid,
    type: stripeEvent.type,
    sessionId: session.id,
    service: session.metadata?.service || 'unknown',
    amountTotal: session.amount_total
  });

  const buyer = session.customer_details?.email || session.customer_email || 'unknown';
  const amount = typeof session.amount_total === 'number'
    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: (session.currency || 'gbp').toUpperCase() }).format(session.amount_total / 100)
    : 'unknown amount';
  await notifyOwner({
    rid,
    replyTo: buyer.includes('@') ? buyer : undefined,
    subject: `Paid: ${session.metadata?.service_name || session.metadata?.service || 'service'} (${amount})`,
    text: [
      `Service: ${session.metadata?.service_name || session.metadata?.service || 'unknown'}`,
      `Amount: ${amount}`,
      `Customer: ${buyer}`,
      `Stripe session: ${session.id}`,
      '',
      'Reply to this email to start onboarding.'
    ].join('\n')
  });

  try {
    const queued = await queueAgentTasks(checkoutCompletedTasks(session));
    log.info(queued ? 'tasks-queued' : 'tasks-queue-failed', { rid, sessionId: session.id });
  } catch (err) {
    // Already logged inside queueAgentTasks; never make Stripe retry because a
    // downstream automation was momentarily unavailable.
    log.error('queue-error', { rid, sessionId: session.id, error: err.message });
  }

  return json(200, { received: true });
}
