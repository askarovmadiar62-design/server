function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for kaspi provider`);
  return v;
}

function normalizePrice(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/\s+/g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

export async function searchKaspi(query) {
  const base = requiredEnv("KASPI_SEARCH_ENDPOINT");
  const q = String(query ?? "").trim();
  if (!q) return [];

  const url = new URL(base);
  url.searchParams.set("q", q);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kaspi search failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const items = data?.items ?? data?.data ?? data?.products ?? [];

  return (Array.isArray(items) ? items : []).slice(0, 20).map((p) => {
    const externalId = String(p?.id ?? p?.code ?? p?.sku ?? "").trim();
    const title = String(p?.title ?? p?.name ?? "").trim();
    const url = String(p?.url ?? p?.link ?? "").trim();
    const price = normalizePrice(p?.price ?? p?.salePrice ?? p?.currentPrice);

    return {
      provider: "kaspi",
      externalId,
      title,
      url,
      price,
      currency: "KZT",
    };
  }).filter((x) => x.externalId && x.title && x.url && x.price != null);
}
