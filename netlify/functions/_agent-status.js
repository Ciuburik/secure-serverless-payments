import { store, TASKS, AUDIT, CONFIG } from './_blobs.js';
import { gmailConfigured } from './_gmail.js';

// One source of truth for the agents' state, used by the admin console and
// the Telegram /status command.
export async function agentStatus({ includeLastActivity = false } = {}) {
  const cfg = store(CONFIG);
  const kill = (await cfg.get('killswitch', { type: 'json' })) || { on: false };
  const rate = (await cfg.get('rate/global', { type: 'json' })) || { windowStart: 0, count: 0 };
  const pending = (await store(TASKS).list({ prefix: 'pending/' })).blobs.length;
  const approvals = (await store(TASKS).list({ prefix: 'approvals/' })).blobs.length;

  const result = {
    mode: (process.env.AGENT_MODE || 'dry-run').toLowerCase(),
    killSwitch: Boolean(kill.on),
    killSwitchChangedAt: kill.at || null,
    gmailConfigured: gmailConfigured(),
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    pendingTasks: pending,
    awaitingApproval: approvals,
    emailsSentThisHour: Date.now() - rate.windowStart < 3600000 ? rate.count : 0
  };

  if (includeLastActivity) {
    // Audit keys start with an ISO timestamp, so the largest key is the newest.
    const { blobs } = await store(AUDIT).list();
    const newest = blobs.map((b) => b.key).sort().pop();
    result.lastActivityAt = newest ? newest.slice(0, 24) : null;
  }

  return result;
}

export async function setKillSwitch(on) {
  const record = { on: Boolean(on), at: new Date().toISOString() };
  await store(CONFIG).setJSON('killswitch', record);
  return record;
}
