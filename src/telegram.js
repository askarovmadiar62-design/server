export async function sendTelegramMessage(text, chatIdOverride) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride ?? process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID is required");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }

  return await res.json();
}
