-- shop_items.sql — Hardened, idempotent upgrade for RETRO GAMES shop items
-- Target: PostgreSQL 13+ / Neon-compatible
--
-- Contract kept:
--   • Table name: shop_items
--   • Existing columns keep meaning (sku, name, description, price_coins, image_url,
--     active, created_at, stock, metadata, updated_at).
--   • No destructive changes; only additive/backfill/constraints that are NULL-tolerant.
--
-- Enhancements (wallet C안 완전 대응):
--   • Effect-style items (item_type / effect_key / effect_value / effect_duration_minutes).
--   • effect_payload JSONB 추가로, 다양한 보상(코인/티켓/exp/plays 등)을 유연하게 표현.
--   • 코인/티켓 기반 가격 분리: price_coins + price_tickets + price_type('coins'|'tickets'|'mixed').
--   • Robust defaults, guards (non-negative pricing/values, SKU normalization assistance).
--   • Operational fields: sort_order, tags (JSONB), visibility windows, soft archive.
--   • Updated `updated_at` trigger (idempotent).
--   • Index suite for list/search/buy paths (active/stock/sort, text search helpers, JSONB GIN).
--   • All steps are idempotent (safe to re-run).

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 0) Extensions used by this schema (safe to re-run)
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- future-proofing for case-insensitive lookups

/* ──────────────────────────────────────────────────────────────────────
 * 1) Column backfills (add only if missing)
 *    Notes:
 *      - Do NOT change types of existing columns.
 *      - Only add nullable columns or columns with safe defaults.
 *      - wallet C안 구조: coins + tickets + exp + games_played 와 상점 아이템을 연결하기 위한
 *        가격/효과 설정 컬럼을 확장한다.
 * ──────────────────────────────────────────────────────────────────── */

-- Effect-style items (NULL = not an effect)
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS item_type                 TEXT,      -- 'cosmetic' | 'booster' | 'ticket' | 'life' | 'bundle' (see CHECK below)
  ADD COLUMN IF NOT EXISTS effect_key                TEXT,
  ADD COLUMN IF NOT EXISTS effect_value              NUMERIC,
  ADD COLUMN IF NOT EXISTS effect_duration_minutes   INT,
  ADD COLUMN IF NOT EXISTS effect_payload            JSONB;     -- wallet C안용 복합 효과(payload) (예: {coins_delta, tickets_delta, exp_delta,...})

-- Commercial path safety: ensure price/sku exist (keep original if already present)
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS price_coins   NUMERIC,  -- keep NUMERIC for compatibility; guarded by CHECK below
  ADD COLUMN IF NOT EXISTS sku           TEXT;

-- C안: 티켓 기반 가격 확장 (coins만 쓰던 구조 → coins + tickets + 혼합)
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS price_tickets BIGINT,   -- NULL = 티켓 가격 없음
  ADD COLUMN IF NOT EXISTS price_type    TEXT;     -- 'coins' | 'tickets' | 'mixed' (NULL = 레거시/자동 판별)

-- Operational & UX helpers
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS stock         BIGINT,                             -- NULL = unlimited
  ADD COLUMN IF NOT EXISTS metadata      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS active        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sort_order    INT,
  ADD COLUMN IF NOT EXISTS tags          JSONB   NOT NULL DEFAULT '[]'::jsonb,  -- e.g., ["limited","event"]
  ADD COLUMN IF NOT EXISTS visible_from  TIMESTAMPTZ,                          -- optional sale windows
  ADD COLUMN IF NOT EXISTS visible_to    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived      BOOLEAN NOT NULL DEFAULT FALSE,       -- soft archive (hide from lists)
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now();   -- 일부 레거시 스키마 보강용

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
      CHECK (item_type IS NULL OR item_type IN ('cosmetic','booster','ticket','life','bundle'));
  END IF;

  -- Allowed price_type values (NULL allowed for legacy)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_price_type_allowed') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_price_type_allowed
      CHECK (price_type IS NULL OR price_type IN ('coins','tickets','mixed'));
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_price_coins_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_price_coins_nonneg
      CHECK (price_coins IS NULL OR price_coins >= 0);
  END IF;

  -- Non-negative ticket price (NULL = no ticket price)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_price_tickets_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_price_tickets_nonneg
      CHECK (price_tickets IS NULL OR price_tickets >= 0);
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

  -- Basic SKU sanity (길이/문자 패턴) – NULL 허용
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_sku_format') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_sku_format
      CHECK (
        sku IS NULL
        OR sku ~ '^[A-Za-z0-9][A-Za-z0-9_\-]{0,127}$'   -- 1..128 chars, alnum + _-
      );
  END IF;
END $$;

/* ──────────────────────────────────────────────────────────────────────
 * 3) updated_at maintenance trigger (idempotent)
 * ──────────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION set_updated_at_shop_items() RETURNS TRIGGER AS $$
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
             EXECUTE FUNCTION set_updated_at_shop_items()';
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
    SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND c.relname = 'ux_shop_items_sku'
  ) THEN
    -- NOTE: If duplicates exist, this will fail; resolve dupes before re-running.
    CREATE UNIQUE INDEX ux_shop_items_sku ON shop_items(sku) WHERE sku IS NOT NULL;
  END IF;
END $$;

-- Helper for case-insensitive SKU lookups (search)
CREATE INDEX IF NOT EXISTS ix_shop_items_lower_sku
  ON shop_items (lower(sku))
  WHERE sku IS NOT NULL;

-- Active + archive filtering
CREATE INDEX IF NOT EXISTS ix_shop_items_active_archived
  ON shop_items (active, archived);

-- Visibility window filtering
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

-- 가격 기반 정렬/필터링
CREATE INDEX IF NOT EXISTS ix_shop_items_price_coins
  ON shop_items (price_coins);

CREATE INDEX IF NOT EXISTS ix_shop_items_price_tickets
  ON shop_items (price_tickets);

CREATE INDEX IF NOT EXISTS ix_shop_items_price_type
  ON shop_items (price_type);

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
COMMENT ON TABLE  shop_items IS 'Storefront items for Retro Games (coins/tickets/boosters, wallet C안 호환).';

COMMENT ON COLUMN shop_items.item_type               IS 'Effect style: cosmetic|booster|ticket|life|bundle (NULL for normal items).';
COMMENT ON COLUMN shop_items.effect_key              IS 'Effect key for boosters (e.g., coins_delta, tickets_delta, exp_delta, life, skin_id).';
COMMENT ON COLUMN shop_items.effect_value            IS 'Effect magnitude; non-negative. Used with effect_key when scalar is enough.';
COMMENT ON COLUMN shop_items.effect_duration_minutes IS 'Effect duration in minutes; NULL for perpetual or one-time.';
COMMENT ON COLUMN shop_items.effect_payload          IS 'JSONB payload for complex effects (wallet C안: coins/tickets/exp/plays deltas, etc.).';

COMMENT ON COLUMN shop_items.price_coins             IS 'Price in coins; NULL permitted for legacy but recommended ≥ 0 when price_type=coins/mixed.';
COMMENT ON COLUMN shop_items.price_tickets           IS 'Price in tickets; NULL when not required; used when price_type=tickets/mixed.';
COMMENT ON COLUMN shop_items.price_type              IS 'Pricing currency type: coins|tickets|mixed (NULL = legacy behavior).';

COMMENT ON COLUMN shop_items.tags                    IS 'JSON array of tags for filtering (e.g., ["limited","event","featured"]).';
COMMENT ON COLUMN shop_items.visible_from            IS 'Optional visibility start time.';
COMMENT ON COLUMN shop_items.visible_to              IS 'Optional visibility end time.';
COMMENT ON COLUMN shop_items.archived                IS 'Soft archive flag; TRUE hides from storefront (admin-only view).';
COMMENT ON COLUMN shop_items.sort_order              IS 'Optional manual ordering key (ascending; NULLS LAST).';

COMMENT ON COLUMN shop_items.sku                     IS 'Public item identifier; unique when present; normalized alnum+_- pattern.';
COMMENT ON COLUMN shop_items.name                    IS 'Display name of the item.';
COMMENT ON COLUMN shop_items.description             IS 'Optional long text description shown in shop UI.';
COMMENT ON COLUMN shop_items.image_url               IS 'Optional image URL (CDN, object storage, etc.).';

COMMENT ON COLUMN shop_items.stock                   IS 'NULL = unlimited; otherwise non-negative available quantity.';
COMMENT ON COLUMN shop_items.metadata                IS 'Free-form JSONB for storefront/ops (flags, internal notes, analytics).';
COMMENT ON COLUMN shop_items.updated_at              IS 'Auto-updated timestamp via trigger.';
COMMENT ON COLUMN shop_items.created_at              IS 'Creation timestamp (backfilled if missing).';
COMMENT ON COLUMN shop_items.active                  IS 'If FALSE, item is hidden from normal storefront queries.';

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
-- BEGIN;
-- DROP INDEX IF EXISTS ix_shop_items_tags_gin;
-- DROP INDEX IF EXISTS ix_shop_items_metadata_gin;
-- DROP INDEX IF EXISTS ix_shop_items_image_url;
-- DROP INDEX IF EXISTS ix_shop_items_price_type;
-- DROP INDEX IF EXISTS ix_shop_items_price_tickets;
-- DROP INDEX IF EXISTS ix_shop_items_price_coins;
-- DROP INDEX IF EXISTS ix_shop_items_name;
-- DROP INDEX IF EXISTS ix_shop_items_sort;
-- DROP INDEX IF EXISTS ix_shop_items_stock;
-- DROP INDEX IF EXISTS ix_shop_items_visibility;
-- DROP INDEX IF EXISTS ix_shop_items_active_archived;
-- DROP INDEX IF EXISTS ix_shop_items_lower_sku;
-- DROP INDEX IF EXISTS ux_shop_items_sku;
-- DROP TRIGGER IF EXISTS tr_shop_items_set_updated_at ON shop_items;
-- DROP FUNCTION IF EXISTS set_updated_at_shop_items;
-- ALTER TABLE shop_items
--   DROP COLUMN IF EXISTS archived,
--   DROP COLUMN IF EXISTS visible_to,
--   DROP COLUMN IF EXISTS visible_from,
--   DROP COLUMN IF EXISTS tags,
--   DROP COLUMN IF EXISTS sort_order,
--   DROP COLUMN IF EXISTS updated_at,
--   DROP COLUMN IF EXISTS metadata,
--   DROP COLUMN IF EXISTS stock,
--   DROP COLUMN IF EXISTS created_at,
--   DROP COLUMN IF EXISTS price_type,
--   DROP COLUMN IF EXISTS price_tickets,
--   DROP COLUMN IF EXISTS sku,
--   DROP COLUMN IF EXISTS price_coins,
--   DROP COLUMN IF EXISTS effect_payload,
--   DROP COLUMN IF EXISTS effect_duration_minutes,
--   DROP COLUMN IF EXISTS effect_value,
--   DROP COLUMN IF EXISTS effect_key,
--   DROP COLUMN IF EXISTS item_type;
-- COMMIT;
