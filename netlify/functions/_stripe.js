import Stripe from 'stripe';
import { logger } from './_log.js';

const log = logger('stripe');

let client = null;
let warnedMissingKey = false;

/**
 * Returns a single reusable Stripe client, or null when STRIPE_SECRET_KEY is
 * not set (so callers can respond with "payments not configured" instead of
 * throwing). No explicit apiVersion is passed on purpose: the version bundled
 * with the installed `stripe` package is the one its request/response handling
 * is written for, and pinning a different string only invites drift.
 */
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    // Log once per cold start rather than on every request — this is checked
    // on every checkout/webhook call.
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn('stripe-secret-key-not-set');
    }
    return null;
  }

  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY, {
      appInfo: { name: 'bucuriedigital.com', url: 'https://bucuriedigital.com' },
      maxNetworkRetries: 2,
      timeout: 20000
    });
  }

  return client;
}
