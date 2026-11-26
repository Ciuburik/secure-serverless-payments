// Minimal Telegram Bot API sender for owner alerts. No SDK dependency.
//
// Setup:
//   TELEGRAM_BOT_TOKEN — from @BotFather (treat as a secret)
//   TELEGRAM_CHAT_ID   — the owner's chat ID (run `node scripts/telegram-setup.mjs` once)
//
// Messages go only to TELEGRAM_CHAT_ID. Plain text (no Markdown) so visitor
// input can't break formatting or inject links styled as something else.

const MAX_LEN = 3900; // Telegram's limit is 4096 characters

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const body = String(text).length > MAX_LEN ? `${String(text).slice(0, MAX_LEN)}\n…(truncated)` : String(text);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    // Telegram's description never contains the token; the URL is not included.
    let description = `HTTP ${res.status}`;
    try { description = (await res.json()).description || description; } catch { /* ignore */ }
    throw new Error(`Telegram send failed: ${description}`);
  }
}
