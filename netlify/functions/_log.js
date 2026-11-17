// Structured logging helper shared by every function. Netlify collects each
// function's stdout/stderr into its Function log stream, interleaved across
// concurrent invocations — a consistent `[fn] event {json}` shape (instead of
// free-form sentences that differ per call site) is what makes that stream
// grep-able when chasing an error after the fact.

const REDACT_KEYS = new Set([
  'password', 'secret', 'token', 'apikey', 'api_key', 'authorization',
  'refresh_token', 'access_token', 'client_secret', 'x-intake-secret', 'x-admin-token'
]);

function redact(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, seen);
  }
  return out;
}

function emit(level, fn, event, meta) {
  const line = meta && Object.keys(meta).length
    ? `[${fn}] ${event} ${JSON.stringify(redact(meta))}`
    : `[${fn}] ${event}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * const log = logger('contact');
 * log.info('lead-received', { rid, email: lead.email });
 * log.error('webhook-failed', { rid, status });
 * await log.time('anthropic-call', () => api.messages.stream(...), { rid, agent });
 */
export function logger(fn) {
  return {
    info: (event, meta) => emit('log', fn, event, meta),
    warn: (event, meta) => emit('warn', fn, event, meta),
    error: (event, meta) => emit('error', fn, event, meta),

    // Times an async operation and logs its outcome (ok or error) either way,
    // so a slow/hanging call and a failing call both leave a duration behind.
    async time(event, run, meta = {}) {
      const started = Date.now();
      try {
        const result = await run();
        emit('log', fn, `${event}:ok`, { ...meta, ms: Date.now() - started });
        return result;
      } catch (err) {
        emit('error', fn, `${event}:error`, { ...meta, ms: Date.now() - started, error: err.message });
        throw err;
      }
    },

    // Short id to correlate the several log lines one invocation produces,
    // since Netlify's stream interleaves concurrent invocations of the same
    // function.
    requestId: () =>
      globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Date.now().toString(36)
  };
}
