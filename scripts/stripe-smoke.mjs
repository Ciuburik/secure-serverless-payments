/**
 * Stripe Checkout smoke test.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-smoke.mjs
 *
 * Creates a real (test-mode) Checkout Session for every service in the catalogue
 * and prints its URL so you can open one and pay with card 4242 4242 4242 4242.
 * Nothing is charged; test-mode sessions expire on their own.
 */
import { services } from '../netlify/functions/_shared.js';
import { getStripe } from '../netlify/functions/_stripe.js';

const stripe = getStripe();

if (!stripe) {
  console.error('Set STRIPE_SECRET_KEY (use a sk_test_ key) before running this.');
  process.exit(1);
}

if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test key (sk_test_...).');
  process.exit(1);
}

const base = process.env.PUBLIC_BASE_URL || 'http://localhost:8080';

for (const [id, service] of Object.entries(services)) {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: { name: service.name, description: service.description },
            unit_amount: service.amount
          },
          quantity: 1
        }
      ],
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/cancel.html`,
      metadata: { service: id, service_name: service.name }
    });

    console.log(`\n${service.name}  (£${(service.amount / 100).toFixed(2)})`);
    console.log(`  session: ${session.id}`);
    console.log(`  url:     ${session.url}`);
  } catch (err) {
    console.error(`\n${service.name}: FAILED — ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nPay one with test card 4242 4242 4242 4242, any future expiry, any CVC.');
