import { json } from './_shared.js';
import { getStripe } from './_stripe.js';
import { logger } from './_log.js';

const log = logger('get-checkout-session');

// Read-only lookup used by success.html to confirm a real, paid checkout
// instead of showing a thank-you to anyone who opens the URL directly.
export async function handler(event) {
  const rid = log.requestId();

  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed.' });
  }

  const stripe = getStripe();
  if (!stripe) {
    log.error('stripe-not-configured', { rid });
    return json(503, { error: 'Payments are not available right now.' });
  }

  const sessionId = (event.queryStringParameters?.session_id || '').trim();
  if (!/^cs_[A-Za-z0-9_]{10,}$/.test(sessionId)) {
    log.warn('invalid-session-id', { rid });
    return json(400, { error: 'Missing or invalid session id.' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    log.info('session-retrieved', { rid, sessionId, paid: session.payment_status === 'paid' });
    return json(200, {
      paid: session.payment_status === 'paid',
      status: session.status,
      service: session.metadata?.service_name || session.metadata?.service || null,
      amountTotal: session.amount_total,
      currency: session.currency
    });
  } catch (err) {
    log.error('session-lookup-failed', { rid, sessionId, error: err.message });
    return json(404, { error: 'Checkout session not found.' });
  }
}
