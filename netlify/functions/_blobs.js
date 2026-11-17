import { getStore, connectLambda } from '@netlify/blobs';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './_log.js';

const log = logger('blobs');

// getStore() needs per-invocation credentials that Netlify's runtime hands each
// function via the raw Lambda event (event.blobs + x-nf-site-id/x-nf-deploy-id
// headers) — *not* via env vars present at module load, and *not* automatically
// for a classic `export async function handler(event)` (a.k.a. "Lambda
// compatibility mode"). That requires calling connectBlobs(event) — see below —
// at the top of the handler before any store() call.
//
// Found 2026-10-19 on a real deploy: without connectBlobs(), getStore() threw
// "environment has not been configured" on every call, and the previous code
// swallowed that into a silent filesystem fallback — which then *also* crashed,
// because the fallback wrote to process.cwd(), which is the read-only
// `/var/task` deployment package in this Lambda runtime. The task queue would
// have appeared to work (agent-intake returns 202) while silently never
// processing anything, with no error anywhere, were it not for the logging below.
//
// Fix: connectBlobs(event) in every handler that touches Blobs (agent-intake,
// agent-admin, agent-runner). store() still tries the real client first and
// only falls back to the filesystem for genuinely-local contexts (tests,
// docker-server) — now using /tmp, the one writable path in this runtime, so
// even an unexpected fallback degrades instead of crashing.
const onLambda = Boolean(process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME);
const localRoot = join(onLambda ? '/tmp' : process.cwd(), '.agent-store');
let cachedBackend = null; // 'netlify-blobs' | 'filesystem', decided on first use

// Call once at the top of any handler that uses store()/TASKS/AUDIT/CRM/CONFIG,
// passing the raw Lambda event. Safe to call even where event.blobs isn't
// present (local docker-server, tests) — it just leaves the fallback in place.
export function connectBlobs(event) {
  try {
    connectLambda(event);
  } catch (err) {
    log.warn('connect-lambda-failed', { error: err.message });
  }
}

function resolveBackend(name) {
  try {
    // 'strong' consistency needs an uncachedEdgeURL, which connectLambda()'s
    // event-derived context (Lambda-compat functions only get edgeURL) never
    // provides — requesting it throws BlobsConsistencyError on every call.
    // Default ('eventual') is fine here: tasks are claimed by a single cron run
    // every 2 minutes with its own lease/retry mechanism, not read-after-write
    // within one request.
    const candidate = getStore({ name });
    if (!cachedBackend) {
      cachedBackend = 'netlify-blobs';
      log.info('backend-selected', { backend: cachedBackend });
    }
    return candidate;
  } catch (err) {
    if (!cachedBackend) {
      cachedBackend = 'filesystem';
      log.warn('backend-selected', { backend: cachedBackend, localRoot, reason: err.message });
    }
    return null;
  }
}

function fsStore(name) {
  const dir = join(localRoot, name);
  const file = (key) => join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get(key, opts) {
      try {
        const raw = await readFile(file(key), 'utf8');
        return opts?.type === 'json' ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    },
    async setJSON(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(key), JSON.stringify(value, null, 2));
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(key), String(value));
    },
    async delete(key) {
      await rm(file(key), { force: true });
    },
    async list(opts) {
      try {
        const names = await readdir(dir);
        let blobs = names
          .filter((n) => n.endsWith('.json'))
          .map((n) => ({ key: decodeURIComponent(n.slice(0, -5)) }));
        if (opts?.prefix) blobs = blobs.filter((b) => b.key.startsWith(opts.prefix));
        return { blobs };
      } catch {
        return { blobs: [] };
      }
    }
  };
}

export function store(name) {
  const real = resolveBackend(name);
  return real || fsStore(name);
}

// Convenience helpers -------------------------------------------------------

export const TASKS = 'agent-tasks';
export const AUDIT = 'agent-audit';
export const CRM = 'agent-crm';
export const CONFIG = 'agent-config';

export async function getJSON(name, key, fallback = null) {
  const s = store(name);
  const value = await s.get(key, { type: 'json' });
  return value ?? fallback;
}

export async function putJSON(name, key, value) {
  await store(name).setJSON(key, value);
}

export async function listKeys(name, prefix) {
  const { blobs } = await store(name).list(prefix ? { prefix } : undefined);
  return blobs.map((b) => b.key);
}
