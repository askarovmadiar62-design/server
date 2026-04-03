function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for sulpak provider`);
  return v;
}

function normalizePrice(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/\s+/g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

export async function searchSulpak(query) {
  const base = requiredEnv("SULPAK_SEARCH_ENDPOINT");
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
    throw new Error(`Sulpak search failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const items = data?.items ?? data?.data ?? data?.products ?? [];

  return (Array.isArray(items) ? items : []).slice(0, 20).map((p) => {
    const externalId = String(p?.id ?? p?.code ?? p?.sku ?? "").trim();
    const title = String(p?.title ?? p?.name ?? "").trim();
    const url = String(p?.url ?? p?.link ?? "").trim();
    const price = normalizePrice(p?.price ?? p?.salePrice ?? p?.currentPrice);

    return {
      provider: "sulpak",
      externalId,
      title,
      url: url.startsWith("http") ? url : (url ? `https://www.sulpak.kz${url}` : ""),
      price,
      currency: "KZT",
    };
  }).filter((x) => x.externalId && x.title && x.url && x.price != null);
}

export async function getSulpakPriceByExternalId(externalId) {
  const base = requiredEnv("SULPAK_PRICE_ENDPOINT");
  const id = String(externalId ?? "").trim();
  if (!id) throw new Error("externalId is required");

  const url = new URL(base);
  url.searchParams.set("id", id);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sulpak price failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const price = normalizePrice(data?.price ?? data?.currentPrice ?? data?.data?.price);
  if (price == null) return null;
  return { price, currency: "KZT" };
}
