import cron from "node-cron";
import { query } from "./db.js";
import { getWildberriesPriceByExternalId } from "./providers/wildberries.js";
import { sendTelegramMessage } from "./telegram.js";

async function checkTrack(track) {
  const { track_id, listing_id, provider, external_id, title, target_price } = track;

  let current;
  if (provider === "wildberries") {
    current = await getWildberriesPriceByExternalId(external_id);
  } else {
    return;
  }

  if (!current) return;

  const inserted = await query(
    "INSERT INTO price_snapshots(listing_id, price) VALUES ($1, $2) RETURNING id, captured_at",
    [listing_id, current.price]
  );

  const last = await query(
    "SELECT price FROM price_snapshots WHERE listing_id = $1 ORDER BY captured_at DESC OFFSET 1 LIMIT 1",
    [listing_id]
  );

  const prevPrice = last.rows[0]?.price != null ? Number(last.rows[0].price) : null;
  const curPrice = Number(current.price);

  const subs = await query(
    "SELECT chat_id FROM telegram_subscriptions WHERE track_id = $1",
    [track_id]
  );

  const shouldNotify =
    (prevPrice != null && curPrice !== prevPrice) ||
    (target_price != null && curPrice <= Number(target_price));

  if (!shouldNotify) return;

  const text = [
    `Цена изменилась: ${title}`,
    `Текущая: ${curPrice} ${current.currency}`,
    prevPrice != null ? `Была: ${prevPrice} ${current.currency}` : null,
    target_price != null ? `Цель: ${Number(target_price)} ${current.currency}` : null,
  ].filter(Boolean).join("\n");

  for (const s of subs.rows) {
    await sendTelegramMessage(text, s.chat_id);
  }

  return inserted.rows[0];
}

export function startMonitor() {
  const cronExpr = process.env.MONITOR_CRON || "0 */6 * * *";

  cron.schedule(cronExpr, async () => {
    const tracks = await query(
      "SELECT t.id AS track_id, t.listing_id, l.provider, l.external_id, l.title, t.target_price FROM tracks t JOIN listings l ON l.id = t.listing_id WHERE t.active = TRUE",
      []
    );

    for (const t of tracks.rows) {
      try {
        await checkTrack(t);
      } catch (e) {
        console.error("monitor track failed", t.track_id, e);
      }
    }
  });
}
