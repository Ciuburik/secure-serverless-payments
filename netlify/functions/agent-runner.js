import crypto from 'crypto';
import { store, TASKS, AUDIT, CRM, CONFIG, connectBlobs } from './_blobs.js';
import { runAgent } from './_llm.js';
import { scanEmail, recipientAllowed } from './_guardrails.js';
import { sendEmail, gmailConfigured } from './_gmail.js';
import { agentFor } from './agents/prompts.js';
import { logger } from './_log.js';

const log = logger('agent-runner');

const MODE = () => (process.env.AGENT_MODE || 'dry-run').toLowerCase();
const BATCH = Number(process.env.AGENT_BATCH || 1);
const MAX_ATTEMPTS = Number(process.env.AGENT_MAX_ATTEMPTS || 3);
const LEASE_MS = 5 * 60 * 1000;
const MAX_EMAILS_PER_HOUR = Number(process.env.AGENT_MAX_EMAILS_PER_HOUR || 15);
const RECIPIENT_GAP_HOURS = Number(process.env.AGENT_MIN_RECIPIENT_GAP_HOURS || 6);
const SIGNATURE =
  process.env.AGENT_EMAIL_SIGNATURE ||
  'Bucurie Digital\nhttps://bucuriedigital.com\ncontact@bucuriedigital.com';
const DEADLINE_MS = Number(process.env.AGENT_RUN_DEADLINE_MS || 24000);

const now = () => new Date().toISOString();
const emailKey = (e) => crypto.createHash('sha256').update(String(e).toLowerCase()).digest('hex').slice(0, 24);

async function isKilled() {
  const cfg = store(CONFIG);
  const v = await cfg.get('killswitch', { type: 'json' });
  return Boolean(v && v.on);
}

async function audit(record) {
  const key = `${now()}_${record.taskId || crypto.randomUUID()}`;
  await store(AUDIT).setJSON(key, { at: now(), ...record });
}

async function alert(subject, detail) {
  log.error('alert', { subject, ...detail });
  await audit({ type: 'alert', subject, detail });
}

async function claimNext() {
  const s = store(TASKS);
  const { blobs } = await s.list({ prefix: 'pending/' });
  if (blobs.length === 0) return null;
  const key = blobs.map((b) => b.key).sort()[0];
  const record = await s.get(key, { type: 'json' });
  if (!record) return null;

  // Lease: move out of pending so an overlapping run can't take it too.
  const workingKey = `working/${record.id}`;
  const existing = await s.get(workingKey, { type: 'json' });
  if (existing && Date.now() - new Date(existing.leasedAt).getTime() < LEASE_MS) {
    return null; // someone else holds a fresh lease
  }
  record.leasedAt = now();
  await s.setJSON(workingKey, record);
  await s.delete(key);
  return { record, workingKey };
}

// Return leases that outlived LEASE_MS (a previous run crashed mid-task) to the queue.
async function reclaimStaleLeases() {
  const s = store(TASKS);
  const { blobs } = await s.list({ prefix: 'working/' });
  let reclaimed = 0;
  for (const b of blobs) {
    const rec = await s.get(b.key, { type: 'json' });
    if (!rec) {
      await s.delete(b.key);
      continue;
    }
    if (Date.now() - new Date(rec.leasedAt || 0).getTime() > LEASE_MS) {
      rec.attempts = (rec.attempts || 0) + 1;
      delete rec.leasedAt;
      reclaimed += 1;
      if (rec.attempts >= MAX_ATTEMPTS) {
        await s.setJSON(`failed/${now()}_${rec.id}`, { ...rec, status: 'failed' });
        log.error('lease-reclaim-gave-up', { id: rec.id, agent: rec.task?.agent, attempts: rec.attempts });
      } else {
        await s.setJSON(`pending/${rec.enqueuedAt}_${rec.id}`, rec);
        log.warn('lease-reclaimed', { id: rec.id, agent: rec.task?.agent, attempts: rec.attempts });
      }
      await s.delete(b.key);
    }
  }
  if (reclaimed > 0) log.info('leases-reclaimed', { count: reclaimed });
}

async function finishTask(workingKey, record, status) {
  const s = store(TASKS);
  record.status = status;
  record.finishedAt = now();
  await s.setJSON(`${status}/${record.finishedAt}_${record.id}`, record);
  await s.delete(workingKey);
}

async function requeue(workingKey, record) {
  const s = store(TASKS);
  record.attempts = (record.attempts || 0) + 1;
  delete record.leasedAt;
  if (record.attempts >= MAX_ATTEMPTS) {
    await alert('Task failed after retries', { id: record.id, agent: record.task.agent });
    await finishTask(workingKey, record, 'failed');
    return;
  }
  await s.setJSON(`pending/${record.enqueuedAt}_${record.id}`, record);
  await s.delete(workingKey);
}

async function rateOk(recipient) {
  const cfg = store(CONFIG);
  const hourAgo = Date.now() - 3600 * 1000;
  const g = (await cfg.get('rate/global', { type: 'json' })) || { windowStart: 0, count: 0 };
  const globalCount = g.windowStart > hourAgo ? g.count : 0;
  if (globalCount >= MAX_EMAILS_PER_HOUR) return { ok: false, why: 'hourly email cap reached' };

  const rk = `rate/recipient/${emailKey(recipient)}`;
  const r = (await cfg.get(rk, { type: 'json' })) || { lastSentAt: 0 };
  if (Date.now() - new Date(r.lastSentAt || 0).getTime() < RECIPIENT_GAP_HOURS * 3600 * 1000) {
    return { ok: false, why: `already emailed this recipient within ${RECIPIENT_GAP_HOURS}h` };
  }
  return { ok: true };
}

async function recordSend(recipient) {
  const cfg = store(CONFIG);
  const hourAgo = Date.now() - 3600 * 1000;
  const g = (await cfg.get('rate/global', { type: 'json' })) || { windowStart: 0, count: 0 };
  const fresh = g.windowStart > hourAgo;
  await cfg.setJSON('rate/global', {
    windowStart: fresh ? g.windowStart : Date.now(),
    count: (fresh ? g.count : 0) + 1
  });
  await cfg.setJSON(`rate/recipient/${emailKey(recipient)}`, { lastSentAt: now() });
}

async function loadCrm(email) {
  if (!email) return null;
  return store(CRM).get(String(email).toLowerCase(), { type: 'json' });
}

async function saveCrm(email, update, task) {
  if (!email || !update) return;
  const key = String(email).toLowerCase();
  const prev = (await store(CRM).get(key, { type: 'json' })) || { email: key, history: [] };
  prev.status = update.status || prev.status;
  prev.nextAction = update.nextAction || prev.nextAction;
  if (update.nextFollowUpDays) {
    prev.nextFollowUpAt = new Date(Date.now() + update.nextFollowUpDays * 86400000).toISOString();
  }
  prev.updatedAt = now();
  prev.history = (prev.history || []).concat([
    { at: now(), by: task.agent, status: update.status, note: update.notes || '' }
  ]).slice(-50);
  await store(CRM).setJSON(key, prev);
}

async function processOne(record, workingKey) {
  const { task } = record;
  const mode = MODE();
  const started = Date.now();
  log.info('task-started', { id: record.id, agent: task.agent, attempts: record.attempts || 0, mode });

  const agentDef = agentFor(task.agent);
  if (!agentDef) {
    await alert('Unknown agent on task', { id: record.id, agent: task.agent });
    await finishTask(workingKey, record, 'failed');
    return;
  }

  const contactEmail = task.context?.email || task.context?.clientEmail || task.context?.customer_email || null;
  const crmRecord = await loadCrm(contactEmail);

  let run;
  try {
    run = await runAgent(task, {
      crmRecord,
      today: now(),
      mode
    });
  } catch (err) {
    log.error('llm-call-failed', { id: record.id, agent: task.agent, ms: Date.now() - started, error: err.message });
    await requeue(workingKey, record);
    return;
  }

  log.info('llm-call-ok', { id: record.id, agent: task.agent, ms: Date.now() - started, usage: run.usage });

  const result = run.result || {};
  const outcome = {
    taskId: record.id,
    agent: task.agent,
    source: task.source,
    mode,
    contactEmail,
    internalNotes: result.internalNotes,
    needsHuman: Boolean(result.needsHuman),
    crmUpdate: result.crmUpdate || null,
    checklist: result.checklist || [],
    handoff: result.handoff || [],
    proposedEmail: result.email || null,
    emailStatus: 'none',
    usage: run.usage
  };

  // CRM updates are internal state — always applied.
  if (result.crmUpdate) await saveCrm(contactEmail, result.crmUpdate, task);

  // Email handling
  if (result.email && agentDef.canEmail) {
    const email = result.email;
    const gate = { recipient: recipientAllowed(email, task), scan: scanEmail(email) };

    if (!gate.recipient) {
      outcome.emailStatus = 'blocked:recipient';
      await alert('Agent tried to email a non-permitted address', {
        id: record.id,
        to: email.to,
        allowed: contactEmail
      });
    } else if (!gate.scan.ok) {
      outcome.emailStatus = 'blocked:guardrail';
      outcome.guardrail = gate.scan.violations;
      await alert('Agent email blocked by guardrails', { id: record.id, violations: gate.scan.violations });
      await store(TASKS).setJSON(`approvals/${now()}_${record.id}`, { record, outcome, reason: 'guardrail' });
    } else {
      const rl = await rateOk(email.to);
      if (!rl.ok) {
        outcome.emailStatus = `deferred:${rl.why}`;
        log.warn('email-deferred', { id: record.id, why: rl.why });
        await store(TASKS).setJSON(`approvals/${now()}_${record.id}`, { record, outcome, reason: rl.why });
      } else if (mode === 'live') {
        try {
          const body = `${email.body.trim()}\n\n--\n${SIGNATURE}`;
          const sent = await sendEmail({
            to: email.to,
            subject: email.subject,
            text: body,
            bcc: process.env.AGENT_OPERATOR_EMAIL || undefined,
            replyTo: process.env.GMAIL_SENDER
          });
          await recordSend(email.to);
          outcome.emailStatus = 'sent';
          outcome.gmailId = sent.id;
        } catch (err) {
          outcome.emailStatus = 'send-failed';
          await alert('Gmail send failed', { id: record.id, error: err.message });
        }
      } else if (mode === 'review') {
        outcome.emailStatus = 'awaiting-approval';
        await store(TASKS).setJSON(`approvals/${now()}_${record.id}`, { record, outcome, reason: 'review-mode' });
      } else {
        outcome.emailStatus = 'dry-run';
      }
    }
  }

  await audit({ type: 'run', ...outcome });

  let finalStatus = 'done';
  if (outcome.needsHuman) finalStatus = 'needs-human';
  else if (outcome.emailStatus.startsWith('blocked') || outcome.emailStatus === 'awaiting-approval' || outcome.emailStatus.startsWith('deferred')) {
    finalStatus = 'awaiting-approval';
  }
  await finishTask(workingKey, record, finalStatus);
  log.info('task-finished', {
    id: record.id,
    agent: task.agent,
    status: finalStatus,
    emailStatus: outcome.emailStatus,
    ms: Date.now() - started
  });
}

// Exported for manual invocation (curl, docker-server) and tests.
export async function runOnce() {
  if (MODE() === 'off') return 'agent mode: off';
  if (await isKilled()) return 'kill switch engaged';
  if (!process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY not set';

  const started = Date.now();
  let processed = 0;

  try {
    await reclaimStaleLeases();
  } catch (err) {
    log.error('reclaim-failed', { error: err.message });
  }

  for (let i = 0; i < BATCH; i += 1) {
    if (Date.now() - started > DEADLINE_MS) break;
    const claimed = await claimNext();
    if (!claimed) break;
    try {
      await processOne(claimed.record, claimed.workingKey);
    } catch (err) {
      log.error('unexpected-error', { id: claimed.record.id, agent: claimed.record.task?.agent, error: err.message, stack: err.stack });
      await requeue(claimed.workingKey, claimed.record);
    }
    processed += 1;
  }

  const msg = `agent-runner: processed ${processed} task(s) in ${Date.now() - started}ms (mode: ${MODE()}, gmail: ${gmailConfigured()})`;
  log.info('run-complete', { processed, ms: Date.now() - started, mode: MODE(), gmailConfigured: gmailConfigured() });
  return msg;
}

// Netlify invokes this on the cron schedule declared in netlify.toml
// ([functions."agent-runner"] schedule) — not via the `schedule()` import from
// @netlify/functions, which looked right but silently crashed every
// invocation in production (see the comment on that netlify.toml entry).
export async function handler(event) {
  connectBlobs(event);
  const body = await runOnce();
  return { statusCode: 200, body };
}
