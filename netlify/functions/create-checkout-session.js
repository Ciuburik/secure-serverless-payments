import { cleanText, json, services, siteUrl } from './_shared.js';
import { getStripe } from './_stripe.js';
import { logger } from './_log.js';

const log = logger('create-checkout-session');

export async function handler(event) {
  const rid = log.requestId();

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  const stripe = getStripe();
  if (!stripe) {
    log.error('stripe-not-configured', { rid });
    return json(503, { error: 'Payments are not available right now.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    log.warn('invalid-json', { rid, error: err.message });
    return json(400, { error: 'Invalid JSON body.' });
  }

  const selectedService = cleanText(body.service, 50);
  const selected = services[selectedService];
  if (!selected) {
    log.warn('unknown-service', { rid, service: selectedService });
    return json(400, { error: 'Unknown service selected.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // No payment_method_types: Checkout offers whatever is enabled in the
      // Stripe Dashboard (card, Link, wallets, ...).
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: { name: selected.name, description: selected.description },
            unit_amount: selected.amount
          },
          quantity: 1
        }
      ],
      submit_type: 'pay',
      billing_address_collection: 'auto',
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/cancel.html`,
      metadata: { service: selectedService, service_name: selected.name },
      payment_intent_data: {
        description: `${selected.name} - bucuriedigital.com`,
        metadata: { service: selectedService }
      }
    });

    log.info('session-created', { rid, sessionId: session.id, service: selectedService });
    return json(200, { url: session.url });
  } catch (err) {
    log.error('session-creation-failed', { rid, service: selectedService, error: err.message });
    return json(502, { error: 'Unable to start checkout right now. Please try again.' });
  }
}
