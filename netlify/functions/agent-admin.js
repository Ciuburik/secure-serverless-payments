import crypto from 'crypto';
import { json } from './_shared.js';
import { store, TASKS, AUDIT, CRM, CONFIG, connectBlobs } from './_blobs.js';
import { sendEmail, gmailConfigured } from './_gmail.js';
import { scanEmail } from './_guardrails.js';
import { logger } from './_log.js';

const log = logger('agent-admin');

const SIGNATURE =
  process.env.AGENT_EMAIL_SIGNATURE ||
  'Bucurie Digital\nhttps://bucuriedigital.com\ncontact@bucuriedigital.com';

function authed(event) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 16) return false;
  const provided = (event.headers['x-admin-token'] || event.headers['X-Admin-Token'] || '').trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function listRecords(prefix, limit = 50) {
  const s = store(TASKS);
  const { blobs } = await s.list({ prefix });
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  const out = [];
  for (const k of keys) out.push({ key: k, value: await s.get(k, { type: 'json' }) });
  return out;
}

async function status() {
  const cfg = store(CONFIG);
  const kill = (await cfg.get('killswitch', { type: 'json' })) || { on: false };
  const rate = (await cfg.get('rate/global', { type: 'json' })) || { windowStart: 0, count: 0 };
  const pending = (await store(TASKS).list({ prefix: 'pending/' })).blobs.length;
  const approvals = (await store(TASKS).list({ prefix: 'approvals/' })).blobs.length;
  return {
    mode: (process.env.AGENT_MODE || 'dry-run').toLowerCase(),
    killSwitch: Boolean(kill.on),
    gmailConfigured: gmailConfigured(),
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    pendingTasks: pending,
    awaitingApproval: approvals,
    emailsSentThisHour: Date.now() - rate.windowStart < 3600000 ? rate.count : 0
  };
}

export async function handler(event) {
  const rid = log.requestId();
  connectBlobs(event);

  if (!authed(event)) {
    log.warn('unauthorised', { rid, method: event.httpMethod });
    return json(401, { error: 'Unauthorised.' });
  }

  if (event.httpMethod === 'GET') {
    const view = (event.queryStringParameters?.view || 'status').toLowerCase();
    const limit = Math.min(Number(event.queryStringParameters?.limit || 50), 200);

    if (view === 'status') return json(200, await status());
    if (view === 'queue') return json(200, { tasks: await listRecords('pending/', limit) });
    if (view === 'approvals') return json(200, { approvals: await listRecords('approvals/', limit) });
    if (view === 'audit') {
      const s = store(AUDIT);
      const { blobs } = await s.list();
      const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
      const records = [];
      for (const k of keys) records.push(await s.get(k, { type: 'json' }));
      return json(200, { audit: records });
    }
    if (view === 'crm') {
      const s = store(CRM);
      const { blobs } = await s.list();
      const records = [];
      for (const b of blobs.slice(0, limit)) records.push(await s.get(b.key, { type: 'json' }));
      return json(200, { crm: records });
    }
    return json(400, { error: 'Unknown view.' });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      log.warn('invalid-json', { rid, error: err.message });
      return json(400, { error: 'Invalid JSON.' });
    }

    if (body.action === 'killswitch') {
      log.warn('killswitch-toggled', { rid, on: Boolean(body.on) });
      await store(CONFIG).setJSON('killswitch', { on: Boolean(body.on), at: new Date().toISOString() });
      return json(200, { killSwitch: Boolean(body.on) });
    }

    if (body.action === 'approve' || body.action === 'reject') {
      const s = store(TASKS);
      const key = body.key;
      if (!key || !key.startsWith('approvals/')) return json(400, { error: 'Bad key.' });
      const item = await s.get(key, { type: 'json' });
      if (!item) {
        log.warn('approval-not-found', { rid, key });
        return json(404, { error: 'Not found.' });
      }

      if (body.action === 'reject') {
        await s.setJSON(`rejected/${new Date().toISOString()}_${item.record.id}`, { ...item, rejectedAt: new Date().toISOString() });
        await s.delete(key);
        await store(AUDIT).setJSON(`${new Date().toISOString()}_${item.record.id}`, {
          at: new Date().toISOString(), type: 'approval', decision: 'rejected', taskId: item.record.id
        });
        log.info('approval-rejected', { rid, taskId: item.record.id });
        return json(200, { ok: true });
      }

      // approve → send the proposed email now
      const email = item.outcome?.proposedEmail;
      if (!email) return json(400, { error: 'No email on this item.' });
      const scan = scanEmail(email);
      if (!scan.ok && !body.overrideGuardrail) {
        log.warn('approval-blocked-by-guardrail', { rid, taskId: item.record.id, violations: scan.violations });
        return json(409, { error: 'Guardrail violations — resend with overrideGuardrail:true to force.', violations: scan.violations });
      }
      if (!scan.ok && body.overrideGuardrail) {
        log.warn('approval-guardrail-overridden', { rid, taskId: item.record.id, violations: scan.violations });
      }
      if (!gmailConfigured()) {
        log.error('approval-send-failed', { rid, taskId: item.record.id, reason: 'gmail-not-configured' });
        return json(503, { error: 'Gmail not configured.' });
      }

      try {
        const sent = await log.time('approval-send', () => sendEmail({
          to: email.to,
          subject: email.subject,
          text: `${email.body.trim()}\n\n--\n${SIGNATURE}`,
          bcc: process.env.AGENT_OPERATOR_EMAIL || undefined,
          replyTo: process.env.GMAIL_SENDER
        }), { rid, taskId: item.record.id });
        await s.setJSON(`done/${new Date().toISOString()}_${item.record.id}`, { ...item.record, status: 'done', approvedSend: sent.id });
        await s.delete(key);
        await store(AUDIT).setJSON(`${new Date().toISOString()}_${item.record.id}`, {
          at: new Date().toISOString(), type: 'approval', decision: 'approved-sent', taskId: item.record.id, gmailId: sent.id
        });
        return json(200, { ok: true, gmailId: sent.id });
      } catch (err) {
        // log.time() above already logged the failure with timing; just respond.
        return json(502, { error: `Send failed: ${err.message}` });
      }
    }

    log.warn('unknown-action', { rid, action: body.action });
    return json(400, { error: 'Unknown action.' });
  }

  return json(405, { error: 'Method not allowed.' });
}
