import { logger } from './_log.js';

const log = logger('shared');

export const siteUrl = process.env.PUBLIC_BASE_URL || 'https://bucuriedigital.com';

export const services = {
  'identity-audit': {
    name: 'Identity Security Audit',
    amount: 9900,
    description: 'A practical review of social accounts, email security, recovery paths, impersonation risk, and priority safety steps.'
  },
  'account-hardening': {
    name: 'Account Hardening',
    amount: 19900,
    description: 'A guided account hardening plan covering password management, MFA, backup codes, email safety, and recovery options.'
  },
  healthcheck: {
    name: 'Cybersecurity Health Check',
    amount: 14900,
    description: 'A focused review of password security, MFA, device hygiene, backups, and basic cyber controls.'
  },
  risk: {
    name: 'Cyber Risk Assessment',
    amount: 39900,
    description: 'A structured risk register, likelihood and impact scoring, and prioritised remediation roadmap.'
  },
  iso: {
    name: 'ISO 27001 Readiness Review',
    amount: 69900,
    description: 'A practical gap analysis, control review, and readiness roadmap for better security governance.'
  }
};

export const validServiceIds = new Set([...Object.keys(services), 'recovery-guidance', 'general']);

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

export function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Returns a usable https(s) URL, or null for unset / placeholder values so a
// misconfigured deploy (e.g. the .env.example placeholders) does not break requests.
export function usableUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (/(^|\.)(invalid|example)($|\.|\/|:)/i.test(url) || url.includes('example.com')) return null;
  return url;
}

export function websiteLeadTasks(lead) {
  return [
    {
      id: cryptoRandomId(),
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/contact',
      agent: 'Sales Agent',
      priority: 'high',
      objective: `Qualify ${lead.name} from ${lead.business || 'unknown business'} and prepare a first reply.`,
      context: lead,
      nextAction: 'Send a helpful reply and propose a discovery call.'
    },
    {
      id: cryptoRandomId(),
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/contact',
      agent: 'CEO Agent',
      priority: 'medium',
      objective: 'Assess whether this lead fits Bucurie Digital focus, credibility, and revenue priorities.',
      context: lead,
      nextAction: 'Decide whether to pursue, defer, or refer.'
    },
    {
      id: cryptoRandomId(),
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/contact',
      agent: 'Operations Agent',
      priority: 'medium',
      objective: 'Create a follow-up checklist and capture the lead in the CRM workflow.',
      context: lead,
      nextAction: 'Set status, owner, and follow-up date.'
    }
  ];
}

export function checkoutCompletedTasks(session) {
  const service = session.metadata?.service || 'unknown';
  const clientEmail = session.customer_email || session.customer_details?.email || 'unknown email';

  return [
    {
      id: `${session.id}-operations`,
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/stripe-webhook',
      agent: 'Operations Agent',
      priority: 'urgent',
      objective: `Start onboarding for ${service} purchase by ${clientEmail}.`,
      context: { sessionId: session.id, service, clientEmail },
      nextAction: 'Send welcome steps, create delivery checklist, and request required evidence.'
    },
    {
      id: `${session.id}-consultant`,
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/stripe-webhook',
      agent: 'Cybersecurity Consultant Agent',
      priority: 'high',
      objective: `Prepare delivery scope and evidence request for ${service}.`,
      context: { sessionId: session.id, service, clientEmail },
      nextAction: 'Confirm boundaries, assumptions, and information needed before review.'
    },
    {
      id: `${session.id}-finance`,
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/stripe-webhook',
      agent: 'Finance Agent',
      priority: 'medium',
      objective: `Record paid ${service} checkout and expected delivery margin.`,
      context: { sessionId: session.id, service, clientEmail, amountTotal: session.amount_total },
      nextAction: 'Log revenue, Stripe fees, tax notes, and invoice follow-up.'
    },
    {
      id: `${session.id}-ceo`,
      createdAt: new Date().toISOString(),
      source: 'bucuriedigital.com/stripe-webhook',
      agent: 'CEO Agent',
      priority: 'medium',
      objective: `Review strategic value and delivery risk for new ${service} client.`,
      context: { sessionId: session.id, service, clientEmail },
      nextAction: 'Confirm delivery priority and any reputation or scope risks.'
    }
  ];
}

export async function queueAgentTasks(tasks) {
  const webhookUrl = usableUrl(process.env.AGENT_WEBHOOK_URL);
  const taskIds = tasks.map((t) => t.id);

  if (!webhookUrl) {
    // No destination configured: log the tasks so they are visible in function logs
    // instead of silently vanishing.
    log.warn('no-webhook-configured', { taskIds, agents: tasks.map((t) => t.agent) });
    return true;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AGENT_INTAKE_SECRET) {
    headers['x-intake-secret'] = process.env.AGENT_INTAKE_SECRET;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'bucuriedigital.com', tasks })
    });

    if (!response.ok) {
      log.error('webhook-failed', { taskIds, status: response.status, body: await response.text() });
      return false;
    }
  } catch (err) {
    log.error('webhook-error', { taskIds, error: err.message });
    return false;
  }

  log.info('webhook-ok', { taskIds });
  return true;
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
