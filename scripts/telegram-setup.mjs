// One-time Telegram setup. Reads TELEGRAM_BOT_TOKEN from .env.local, finds the
// chat of the person who pressed Start on the bot, writes TELEGRAM_CHAT_ID into
// .env.local, and sends a test message. Never prints the token.
//
// Usage: open your bot in Telegram, press Start, then run
//   node scripts/telegram-setup.mjs

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
const env = readFileSync(envPath, 'utf8');
const token = (env.match(/^TELEGRAM_BOT_TOKEN=(.*)$/m) || [])[1]?.trim();

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is empty in .env.local. Paste the token from @BotFather and save the file.');
  process.exit(1);
}
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
  console.error(`TELEGRAM_BOT_TOKEN doesn't look like a bot token (length ${token.length}). Check for spaces, quotes or a partial paste.`);
  process.exit(1);
}

const api = async (method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || `HTTP ${res.status}`}`);
  return data.result;
};

const me = await api('getMe');
console.log(`Token works for @${me.username}.`);

// `--webhook`: point the bot at the live site so /status, /kill and /resume work.
// Run after deploying, with TELEGRAM_WEBHOOK_SECRET also set in Netlify.
if (process.argv.includes('--webhook')) {
  const secret = (env.match(/^TELEGRAM_WEBHOOK_SECRET=(.*)$/m) || [])[1]?.trim();
  if (!secret || secret.length < 32) {
    console.error('TELEGRAM_WEBHOOK_SECRET is missing or shorter than 32 characters in .env.local.');
    process.exit(1);
  }
  const base = process.env.PUBLIC_BASE_URL || 'https://bucuriedigital.com';
  await api('setWebhook', {
    url: `${base}/.netlify/functions/telegram-webhook`,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true
  });
  await api('setMyCommands', {
    commands: [
      { command: 'status', description: 'Agent mode, kill switch, tasks waiting' },
      { command: 'kill', description: 'Stop all agent processing now' },
      { command: 'resume', description: 'Restart the agents (asks to confirm)' },
      { command: 'help', description: 'List commands' }
    ]
  });
  const info = await api('getWebhookInfo');
  console.log(`Webhook set to ${info.url}; commands registered. Send /status to @${me.username}.`);
  process.exit(0);
}

const updates = await api('getUpdates', { allowed_updates: ['message'] });
const chats = new Map();
for (const u of updates) {
  const chat = u.message?.chat;
  if (chat?.type === 'private') chats.set(chat.id, chat.first_name || 'someone');
}

if (chats.size === 0) {
  console.error(`No messages found. Open @${me.username} in Telegram, press Start (or send /start), then run this again.`);
  process.exit(1);
}
if (chats.size > 1) {
  console.error(`${chats.size} different people have messaged the bot (${[...chats.values()].join(', ')}). Stopping so alerts don't go to the wrong person.`);
  process.exit(1);
}

const [chatId, name] = [...chats.entries()][0];
const next = env.match(/^TELEGRAM_CHAT_ID=.*$/m)
  ? env.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`)
  : `${env.trimEnd()}\nTELEGRAM_CHAT_ID=${chatId}\n`;
writeFileSync(envPath, next);
chmodSync(envPath, 0o600);
console.log(`Chat found for ${name}; TELEGRAM_CHAT_ID saved to .env.local.`);

await api('sendMessage', { chat_id: chatId, text: '✅ Bucurie Digital alerts are connected. New enquiries and payments will appear here.' });
console.log('Test message sent. Check Telegram.');
