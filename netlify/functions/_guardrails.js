import { services } from './_shared.js';

const knownPrices = new Set(Object.values(services).map((s) => `£${(s.amount / 100).toFixed(0)}`));
// Recovery Guidance is quoted on the site as £249+ but sold via conversation.
knownPrices.add('£249');

const HEDGES = /\b(may|might|possibly|potentially|if|whether|could|would|concerned|worried|suspect|think|believe|in case|appears?|seems?|risk of|help you check|to confirm|assess)\b/i;

const CHECKS = [
  {
    id: 'security-guarantee',
    re: /\b(100%\s*(secure|safe|protected)|fully\s+secure|unhackable|guarantee(d|s)?\s+(security|protection|safety|prevention|no\s+breach)|will\s+(prevent|stop|block)\s+all|eliminat\w*\s+all\s+(risk|threats?))\b/i,
    message: 'Reads as a security guarantee.'
  },
  {
    id: 'unverified-breach',
    test: (t) =>
      /\byou\w*\b[^.!?]{0,50}\b(was|were|is|are|has been|have been|had been|got)\b[^.!?]{0,25}\b(hacked|breached|compromised|taken over|broken into)\b/i.test(t) &&
      !HEDGES.test(t),
    message: 'Asserts a breach/compromise as fact — only allowed with confirmed evidence.'
  },
  {
    id: 'false-certification',
    re: /\b(we are|bucurie digital is)\b[^.]*\b(iso\s*27001|cyber essentials)\b[^.]*\b(certified|accredited|compliant)\b/i,
    message: 'Implies Bucurie Digital holds a certification it does not.'
  },
  {
    id: 'credential-request',
    re: /\b(send|share|provide|give (me|us)|enter your)\b[^.]*\b(password|passphrase|2fa|one[-\s]?time code|otp|recovery code|seed phrase|api key|login details|credentials)\b/i,
    message: 'Requests credentials or secrets.'
  },
  {
    id: 'remote-access-request',
    re: /\b(remote (access|control|session)|teamviewer|anydesk|screen ?share|give (me|us) access to your (account|device|inbox))\b/i,
    message: 'Requests remote access.'
  },
  {
    id: 'legal-tax-advice',
    re: /\b(this is legal advice|as your (lawyer|accountant|solicitor)|you are legally required to)\b/i,
    message: 'Presents itself as regulated legal/tax advice.'
  }
];

/**
 * Scan agent-proposed outbound content. Returns { ok, violations:[{id,message}] }.
 */
export function scanEmail(email) {
  if (!email) return { ok: true, violations: [] };

  const text = `${email.subject || ''}\n${email.body || ''}`;
  const violations = [];

  for (const check of CHECKS) {
    const hit = check.test ? check.test(text) : check.re.test(text);
    if (hit) violations.push({ id: check.id, message: check.message });
  }

  // Any £-figure mentioned must be a real catalogue price.
  const prices = text.match(/£\s?\d[\d,]*/g) || [];
  for (const p of prices) {
    const norm = '£' + p.replace(/[£\s,]/g, '');
    if (!knownPrices.has(norm)) {
      violations.push({ id: 'price-mismatch', message: `Quotes ${p}, which is not a catalogue price.` });
      break;
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * The agent may only email the person tied to the originating event.
 */
export function recipientAllowed(email, task) {
  if (!email?.to) return false;
  const to = String(email.to).trim().toLowerCase();
  const ctx = task.context || {};
  const allowed = [ctx.email, ctx.clientEmail, ctx.customer_email]
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());
  return allowed.includes(to);
}
