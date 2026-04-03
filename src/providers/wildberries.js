function toRubPrice(price) {
  if (price == null) return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

const WB_CACHE_TTL_MS = 60_000;
const wbCache = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cacheGet(key) {
  const v = wbCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    wbCache.delete(key);
    return null;
  }
  return v.value;
}

function cacheSet(key, value) {
  wbCache.set(key, { value, expiresAt: Date.now() + WB_CACHE_TTL_MS });
}

async function fetchJson(url, headers) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (typeof fetch === "function") {
      const res = await fetch(url, { headers });
      const status = res.status;

      if (status === 429 || status === 503) {
        if (attempt === maxAttempts) {
          const body = await res.text().catch(() => "");
          throw new Error(`WB rate limited (${status}). Try again later. ${body.slice(0, 200)}`);
        }
        await sleep(400 * attempt + Math.floor(Math.random() * 200));
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`WB request failed: ${status} ${body.slice(0, 500)}`);
      }

      return await res.json();
    }

    const { request } = await import("node:https");
    const { status, text } = await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("error", reject);
          res.on("end", () => {
            resolve({
              status: Number(res.statusCode ?? 0),
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

    if (status === 429 || status === 503) {
      if (attempt === maxAttempts) {
        throw new Error(`WB rate limited (${status}). Try again later. ${text.slice(0, 200)}`);
      }
      await sleep(400 * attempt + Math.floor(Math.random() * 200));
      continue;
    }

    if (status < 200 || status >= 300) {
      throw new Error(`WB request failed: ${status} ${text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`WB request failed: ${text.slice(0, 500)}`);
    }
  }

  throw new Error("WB request failed");
}

export async function searchWildberries(query) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const cached = cacheGet(`search:${q.toLowerCase()}`);
  if (cached) return cached;

  const url = new URL("https://search.wb.ru/exactmatch/ru/common/v5/search");
  url.searchParams.set("appType", "1");
  url.searchParams.set("curr", "rub");
  url.searchParams.set("dest", "-1257786");
  url.searchParams.set("query", q);
  url.searchParams.set("resultset", "catalog");
  url.searchParams.set("sort", "popular");
  url.searchParams.set("spp", "30");
  url.searchParams.set("suppressSpellcheck", "false");

  const data = await fetchJson(url, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.wildberries.ru/",
  });
  const products = data?.data?.products ?? [];

  const out = products.slice(0, 20).map((p) => {
    const id = String(p?.id ?? "");
    const title = String(p?.name ?? "");
    const price = toRubPrice(p?.salePriceU ?? p?.priceU);
    const ratingRaw = p?.reviewRating ?? p?.rating ?? p?.valuation;
    const rating = ratingRaw == null ? null : Number(ratingRaw);
    const reviewsRaw = p?.feedbacks ?? p?.reviews ?? p?.reviewCount;
    const reviewsCount = reviewsRaw == null ? null : Number(reviewsRaw);
    const url = id ? `https://www.wildberries.ru/catalog/${id}/detail.aspx` : "";

    return {
      provider: "wildberries",
      externalId: id,
      title,
      price,
      currency: "RUB",
      rating: Number.isFinite(rating) ? rating : null,
      reviewsCount: Number.isFinite(reviewsCount) ? reviewsCount : null,
      url,
    };
  }).filter((x) => x.externalId && x.title && x.price != null && x.url);

  cacheSet(`search:${q.toLowerCase()}`, out);
  return out;
}

export async function getWildberriesPriceByExternalId(externalId) {
  const id = String(externalId ?? "").trim();
  if (!id) throw new Error("externalId is required");

  const url = new URL("https://card.wb.ru/cards/detail");
  url.searchParams.set("appType", "1");
  url.searchParams.set("curr", "rub");
  url.searchParams.set("dest", "-1257786");
  url.searchParams.set("nm", id);

  const data = await fetchJson(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
  });
  const product = data?.data?.products?.[0];
  if (!product) return null;

  const price = toRubPrice(product?.salePriceU ?? product?.priceU);
  if (price == null) return null;

  return { price, currency: "RUB" };
}

export async function getWildberriesProductByExternalId(externalId) {
  const id = String(externalId ?? "").trim();
  if (!id) throw new Error("externalId is required");

  const cached = cacheGet(`detail:${id}`);
  if (cached) return cached;

  const url = new URL("https://card.wb.ru/cards/detail");
  url.searchParams.set("appType", "1");
  url.searchParams.set("curr", "rub");
  url.searchParams.set("dest", "-1257786");
  url.searchParams.set("nm", id);

  const data = await fetchJson(url, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.wildberries.ru/",
  });

  const product = data?.data?.products?.[0];
  if (!product) return null;

  const title = String(product?.name ?? "").trim();
  const price = toRubPrice(product?.salePriceU ?? product?.priceU);
  const ratingRaw = product?.reviewRating ?? product?.rating ?? product?.valuation;
  const rating = ratingRaw == null ? null : Number(ratingRaw);
  const reviewsRaw = product?.feedbacks ?? product?.reviews ?? product?.reviewCount;
  const reviewsCount = reviewsRaw == null ? null : Number(reviewsRaw);
  const link = `https://www.wildberries.ru/catalog/${id}/detail.aspx`;

  const out = {
    provider: "wildberries",
    externalId: id,
    title,
    price,
    currency: "RUB",
    rating: Number.isFinite(rating) ? rating : null,
    reviewsCount: Number.isFinite(reviewsCount) ? reviewsCount : null,
    url: link,
  };

  cacheSet(`detail:${id}`, out);
  return out;
}
