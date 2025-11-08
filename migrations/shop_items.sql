-- shop_items.sql — Hardened, idempotent upgrade for RETRO GAMES shop items
-- Target: PostgreSQL 13+ / Neon-compatible
-- Contract kept:
--   • Table name: shop_items
--   • Existing columns keep meaning (sku, name, description, price_coins, image_url, active, created_at, stock, metadata, updated_at).
--   • No destructive changes; only additive/backfill/constraints that are NULL-tolerant.
-- Enhancements:
--   • Effect-style items (item_type/effect_key/effect_value/effect_duration_minutes).
--   • Robust defaults, guards (non-negative pricing/values, SKU normalization assistance).
--   • Operational fields: sort_order, tags (JSONB), visibility windows, soft archive.
--   • Updated `updated_at` trigger (idempotent).
--   • Index suite for list/search/buy paths (active/stock/sort, text search helpers, JSONB GIN).
--   • All steps are idempotent (safe to re-run).

BEGIN;

-- Extensions used by this schema (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- future-proofing for case-insensitive lookups

/* ──────────────────────────────────────────────────────────────────────
 * 1) Column backfills (add only if missing)
 *    Notes:
 *      - Do NOT change types of existing columns.
 *      - Only add nullable columns or columns with safe defaults.
 * ──────────────────────────────────────────────────────────────────── */

-- Effect-style items (NULL = not an effect)
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS item_type                 TEXT,      -- 'cosmetic' | 'booster' | 'ticket' | 'life' (see CHECK below)
  ADD COLUMN IF NOT EXISTS effect_key                TEXT,
  ADD COLUMN IF NOT EXISTS effect_value              NUMERIC,
  ADD COLUMN IF NOT EXISTS effect_duration_minutes   INT;

-- Commercial path safety: ensure price/sku exist (keep original if already present)
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS price_coins NUMERIC,  -- keep NUMERIC for compatibility; guarded by CHECK below
  ADD COLUMN IF NOT EXISTS sku         TEXT;

-- Operational & UX helpers
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS stock       BIGINT,                             -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS metadata    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS active      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sort_order  INT,
  ADD COLUMN IF NOT EXISTS tags        JSONB   NOT NULL DEFAULT '[]'::jsonb,  -- e.g., ["limited","event"]
  ADD COLUMN IF NOT EXISTS visible_from TIMESTAMPTZ,                          -- optional sale windows
  ADD COLUMN IF NOT EXISTS visible_to   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived     BOOLEAN NOT NULL DEFAULT FALSE;        -- soft archive (hide from lists)

-- Backfill SKU for rows missing it (one-way; preserves existing SKUs)
UPDATE shop_items
   SET sku = replace(gen_random_uuid()::text, '-', '')
 WHERE sku IS NULL;

-- Normalize trivial bad SKUs (leading/trailing whitespace)
UPDATE shop_items
   SET sku = NULLIF(btrim(sku), '')
 WHERE sku IS NOT NULL AND btrim(sku) = '' ;

/* ──────────────────────────────────────────────────────────────────────
 * 2) Constraints (added only if not already present)
 *    We keep them NULL-friendly to avoid breaking legacy data.
 * ──────────────────────────────────────────────────────────────────── */
DO $$
BEGIN
  -- Allowed item_type values (NULL allowed)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_item_type_allowed') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_item_type_allowed
      CHECK (item_type IS NULL OR item_type IN ('cosmetic','booster','ticket','life'));
  END IF;

  -- Non-negative effect_value
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_effect_value_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_effect_value_nonneg
      CHECK (effect_value IS NULL OR effect_value >= 0);
  END IF;

  -- Non-negative effect duration
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_effect_minutes_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_effect_minutes_nonneg
      CHECK (effect_duration_minutes IS NULL OR effect_duration_minutes >= 0);
  END IF;

  -- Non-negative price (NULL allowed for legacy)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_price_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_price_nonneg
      CHECK (price_coins IS NULL OR price_coins >= 0);
  END IF;

  -- Non-negative stock (NULL = unlimited)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_stock_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_stock_nonneg
      CHECK (stock IS NULL OR stock >= 0);
  END IF;

  -- Visibility window sanity (to ≥ from)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_visible_range') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_visible_range
      CHECK (visible_to IS NULL OR visible_from IS NULL OR visible_to >= visible_from);
  END IF;
END $$;

/* ──────────────────────────────────────────────────────────────────────
 * 3) updated_at maintenance trigger (idempotent)
 * ──────────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tr_shop_items_set_updated_at'
      AND tgrelid = 'public.shop_items'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER tr_shop_items_set_updated_at
             BEFORE UPDATE ON public.shop_items
             FOR EACH ROW
             EXECUTE FUNCTION set_updated_at()';
  END IF;
END $$;

/* ──────────────────────────────────────────────────────────────────────
 * 4) Index suite (all IF NOT EXISTS)
 *    - Keep SKU fast & unique (when data allows).
 *    - Speed up storefront queries: active, visibility, stock, sort.
 *    - Aid JSONB & text filtering.
 * ──────────────────────────────────────────────────────────────────── */

-- Unique SKU (non-null), common in commerce paths.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind='i' AND c.relname='ux_shop_items_sku'
  ) THEN
    -- NOTE: If duplicates exist, this will fail; resolve dupes before re-running.
    CREATE UNIQUE INDEX ux_shop_items_sku ON shop_items(sku) WHERE sku IS NOT NULL;
  END IF;
END $$;

-- Helper for case-insensitive SKU lookups (search)
CREATE INDEX IF NOT EXISTS ix_shop_items_lower_sku
  ON shop_items (lower(sku))
  WHERE sku IS NOT NULL;

-- Active + visibility window filtering
CREATE INDEX IF NOT EXISTS ix_shop_items_active
  ON shop_items (active, archived);

CREATE INDEX IF NOT EXISTS ix_shop_items_visibility
  ON shop_items (visible_from, visible_to);

-- Stock & sorting
CREATE INDEX IF NOT EXISTS ix_shop_items_stock
  ON shop_items (stock);

CREATE INDEX IF NOT EXISTS ix_shop_items_sort
  ON shop_items (sort_order NULLS LAST);

-- Lightweight text helpers
CREATE INDEX IF NOT EXISTS ix_shop_items_name
  ON shop_items (name);

-- Image URL presence (optional) can help CDN/admin audits
CREATE INDEX IF NOT EXISTS ix_shop_items_image_url
  ON shop_items (image_url);

-- JSONB metadata/tags search
CREATE INDEX IF NOT EXISTS ix_shop_items_metadata_gin
  ON shop_items USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS ix_shop_items_tags_gin
  ON shop_items USING GIN (tags);

/* ──────────────────────────────────────────────────────────────────────
 * 5) Comments (self-documenting)
 * ──────────────────────────────────────────────────────────────────── */
COMMENT ON COLUMN shop_items.item_type               IS 'Effect style: cosmetic|booster|ticket|life (NULL for normal items).';
COMMENT ON COLUMN shop_items.effect_key              IS 'Effect key for boosters (e.g., coins_multiplier, xp_multiplier).';
COMMENT ON COLUMN shop_items.effect_value            IS 'Effect magnitude; non-negative.';
COMMENT ON COLUMN shop_items.effect_duration_minutes IS 'Effect duration in minutes; NULL for perpetual.';
COMMENT ON COLUMN shop_items.tags                    IS 'JSON array of tags for filtering (e.g., ["limited","event"]).';
COMMENT ON COLUMN shop_items.visible_from            IS 'Optional visibility start time.';
COMMENT ON COLUMN shop_items.visible_to              IS 'Optional visibility end time.';
COMMENT ON COLUMN shop_items.archived                IS 'Soft archive flag; TRUE hides from storefront.';
COMMENT ON COLUMN shop_items.sort_order              IS 'Optional manual ordering key (ascending).';
COMMENT ON COLUMN shop_items.sku                     IS 'Public item identifier; unique when present.';
COMMENT ON COLUMN shop_items.price_coins             IS 'Price in coins; NULL permitted for legacy but recommended ≥ 0.';
COMMENT ON COLUMN shop_items.stock                   IS 'NULL = unlimited; otherwise non-negative available quantity.';
COMMENT ON COLUMN shop_items.metadata                IS 'Free-form JSONB for storefront/ops.';
COMMENT ON COLUMN shop_items.updated_at              IS 'Auto-updated timestamp via trigger.';

/* ──────────────────────────────────────────────────────────────────────
 * 6) Gentle data cleanups (optional, non-breaking)
 * ──────────────────────────────────────────────────────────────────── */

-- Trim name/description to remove accidental control chars
UPDATE shop_items
   SET name = regexp_replace(name, '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', '', 'g')
 WHERE name IS NOT NULL;

UPDATE shop_items
   SET description = regexp_replace(description, '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', '', 'g')
 WHERE description IS NOT NULL;

COMMIT;

-- DOWN (optional; run inside a transaction if needed)
-- DROP INDEX IF EXISTS ix_shop_items_tags_gin;
-- DROP INDEX IF EXISTS ix_shop_items_metadata_gin;
-- DROP INDEX IF EXISTS ix_shop_items_image_url;
-- DROP INDEX IF EXISTS ix_shop_items_name;
-- DROP INDEX IF EXISTS ix_shop_items_sort;
-- DROP INDEX IF EXISTS ix_shop_items_stock;
-- DROP INDEX IF EXISTS ix_shop_items_visibility;
-- DROP INDEX IF EXISTS ix_shop_items_active;
-- DROP INDEX IF EXISTS ix_shop_items_lower_sku;
-- DROP INDEX IF EXISTS ux_shop_items_sku;
-- DROP TRIGGER IF EXISTS tr_shop_items_set_updated_at ON shop_items;
-- DROP FUNCTION IF EXISTS set_updated_at;
-- ALTER TABLE shop_items
--   DROP COLUMN IF EXISTS archived,
--   DROP COLUMN IF EXISTS visible_to,
--   DROP COLUMN IF EXISTS visible_from,
--   DROP COLUMN IF EXISTS tags,
--   DROP COLUMN IF EXISTS sort_order,
--   DROP COLUMN IF EXISTS updated_at,
--   DROP COLUMN IF EXISTS metadata,
--   DROP COLUMN IF EXISTS stock,
--   DROP COLUMN IF EXISTS sku,
--   DROP COLUMN IF EXISTS price_coins,
--   DROP COLUMN IF EXISTS effect_duration_minutes,
--   DROP COLUMN IF EXISTS effect_value,
--   DROP COLUMN IF EXISTS effect_key,
--   DROP COLUMN IF EXISTS item_type;
