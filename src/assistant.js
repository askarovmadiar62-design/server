import { searchWildberries } from "./providers/wildberries.js";
import { searchKaspi } from "./providers/kaspi.js";
import { geminiJson, geminiText } from "./ai/gemini.js";

function tokenize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function groupOffers(offers, canonicalTokens) {
  const groups = [];

  for (const offer of offers) {
    const t = tokenize(offer.title);
    const score = jaccard(t, canonicalTokens);

    let placed = false;
    for (const g of groups) {
      const s2 = jaccard(t, g.tokens);
      if (Math.max(score, s2) >= 0.35) {
        g.offers.push(offer);
        g.offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.push({
        key: offer.title,
        tokens: t,
        offers: [offer],
      });
    }
  }

  for (const g of groups) {
    g.best = g.offers[0];
  }

  groups.sort((a, b) => (a.best?.price ?? Infinity) - (b.best?.price ?? Infinity));
  return groups;
}

export async function compareAssistant(userMessage) {
  const q = String(userMessage ?? "").trim();
  if (!q) throw new Error("message is required");

  const normalized = await geminiJson({
    system:
      "You help normalize shopping product queries for Kazakhstan (KZ). Extract canonical name and key attributes.",
    user:
      `Normalize this query for product search: ${q}`,
    schemaHint:
      "{ canonical: string, brand?: string, model?: string, storage?: string, color?: string, keywords: string[] }",
  });

  const canonical = String(normalized?.canonical ?? q).trim();
  const keywords = Array.isArray(normalized?.keywords) ? normalized.keywords.map(String) : [];
  const canonicalTokens = tokenize([canonical, ...keywords].join(" "));

  const providerErrors = {};
  const offers = [];

  try {
    const wb = await searchWildberries(canonical);
    offers.push(...wb);
  } catch (e) {
    providerErrors.wildberries = String(e?.message ?? e);
  }

  try {
    const kaspi = await searchKaspi(canonical);
    offers.push(...kaspi);
  } catch (e) {
    providerErrors.kaspi = String(e?.message ?? e);
  }

  offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  const groups = groupOffers(offers, canonicalTokens);
  const topGroups = groups.slice(0, 5).map((g, idx) => ({
    groupId: idx + 1,
    best: g.best,
    offers: g.offers.slice(0, 5),
  }));

  const explanation = await geminiText({
    system:
      "You are a shopping assistant. Provide a short recommendation in Russian for KZ. Mention if some sources failed.",
    user: JSON.stringify(
      {
        userQuery: q,
        canonical,
        top: topGroups.map((g) => ({
          groupId: g.groupId,
          best: g.best,
        })),
        providerErrors,
      },
      null,
      2
    ),
  });

  return {
    userQuery: q,
    normalized,
    canonical,
    providerErrors,
    topGroups,
    explanation,
  };
}
