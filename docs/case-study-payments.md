# Case study: securing and testing a Stripe payment flow

**System:** bucuriedigital.com, a static site with Netlify Functions and Stripe Checkout
**Date:** November 2026
**Goal:** prove that a customer can pay, that a failed payment is handled honestly, and that every paid order is fulfilled exactly once, before taking real money.

## Threat model

| # | What could go wrong | Impact |
|---|---|---|
| T1 | A buyer edits the request and pays less than the listed price | Lost revenue |
| T2 | Someone sends a fake "payment succeeded" event to the webhook | Free service, polluted records |
| T3 | Stripe delivers the same event twice (it retries whenever a reply is slow) | Duplicate onboarding, duplicate emails to the customer |
| T4 | The thank-you page tells a customer they paid when they didn't | Confused customer, support burden, a trust problem |
| T5 | A delayed payment method (bank debit) is treated as paid before it clears | Service delivered for money that never arrives |
| T6 | Secret keys leak into the browser, the repository or the logs | Account takeover |

## Design

- **T1:** The browser sends only `{ "service": "risk" }`. The function looks the amount up in a server-side catalogue and builds the Checkout line item itself, so any other field the browser sends is ignored.
- **T2:** `stripe.webhooks.constructEvent()` verifies the `Stripe-Signature` header against the endpoint's signing secret, using the raw request body. Anything that fails gets `400`.
- **T3:** On the first paid event for a checkout session, the webhook stores a `paid-session/<id>` marker and later events for that session are acknowledged but ignored. As a second layer, payment tasks have deterministic IDs (`<session>-operations`, …), and the intake function skips IDs it has already queued.
- **T4:** The success page shows a neutral "checking your payment" message, asks the server for the session's `payment_status`, and only then shows "paid", "not completed" or "status unavailable".
- **T5:** `checkout.session.completed` with `payment_status: unpaid` is acknowledged and parked; fulfilment waits for `checkout.session.async_payment_succeeded`.
- **T6:** Keys exist only as encrypted Netlify environment variables, marked as secret. No `VITE_*` or client-side key exists, and the build is scanned for key patterns before deploying.

## Tests and results

Run against a local copy with Stripe in test mode (the hosted checkout page shows a **Sandbox** badge, and only Stripe's published test cards were used).

| Test | Expected | Result |
|---|---|---|
| Create a checkout for each of the 5 services | Correct GBP amount and service name in Stripe | Pass (£99, £199, £149, £399, £699) |
| Unknown service ID | Rejected | Pass: `400 Unknown service selected` |
| Send `amount: 1` with the request (T1) | Ignored | Pass: the Stripe session still says £699 |
| Pay with card `4242 4242 4242 4242` | Redirect to the success page with confirmation | Pass: "Confirmed: Cyber Risk Assessment · £399.00" |
| Pay with card `4000 0000 0000 0002` | Declined on Stripe, no order | Pass: "Your card was declined", nothing queued |
| Cancel on the Stripe page | Cancel page | Pass |
| Forged webhook, wrong signature (T2) | `400`, nothing queued | Pass |
| Real paid session replayed as a webhook | 4 onboarding tasks | Pass |
| **Same event delivered twice (T3)** | Second ignored | **Failed initially:** 8 tasks queued. Fixed, retested: pass |
| Delayed payment pending, then succeeded (T5) | Nothing, then 4 tasks | Pass |
| Delayed payment failed, or checkout expired | Ignored | Pass |
| **Success page opened for an unpaid session (T4)** | Must not claim payment | **Failed initially:** said "Your payment has been received". Fixed, retested: pass |

## Two defects found

1. **No idempotency.** The webhook queued tasks on every delivery. Stripe retries events, so a single slow reply would have produced a second set of onboarding tasks, and in live mode a second welcome email to the customer. Fixed with a per-session marker and intake-side deduplication.
2. **A misleading success page.** The default copy said "payment received" and only the small confirmation line depended on Stripe. Anyone opening the URL for a declined checkout saw a thank-you. Fixed by making the whole page wait for the server's answer.

Neither shows up when testing only the happy path.

## Limits of this testing

- Stripe could not call the local machine directly (no tunnel was available), so the real paid session was replayed through the webhook with a locally signed event. In production the endpoint is registered in Stripe and verified the same way.
- There is no automated suite yet. These cases are the first ones to automate.
