CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  normalized_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listings (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price NUMERIC(12,2) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_listing_time
  ON price_snapshots(listing_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS tracks (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  target_price NUMERIC(12,2),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  track_id BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(track_id, chat_id)
);
