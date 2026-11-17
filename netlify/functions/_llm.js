import Anthropic from '@anthropic-ai/sdk';
import { GUARDRAILS, agentFor } from './agents/prompts.js';
import { logger } from './_log.js';

const log = logger('llm');

const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
const EFFORT = process.env.AGENT_EFFORT || 'low';
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 25000);

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ maxRetries: 1 });
  return client;
}

// Shape every agent must return. Structured outputs run in strict mode: every
// property must appear in `required`; "optional" is expressed as a nullable union
// or an empty value.
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['internalNotes', 'needsHuman', 'needsHumanReason', 'crmUpdate', 'email', 'checklist', 'handoff'],
  properties: {
    internalNotes: {
      type: 'string',
      description: 'What you concluded and why, for the human operator. Under 150 words.'
    },
    needsHuman: {
      type: 'boolean',
      description: 'True if a person must review this before anything else happens.'
    },
    needsHumanReason: {
      type: 'string',
      description: 'One line if needsHuman is true, otherwise an empty string.'
    },
    crmUpdate: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'nextAction', 'nextFollowUpDays', 'notes'],
          properties: {
            status: {
              type: 'string',
              enum: ['new', 'qualified', 'discovery-booked', 'proposal-needed', 'won', 'lost', 'nurture', 'client-onboarding', 'in-delivery']
            },
            nextAction: { type: 'string' },
            nextFollowUpDays: { type: 'integer', description: '0 if none.' },
            notes: { type: 'string' }
          }
        }
      ],
      description: 'CRM record change, or null.'
    },
    email: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['to', 'subject', 'body', 'rationale'],
          properties: {
            to: { type: 'string', description: 'Must be the person named in eventContext.' },
            subject: { type: 'string' },
            body: { type: 'string', description: 'Plain text, no HTML, no signature (appended automatically).' },
            rationale: { type: 'string', description: 'Why this email, one sentence.' }
          }
        }
      ],
      description: 'One proposed email, or null.'
    },
    checklist: {
      type: 'array',
      items: { type: 'string' },
      description: 'Internal action items, or an empty array.'
    },
    handoff: {
      type: 'array',
      items: { type: 'string' },
      description: 'Other agent names that should pick this up next, or an empty array.'
    }
  }
};

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('Agent did not return parseable JSON.');
  }
}

/**
 * Run one agent over one task. Returns the parsed structured result.
 * Throws on transport/timeout/parse errors — the caller decides retry vs park.
 */
export async function runAgent(task, extraContext = {}) {
  const a = agentFor(task.agent);
  if (!a) throw new Error(`Unknown agent: ${task.agent}`);

  const api = anthropic();
  if (!api) throw new Error('ANTHROPIC_API_KEY is not set.');

  const system = `${a.system}\n\n${GUARDRAILS}`;

  const userPayload = {
    task: {
      objective: task.objective,
      nextActionHint: task.nextAction,
      priority: task.priority,
      source: task.source
    },
    eventContext: task.context || {},
    ...extraContext
  };

  const emailRule = a.canEmail
    ? 'You MAY propose exactly one email, and only to the person named in eventContext (their own email address). If no email is warranted, set email to null.'
    : 'You must NOT propose an email. Set email to null.';

  const messages = [
    {
      role: 'user',
      content:
        `Handle this task. Return a JSON object matching the required schema.\n` +
        `${emailRule}\n` +
        `Keep internalNotes under 150 words.\n\n` +
        `INPUT:\n${JSON.stringify(userPayload, null, 2)}`
    }
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  const params = {
    model: MODEL,
    max_tokens: 4000,
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: RESULT_SCHEMA }
    },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages
  };
  if ((process.env.AGENT_THINKING || 'adaptive') !== 'off') {
    params.thinking = { type: 'adaptive' };
  }

  // Set once we've already logged a specific failure reason below, so the
  // catch-all in the outer catch doesn't also log a vague duplicate.
  let loggedFailure = false;

  try {
    const stream = api.messages.stream(params, { signal: controller.signal });

    const final = await stream.finalMessage();
    const text = final.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!text.trim()) {
      loggedFailure = true;
      log.error('empty-response', { agent: task.agent, model: MODEL, ms: Date.now() - started, stopReason: final.stop_reason });
      throw new Error('Agent returned no text output.');
    }

    let parsed;
    try {
      parsed = extractJSON(text);
    } catch (err) {
      loggedFailure = true;
      log.error('unparseable-response', { agent: task.agent, model: MODEL, ms: Date.now() - started, error: err.message, textPreview: text.slice(0, 200) });
      throw err;
    }

    log.info('response-ok', { agent: task.agent, model: final.model, ms: Date.now() - started, usage: final.usage, stopReason: final.stop_reason });
    return {
      result: parsed,
      usage: final.usage,
      model: final.model
    };
  } catch (err) {
    if (loggedFailure) {
      // already logged with specifics above
    } else if (controller.signal.aborted) {
      log.error('timeout', { agent: task.agent, model: MODEL, timeoutMs: TIMEOUT_MS, ms: Date.now() - started });
    } else {
      log.error('call-failed', { agent: task.agent, model: MODEL, ms: Date.now() - started, error: err.message });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
