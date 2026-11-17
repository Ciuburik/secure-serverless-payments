import crypto from 'crypto';
import { json } from './_shared.js';
import { store, TASKS, connectBlobs } from './_blobs.js';
import { logger } from './_log.js';

const log = logger('agent-intake');

// Receives { source, tasks: [...] } from the website (via AGENT_WEBHOOK_URL) and
// enqueues each task for agent-runner. Returns fast — no processing here.

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function handler(event) {
  const rid = log.requestId();
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  const secret = process.env.AGENT_INTAKE_SECRET;
  if (!secret) {
    log.error('secret-not-configured', { rid });
    return json(503, { error: 'Intake not configured.' });
  }

  const provided =
    (event.headers['x-intake-secret'] || event.headers['X-Intake-Secret'] || '').trim();
  if (!timingSafeEqual(provided, secret)) {
    log.warn('unauthorised', { rid, hasHeader: Boolean(provided) });
    return json(401, { error: 'Unauthorised.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    log.warn('invalid-json', { rid, error: err.message });
    return json(400, { error: 'Invalid JSON body.' });
  }

  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  if (tasks.length === 0) return json(400, { error: 'No tasks.' });
  if (tasks.length > 25) {
    log.warn('too-many-tasks', { rid, count: tasks.length, source: body.source || 'unknown' });
    return json(400, { error: 'Too many tasks in one call.' });
  }

  const s = store(TASKS);
  const accepted = [];
  let skipped = 0;
  let duplicates = 0;

  for (const t of tasks) {
    if (!t || typeof t.agent !== 'string' || typeof t.objective !== 'string') {
      skipped += 1;
      continue;
    }
    const id = typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID();

    // Callers that send a stable id (e.g. the Stripe webhook, keyed on the
    // checkout session) get each task queued once, even if they retry.
    if (await s.get(`seen/${id}`)) {
      duplicates += 1;
      continue;
    }
    const record = {
      id,
      status: 'pending',
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      source: body.source || t.source || 'unknown',
      task: {
        id,
        agent: t.agent,
        priority: t.priority || 'medium',
        objective: t.objective,
        nextAction: t.nextAction || '',
        source: t.source || body.source || 'unknown',
        context: t.context && typeof t.context === 'object' ? t.context : {}
      }
    };
    await s.setJSON(`pending/${record.enqueuedAt}_${id}`, record);
    await s.set(`seen/${id}`, record.enqueuedAt);
    accepted.push(id);
  }

  log.info('enqueued', { rid, source: body.source || 'unknown', accepted: accepted.length, skipped, duplicates });
  return json(202, { accepted, duplicates });
}
