import "dotenv/config";
import express from "express";
import cors from "cors";
import { query } from "./db.js";
import { getWildberriesProductByExternalId, searchWildberries } from "./providers/wildberries.js";
import { compareAssistant } from "./assistant.js";
import { geminiJson, geminiText } from "./ai/gemini.js";
import { startMonitor } from "./monitor.js";

function extractWbExternalIdFromText(text) {
  const s = String(text ?? "");
  const m1 = s.match(/wildberries\.ru\/catalog\/(\d+)\/detail\.aspx/i);
  if (m1?.[1]) return m1[1];
  const m2 = s.match(/[?&]nm=(\d+)/i);
  if (m2?.[1]) return m2[1];
  return null;
}

function extractWbExternalIdFromUrl(url) {
  return extractWbExternalIdFromText(url);
}

function normalizeQuery(text) {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoRedirect(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    // ignore
  }
  return href;
}

function getSearxngUrl() {
  const v = String(process.env.SEARXNG_URL ?? "").trim();
  return v || null;
}

async function searxngSearch(q) {
  const base = getSearxngUrl();
  if (!base) return [];
  const query = String(q ?? "").trim();
  if (!query) return [];

  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "ru");

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json",
    },
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`SearxNG search failed: ${resp.status} ${t.slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => null);
  const items = Array.isArray(data?.results) ? data.results : [];
  return items
    .map((r) => ({
      title: String(r?.title ?? "").trim(),
      url: String(r?.url ?? "").trim(),
      snippet: String(r?.content ?? r?.snippet ?? "").trim(),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, 10);
}

async function duckDuckGoSearch(q) {
  const query = String(q ?? "").trim();
  if (!query) return [];

  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const s = Number(resp.status);
    if (s === 403) {
      throw new Error(`Web search blocked by DuckDuckGo (403). Configure SEARXNG_URL for fallback. ${t.slice(0, 200)}`);
    }
    throw new Error(`Web search failed: ${resp.status} ${t.slice(0, 200)}`);
  }

  const html = await resp.text();

  function parseHtmlTemplate(doc) {
    const results = [];
    const linkRe =
      /<a[^>]*class=['"][^'\"]*\bresult__a\b[^'\"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(doc)) && results.length < 10) {
      const href = m[1];
      const titleHtml = m[2];
      const title = String(titleHtml)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const rawUrl = decodeDuckDuckGoRedirect(href);
      results.push({ title, url: rawUrl, snippet: "" });
    }

    const snippetRe =
      /<(?:a|div|span)[^>]*class=['"][^'\"]*\bresult__snippet\b[^'\"]*['"][^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi;
    let s;
    let idx = 0;
    while ((s = snippetRe.exec(doc)) && idx < results.length) {
      const snipHtml = s[1];
      const snip = String(snipHtml)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (snip) results[idx].snippet = snip;
      idx++;
    }

    return results.filter((r) => r.title && r.url);
  }

  function parseLiteTemplate(doc) {
    const results = [];
    const linkRe = /<a[^>]*class=['"][^'\"]*\bresult-link\b[^'\"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(doc)) && results.length < 10) {
      const href = m[1];
      const titleHtml = m[2];
      const title = String(titleHtml)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      results.push({ title, url: href, snippet: "" });
    }
    return results.filter((r) => r.title && r.url);
  }

  let out = parseHtmlTemplate(html);

  if (out.length < 3) {
    const liteUrl = new URL("https://lite.duckduckgo.com/lite/");
    liteUrl.searchParams.set("q", query);
    const liteResp = await fetch(liteUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    if (liteResp.ok) {
      const liteHtml = await liteResp.text();
      const more = parseLiteTemplate(liteHtml);
      const seen = new Set(out.map((r) => r.url));
      for (const r of more) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
        if (out.length >= 10) break;
      }
    }
  }

  return out;
}

async function webSearch(q) {
  try {
    return await duckDuckGoSearch(q);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const hasSearx = Boolean(getSearxngUrl());
    if (hasSearx) {
      return await searxngSearch(q);
    }
    throw new Error(msg);
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isMarketplaceResult(r) {
  const host = hostnameOf(r?.url);
  const allowedHosts = [
    "www.wildberries.ru",
    "wildberries.ru",
    "www.ozon.ru",
    "ozon.ru",
    "www.ozon.kz",
    "ozon.kz",
    "kaspi.kz",
    "www.kaspi.kz",
    "aliexpress.com",
    "www.aliexpress.com",
    "aliexpress.ru",
    "www.aliexpress.ru",
    "market.yandex.ru",
    "market.yandex.kz",
    "yandex.ru",
    "www.yandex.ru",
    "sbermegamarket.ru",
    "www.sbermegamarket.ru",
    "lamoda.ru",
    "www.lamoda.ru",
    "amazon.com",
    "www.amazon.com",
    "ebay.com",
    "www.ebay.com",
  ];

  const hostOk = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));

  const text = `${r?.title ?? ""} ${r?.snippet ?? ""}`.toLowerCase();
  const negativeInfo = /\b(википедия|wiki|анатомия|строени[ея]|что такое|определени[ея]|симптом|лечение|стать[яи]|справочник|энциклопед[ия]|картинк[аи]|фото)\b/i.test(
    text
  );

  const commerceStrong =
    /\b(купить|заказать|в корзину|добавить в корзину|цена|стоим|₸|тенге|₽|руб|доставка|самовывоз|в наличии|интернет-?магазин|магазин)\b/i.test(
      text
    );

  // For marketplaces we trust host even if snippet is short.
  if (hostOk) return true;

  // For other sites require strong commerce signals and reject obvious informational pages.
  if (negativeInfo) return false;
  return commerceStrong;
}

function looksLikeProductPage(url) {
  const u = String(url ?? "");
  const host = hostnameOf(u);
  if (!host) return false;

  // Reject obvious home pages.
  if (/\/(?:$|\?|#)/.test(u) && /^(?:https?:\/\/)?[^\/]+\/?(?:\?.*)?$/i.test(u)) return false;

  // Reject obvious non-product listing pages.
  if (/\/(?:search|catalog|category|c\/|brands|seller|shops|store|stores)\b/i.test(u)) return false;

  if (/wildberries\.ru/i.test(host)) {
    return Boolean(extractWbExternalIdFromUrl(u));
  }

  // Ozon product pages often contain /product/ or /context/detail/
  if (/ozon\.(ru|kz)$/i.test(host) || /\bozon\.(ru|kz)\b/i.test(host)) {
    // Typical: https://ozon.kz/product/...-1615273386/
    if (/\/product\//i.test(u)) return /-(\d{6,})(?:\/?|\?|#)/.test(u);
    if (/\/context\//i.test(u)) return true;
    return false;
  }

  // Kaspi product pages often contain /p/
  if (/kaspi\.kz/i.test(host)) {
    return /\/p\//i.test(u);
  }

  // Yandex Market product pages
  if (/market\.yandex\.(ru|kz)$/i.test(host)) {
    return /\/card\//i.test(u) || /\/product--/i.test(u) || /\/offer\//i.test(u);
  }

  // Generic heuristics: presence of product-like path segments
  return /\b(product|products|item|sku|p)\b/i.test(u) || /\b(\d{5,})\b/.test(u);
}

function pickBestProductResult(results) {
  const arr = Array.isArray(results) ? results : [];
  const productish = arr.filter((r) => looksLikeProductPage(r?.url));

  // Prefer marketplace hosts among product pages.
  const preferred = productish.filter((r) => {
    const h = hostnameOf(r?.url);
    return (
      /wildberries\.ru$/i.test(h) ||
      /ozon\.(ru|kz)$/i.test(h) ||
      /kaspi\.kz$/i.test(h) ||
      /market\.yandex\.(ru|kz)$/i.test(h)
    );
  });

  if (preferred.length) return preferred[0];
  if (productish.length) return productish[0];
  return arr[0] ?? null;
}

async function webProductSearch(queryText) {
  const qBase = queryText ? `${queryText} купить цена заказать` : queryText;
  const base = await webSearch(qBase);
  const baseFiltered = base.filter(isMarketplaceResult);

  // If base results don't include any product-card URLs, try targeted searches.
  const hasProduct = baseFiltered.some((r) => looksLikeProductPage(r?.url));
  if (hasProduct) return baseFiltered;

  const targetedQueries = [
    queryText ? `${queryText} site:ozon.kz/product` : "",
    queryText ? `${queryText} site:ozon.ru/product` : "",
    queryText ? `${queryText} site:market.yandex.ru/card` : "",
    queryText ? `${queryText} site:market.yandex.ru product--` : "",
    queryText ? `${queryText} site:kaspi.kz/p` : "",
    queryText ? `${queryText} site:wildberries.ru/catalog` : "",
  ].filter(Boolean);

  const merged = [...baseFiltered];
  const seen = new Set(merged.map((r) => String(r?.url)));

  for (const tq of targetedQueries) {
    const more = await webSearch(tq);
    for (const r of more) {
      const url = String(r?.url ?? "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      if (!isMarketplaceResult(r)) continue;
      merged.push(r);
      if (merged.length >= 25) break;
    }
    if (merged.some((r) => looksLikeProductPage(r?.url))) break;
  }

  return merged;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1", []);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.post("/api/assistant/shops", async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    const queryText = normalizeQuery(message);
    const q = queryText;

    function simulatedStats(seedText) {
      const s = String(seedText ?? "");
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      const rating = 4 + ((h % 90) / 100); // 4.00 - 4.89
      const reviews = 100 + (h % 25000);
      return {
        rating: Number(rating.toFixed(2)),
        reviewsCount: reviews,
        note: "примерные",
      };
    }

    const shops = [
      {
        name: "Ozon KZ",
        url: q ? `https://ozon.kz/search/?text=${encodeURIComponent(q)}` : "https://ozon.kz/",
      },
      {
        name: "Kaspi",
        url: q ? `https://kaspi.kz/shop/search/?text=${encodeURIComponent(q)}` : "https://kaspi.kz/shop/",
      },
      {
        name: "Wildberries",
        url: q ? `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(q)}` : "https://www.wildberries.ru/",
      },
      {
        name: "Яндекс Маркет",
        url: q ? `https://market.yandex.ru/search?text=${encodeURIComponent(q)}` : "https://market.yandex.ru/",
      },
      {
        name: "AliExpress",
        url: q ? `https://aliexpress.ru/wholesale?SearchText=${encodeURIComponent(q)}` : "https://aliexpress.ru/",
      },
    ].map((shop) => ({
      ...shop,
      stats: simulatedStats(`${shop.name}:${q}`),
    }));

    const text = shops.length
      ? `Я подобрал маркетплейсы по запросу: ${q || message}.\n\nРейтинг и отзывы ниже — примерные (оценочные).\n\n` +
        shops
          .map((s, i) => {
            const st = s.stats;
            return `${i + 1}. ${s.name}\nСсылка: ${s.url}\nРейтинг: ${st.rating} | Отзывов: ${st.reviewsCount} (${st.note})`;
          })
          .join("\n\n")
      : "Не удалось сформировать ссылки.";

    res.json({ query: q, shops, text });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/assistant/web-product", async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    const queryText = normalizeQuery(message);
    const filtered = await webProductSearch(queryText);
    const top = filtered.slice(0, 10);

    const picked = pickBestProductResult(top);
    if (!picked) {
      return res.json({
        query: queryText,
        picked: null,
        product: null,
        results: [],
        debug: { total: 0, filtered: 0, top: 0, productPages: 0 },
        text: "По вашему запросу не нашёл торговых страниц. Попробуй уточнить запрос (бренд/модель).",
      });
    }

    if (!looksLikeProductPage(picked.url)) {
      const productPages = top.filter((r) => looksLikeProductPage(r?.url)).length;
      return res.json({
        query: queryText,
        picked: null,
        product: null,
        results: top,
        debug: { total: filtered.length, filtered: filtered.length, top: top.length, productPages },
        text:
          "Нашёл только страницы каталогов/поиска, а не карточку товара. Уточни запрос (бренд + модель + объем/цвет), например: 'Samsung S24 8/256 купить'.",
      });
    }

    let product = null;
    const wbId = extractWbExternalIdFromUrl(picked.url);
    if (wbId) {
      product = await getWildberriesProductByExternalId(wbId);
    }

    const outProduct = product
      ? product
      : {
          title: picked.title,
          url: picked.url,
          snippet: picked.snippet,
        };

    let text = "";
    try {
      text = await geminiText({
        system:
          "You are a shopping assistant in Russian. The user wants a specific product recommendation. Use ONLY the provided URLs. Recommend the picked product first, mention rating/reviews/price if available, and then suggest 1-2 alternatives from the list. Be concise.",
        user: JSON.stringify(
          {
            query: queryText,
            picked: outProduct,
            alternatives: top.filter((r) => r.url !== picked.url).slice(0, 4),
          },
          null,
          2
        ),
      });
    } catch {
      text = `Рекомендую: ${outProduct.title || "товар"}. Ссылка: ${outProduct.url}`;
    }

    res.json({
      query: queryText,
      picked,
      product: outProduct,
      results: top,
      text,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/web/search", async (req, res) => {
  try {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return res.status(400).json({ error: "query is required" });
    const results = await duckDuckGoSearch(q);
    res.json({ query: q, results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/assistant/web", async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    const queryText = normalizeQuery(message);
    const q = queryText ? `${queryText} купить цена заказать` : queryText;
    const results = await duckDuckGoSearch(q);
    const filtered = results.filter(isMarketplaceResult);
    const top = filtered.slice(0, 5);

    let text = "";
    try {
      text = await geminiText({
        system:
          "You are a helpful shopping assistant in Russian. Based ONLY on the provided search results, pick the best 1-3 links and explain briefly. IMPORTANT: do NOT invent any URLs; use only URLs present in the input.",
        user: JSON.stringify(
          {
            query: queryText,
            results: top,
          },
          null,
          2
        ),
      });
    } catch {
      text = top.length
        ? top
            .slice(0, 3)
            .map((r, i) => `${i + 1}. ${r.title} — ${r.url}`)
            .join("\n")
        : "Ничего не найдено.";
    }

    res.json({ query: queryText, results: top, text });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/assistant/wb-smart", async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    const externalIdFromUrl = extractWbExternalIdFromText(message);
    const queryText = normalizeQuery(message);

    let results;
    if (externalIdFromUrl) {
      const product = await getWildberriesProductByExternalId(externalIdFromUrl);
      results = product ? [product] : [];
    } else {
      const resultsAll = await searchWildberries(queryText);
      results = (Array.isArray(resultsAll) ? resultsAll : []).slice(0, 10);
    }

    const safe = results.filter((o) => o && o.price != null);
    const prices = safe.map((o) => Number(o.price)).filter((n) => Number.isFinite(n));
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;
    const maxReviews = Math.max(
      1,
      ...results.map((o) => (Number.isFinite(Number(o?.reviewsCount)) ? Number(o.reviewsCount) : 0))
    );

    function clamp01(x) {
      return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    function scoreOffer(o) {
      const rating = Number.isFinite(Number(o?.rating)) ? Number(o.rating) : 0;
      const reviews = Number.isFinite(Number(o?.reviewsCount)) ? Number(o.reviewsCount) : 0;
      const price = Number.isFinite(Number(o?.price)) ? Number(o.price) : null;

      const ratingNorm = clamp01(rating / 5);
      const reviewsNorm = clamp01(Math.log1p(reviews) / Math.log1p(maxReviews));
      const priceNorm =
        price == null || minPrice == null || maxPrice == null || maxPrice === minPrice
          ? 0
          : clamp01((maxPrice - price) / (maxPrice - minPrice));

      const score = 0.45 * ratingNorm + 0.35 * reviewsNorm + 0.2 * priceNorm;

      return {
        externalId: String(o.externalId),
        score,
        rating,
        reviewsCount: reviews,
        price,
        ratingNorm,
        reviewsNorm,
        priceNorm,
      };
    }

    const scored = results.map((o) => ({ offer: o, meta: scoreOffer(o) }));
    scored.sort((a, b) => (b.meta.score ?? -Infinity) - (a.meta.score ?? -Infinity));

    const best = scored[0]?.offer ?? null;
    const top = scored.slice(0, 3).map((x) => x.offer);
    const ranked = {
      strategy: "local",
      weights: { rating: 0.45, reviews: 0.35, price: 0.2 },
      items: scored.map((x) => x.meta),
    };

    let text = "";
    try {
      text = await geminiText({
        system:
          "You are a shopping assistant in Russian. Recommend the best 1-3 Wildberries items. Mention price, rating, number of reviews. IMPORTANT: use ONLY the URLs provided in the input, do not invent any links. Be concise.",
        user: JSON.stringify(
          {
            query: queryText,
            chosen: top,
            rankingInfo: ranked,
          },
          null,
          2
        ),
      });
    } catch (e) {
      const b = best;
      text = b
        ? `Лучший вариант на Wildberries: ${b.title}. Цена: ${b.price} ${b.currency}. Рейтинг: ${b.rating ?? "?"}, отзывов: ${b.reviewsCount ?? "?"}. Ссылка: ${b.url}`
        : "Ничего не нашёл на Wildberries по этому запросу.";
    }

    const b = best;
    if (b) {
      const bestLine = `\n\nЛучший товар: ${b.title}\nЦена: ${b.price} ${b.currency}\nРейтинг: ${b.rating ?? "?"} | Отзывов: ${b.reviewsCount ?? "?"}\nСсылка: ${b.url}`;
      if (!text.includes(String(b.url))) text = `${text}${bestLine}`;
    }

    res.json({
      query: message,
      best,
      top,
      results,
      ranked,
      text,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/assistant/wb", async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    const externalIdFromUrl = extractWbExternalIdFromText(message);
    const queryText = normalizeQuery(message);

    let results;
    if (externalIdFromUrl) {
      const product = await getWildberriesProductByExternalId(externalIdFromUrl);
      results = product ? [product] : [];
    } else {
      results = await searchWildberries(queryText);
    }
    results.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const best = results[0] ?? null;

    const text = best
      ? `Нашёл на Wildberries: ${best.title}. Цена: ${best.price} ${best.currency}. Ссылка: ${best.url}`
      : "Ничего не нашёл на Wildberries по этому запросу.";

    res.json({
      query: queryText,
      best,
      results: results.slice(0, 10),
      text,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return res.status(400).json({ error: "query is required" });

    const limitRaw = req.body?.limit;
    const limit = limitRaw == null ? null : Number(limitRaw);

    const results = await searchWildberries(q);
    results.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    const out = Number.isFinite(limit) ? results.slice(0, Math.max(0, limit)) : results;
    res.json({ query: q, results: out });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/assistant/compare", async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    const data = await compareAssistant(message);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/low-prices", async (req, res) => {
  try {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return res.status(400).json({ error: "query is required" });

    const limitRaw = req.body?.limit;
    const limit = limitRaw == null ? 10 : Number(limitRaw);
    const safeLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, limit)) : 10;

    const results = await searchWildberries(q);
    results.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    res.json({ query: q, results: results.slice(0, safeLimit) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/track", async (req, res) => {
  try {
    const provider = String(req.body?.provider ?? "").trim();
    const externalId = String(req.body?.externalId ?? "").trim();
    const url = String(req.body?.url ?? "").trim();
    const title = String(req.body?.title ?? "").trim();
    const currency = String(req.body?.currency ?? "RUB").trim();
    const price = Number(req.body?.price);
    const targetPrice = req.body?.targetPrice != null ? Number(req.body.targetPrice) : null;
    const chatId = req.body?.chatId != null ? String(req.body.chatId).trim() : null;

    if (!provider || !externalId || !url || !title || !Number.isFinite(price)) {
      return res.status(400).json({ error: "provider, externalId, url, title, price are required" });
    }

    const listingUpsert = await query(
      "INSERT INTO listings(provider, external_id, url, title, currency) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(provider, external_id) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, currency = EXCLUDED.currency RETURNING id",
      [provider, externalId, url, title, currency]
    );

    const listingId = listingUpsert.rows[0].id;

    await query(
      "INSERT INTO price_snapshots(listing_id, price) VALUES ($1,$2)",
      [listingId, price]
    );

    const trackInsert = await query(
      "INSERT INTO tracks(listing_id, target_price) VALUES ($1,$2) RETURNING id",
      [listingId, targetPrice]
    );

    const trackId = trackInsert.rows[0].id;

    if (chatId || process.env.TELEGRAM_CHAT_ID) {
      await query(
        "INSERT INTO telegram_subscriptions(track_id, chat_id) VALUES ($1, $2) ON CONFLICT(track_id, chat_id) DO NOTHING",
        [trackId, chatId || process.env.TELEGRAM_CHAT_ID]
      );
    }

    res.json({ trackId });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/track/:id/history", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const track = await query(
      "SELECT t.id, t.target_price, t.active, l.provider, l.external_id, l.url, l.title, l.currency, l.id AS listing_id FROM tracks t JOIN listings l ON l.id = t.listing_id WHERE t.id = $1",
      [id]
    );

    if (track.rows.length === 0) return res.status(404).json({ error: "not found" });

    const listingId = track.rows[0].listing_id;

    const history = await query(
      "SELECT price, captured_at FROM price_snapshots WHERE listing_id = $1 ORDER BY captured_at DESC LIMIT 100",
      [listingId]
    );

    res.json({ track: track.rows[0], history: history.rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`server listening on ${port}`);
  startMonitor();
});
