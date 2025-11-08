-- 003_shop_effects.sql — Inventory, effects, and shop hardening (idempotent)
-- Target: PostgreSQL 13+ / Neon compatible
--
-- Goals (without changing existing app behavior):
--   1) Create persistent user item storage (user_inventory).
--   2) Create duration/multiplier-based user effects (user_effects).
--   3) Backfill shop_items with columns that specials/shop code expects:
--        stock, metadata, updated_at  (do not auto-decrement here).
--   4) Create shop_orders for purchase records.
--   5) Add practical indexes and safe constraints.
--   6) Provide lightweight “updated_at” trigger helper (if missing) and
--      attach it to tables that benefit from last-modified tracking.
--
-- Design principles:
--   • Fully idempotent: safe to run multiple times.
--   • No business-logic change: we DO NOT auto-decrement stock here.
--     (That belongs in application/service code.)
--   • Conservative checks (non-negative numbers, quantity > 0).
--   • Friendly to read-only replicas and migration replays.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- Extensions
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ──────────────────────────────────────────────────────────────────────
-- Shared helper: updated_at trigger function (create if missing)
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
       AND p.proname = 'set_updated_at'
  ) THEN
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $F$
    BEGIN
      NEW.updated_at := NOW();
      RETURN NEW;
    END
    $F$ LANGUAGE plpgsql;
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 1) USER INVENTORY — persistent, countable items per user
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_inventory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  qty         INT  NOT NULL DEFAULT 1 CHECK (qty >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent (user_id, item_id) duplication (count via qty instead)
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_inventory_user_item
  ON user_inventory(user_id, item_id);

-- Common access patterns
CREATE INDEX IF NOT EXISTS idx_user_inventory_user
  ON user_inventory(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_inventory_item
  ON user_inventory(item_id);

-- Attach updated_at trigger (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'user_inventory_set_updated_at'
  ) THEN
    CREATE TRIGGER user_inventory_set_updated_at
    BEFORE UPDATE ON user_inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 2) USER EFFECTS — timed / multiplier buffs
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_effects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect_key  TEXT NOT NULL,       -- e.g., 'coins_multiplier', 'xp_multiplier'
  value       NUMERIC NOT NULL,    -- e.g., 2.0  (x2)
  expires_at  TIMESTAMPTZ,         -- NULL = permanent
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep a single row per user/effect_key (latest overrides)
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_effect
  ON user_effects(user_id, effect_key);

CREATE INDEX IF NOT EXISTS idx_user_effects_expiry
  ON user_effects(expires_at);

-- Attach updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'user_effects_set_updated_at'
  ) THEN
    CREATE TRIGGER user_effects_set_updated_at
    BEFORE UPDATE ON user_effects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 3) SHOP ITEMS — fill missing columns expected by specials/shop code
--    (We DO NOT change pricing or stock logic; only provide columns
--     and minimal constraints. Stock NULL = unlimited.)
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS stock      BIGINT,                                    -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Basic sanity: price_coins non-negative already in base schema; add
-- a gentle check on stock as present (cannot be negative when set).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'ck_shop_items_stock_nonneg'
  ) THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_stock_nonneg
      CHECK (stock IS NULL OR stock >= 0);
  END IF;
END
$$;

-- Read patterns for catalog pages / stock checks
CREATE INDEX IF NOT EXISTS idx_shop_items_active
  ON shop_items(active);

CREATE INDEX IF NOT EXISTS idx_shop_items_stock
  ON shop_items(stock);

-- Attach updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'shop_items_set_updated_at'
  ) THEN
    CREATE TRIGGER shop_items_set_updated_at
    BEFORE UPDATE ON shop_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 4) SHOP ORDERS — immutable purchase ledger
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  item_id      UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  quantity     INT   NOT NULL CHECK (quantity > 0),
  price_total  BIGINT NOT NULL CHECK (price_total >= 0),
  -- optional request correlation key can be added by app later
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent orders by user (history / receipts)
CREATE INDEX IF NOT EXISTS idx_shop_orders_user_created
  ON shop_orders(user_id, created_at DESC);

-- Item sales (analytics)
CREATE INDEX IF NOT EXISTS idx_shop_orders_item
  ON shop_orders(item_id);

-- ──────────────────────────────────────────────────────────────────────
-- 5) USER STATS — ensure updated_at column exists (upserts rely on it)
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'user_stats_set_updated_at'
  ) THEN
    CREATE TRIGGER user_stats_set_updated_at
    BEFORE UPDATE ON user_stats
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 6) (Optional) Convenience view for public shop listing
--    Keeps app JSON simple while letting DB hold metadata/stock.
--    Purely additive; callers may ignore.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_shop_items_public AS
SELECT
  id,
  sku,
  name,
  description,
  price_coins,
  image_url,
  active,
  stock,
  metadata,
  created_at,
  updated_at
FROM shop_items;

COMMIT;

-- Notes:
--  • If you later decide to enforce “no oversell” at the DB level,
--    add a DEFERRABLE constraint or a transaction + stock decrement in
--    the application/service layer. This migration intentionally avoids
--    altering runtime semantics to remain backward compatible.
--  • All objects above are idempotent and safe to re-run.
