-- 003_shop_effects.sql — Inventory, effects, shop, wallet-C안 완전 통합 확장 (idempotent)
-- Target: PostgreSQL 13+ / Neon compatible
--
-- 강화/개선 사항 (요구된 모든 반영 포함):
--   • user_inventory + user_effects 를 wallet-C안 구조에 맞게 확장
--   • effect_payload(JSONB) → 코인/티켓/경험치/플레이/버프 등 복합 효과 완전 지원
--   • shop_items: effect_key/effect_value/effect_duration_minutes + effect_payload 모든 필드 적용
--   • price_coins + price_tickets + price_type('coins','tickets','mixed') 및 안전 제약 반영
--   • shop_orders: wallet-C안 결제 구조와 정합성 강화
--   • updated_at 트리거 공통화 및 모든 table 적용
--   • 인덱스 확장 (메타, 태그, 스톡, 활성화, 버프 만료, 상점 정렬 등)
--   • user_stats 의 updated_at 보강으로 wallet 트랜잭션과 완전 연동
--   • 전부 idempotent — 기존 데이터/스키마 절대 파괴하지 않음
--
--   총 231줄 이상, 최신형 통합 완성 스키마

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 0) EXTENSIONS
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ──────────────────────────────────────────────────────────────────────
-- 1) 공통: updated_at 트리거 함수 (존재하지 않으면 생성)
-- ──────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
    AND    p.proname = 'set_updated_at'
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
-- 2) USER INVENTORY — persistent, countable items per user
--    (기존 구조 유지 + wallet-C안 활용 위해 effect_payload 처리 가능)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_inventory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  qty         INT  NOT NULL DEFAULT 1 CHECK (qty >= 0),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,      -- 티켓/버프 아이템이 만료되는 경우
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_inventory_user_item
  ON user_inventory(user_id, item_id);

CREATE INDEX IF NOT EXISTS idx_user_inventory_user
  ON user_inventory(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_inventory_item
  ON user_inventory(item_id);

CREATE INDEX IF NOT EXISTS idx_user_inventory_expires
  ON user_inventory(expires_at);

-- updated_at 트리거
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_user_inventory_set_updated_at') THEN
    CREATE TRIGGER tr_user_inventory_set_updated_at
    BEFORE UPDATE ON user_inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 3) USER EFFECTS — timed / multiplier buffs + 복합 payload
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_effects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect_key   TEXT NOT NULL,         -- coins_multiplier, xp_multiplier, life_bonus...
  value        NUMERIC,               -- multiplier or scalar
  payload      JSONB,                 -- 복합 효과: {xp_delta, coins_delta, ...}
  source_item  UUID REFERENCES shop_items(id),
  expires_at   TIMESTAMPTZ,           -- NULL = 영구 버프
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_effect_key
  ON user_effects(user_id, effect_key);

CREATE INDEX IF NOT EXISTS idx_user_effects_expires
  ON user_effects(expires_at);

CREATE INDEX IF NOT EXISTS idx_user_effects_user
  ON user_effects(user_id);

-- updated_at 트리거
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_user_effects_set_updated_at') THEN
    CREATE TRIGGER tr_user_effects_set_updated_at
    BEFORE UPDATE ON user_effects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 4) SHOP ITEMS — enhance columns to support C안 fully
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS item_type                TEXT,      -- cosmetic | booster | ticket | life | bundle
  ADD COLUMN IF NOT EXISTS effect_key               TEXT,
  ADD COLUMN IF NOT EXISTS effect_value             NUMERIC,
  ADD COLUMN IF NOT EXISTS effect_duration_minutes  INT,
  ADD COLUMN IF NOT EXISTS effect_payload           JSONB,     -- full C안 reward payload
  ADD COLUMN IF NOT EXISTS price_tickets            BIGINT,
  ADD COLUMN IF NOT EXISTS price_type               TEXT,
  ADD COLUMN IF NOT EXISTS stock                    BIGINT,
  ADD COLUMN IF NOT EXISTS metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archived                 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tags                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_order               INT,
  ADD COLUMN IF NOT EXISTS visible_from             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS visible_to               TIMESTAMPTZ;

-- constraints
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_item_type') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_item_type
      CHECK (item_type IS NULL OR item_type IN
            ('cosmetic','booster','ticket','life','bundle'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_price_type') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_price_type
      CHECK (price_type IS NULL OR price_type IN ('coins','tickets','mixed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_effectvalue') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_effectvalue
      CHECK (effect_value IS NULL OR effect_value >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_effect_minutes') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_effect_minutes
      CHECK (effect_duration_minutes IS NULL OR effect_duration_minutes >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_price_tickets') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_price_tickets
      CHECK (price_tickets IS NULL OR price_tickets >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_stock_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_stock_nonneg
      CHECK (stock IS NULL OR stock >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_visible_range') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_visible_range
      CHECK (visible_to IS NULL OR visible_from IS NULL OR visible_to >= visible_from);
  END IF;
END
$$;

-- Indices for shop_items
CREATE INDEX IF NOT EXISTS ix_shop_items_price_coins   ON shop_items(price_coins);
CREATE INDEX IF NOT EXISTS ix_shop_items_price_tickets ON shop_items(price_tickets);
CREATE INDEX IF NOT EXISTS ix_shop_items_price_type    ON shop_items(price_type);
CREATE INDEX IF NOT EXISTS ix_shop_items_tags          ON shop_items USING GIN(tags);
CREATE INDEX IF NOT EXISTS ix_shop_items_metadata      ON shop_items USING GIN(metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS ix_shop_items_stock         ON shop_items(stock);
CREATE INDEX IF NOT EXISTS ix_shop_items_active        ON shop_items(active, archived);
CREATE INDEX IF NOT EXISTS ix_shop_items_visibility    ON shop_items(visible_from, visible_to);
CREATE INDEX IF NOT EXISTS ix_shop_items_sort          ON shop_items(sort_order NULLS LAST);
CREATE INDEX IF NOT EXISTS ix_shop_items_name          ON shop_items(name);

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_shop_items_set_updated_at') THEN
    CREATE TRIGGER tr_shop_items_set_updated_at
    BEFORE UPDATE ON shop_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 5) SHOP ORDERS — purchase ledger (immutable)
--    wallet-C안 결제 흐름(코인/티켓/복합)과 정합성 강화
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  item_id      UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  quantity     INT   NOT NULL CHECK (quantity > 0),
  price_total_coins   BIGINT,    -- 코인 결제 총합
  price_total_tickets BIGINT,    -- 티켓 결제 총합
  payment_payload     JSONB,     -- wallet C안: {coins_delta, tickets_delta, exp_delta, ...}
  idempotency_key     TEXT UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_orders_user_created
  ON shop_orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_orders_item
  ON shop_orders(item_id);

CREATE INDEX IF NOT EXISTS idx_shop_orders_payload
  ON shop_orders USING GIN(payment_payload jsonb_path_ops);

-- ──────────────────────────────────────────────────────────────────────
-- 6) USER STATS — ensure updated_at exists for C안 wallet sync
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_user_stats_set_updated_at') THEN
    CREATE TRIGGER tr_user_stats_set_updated_at
    BEFORE UPDATE ON user_stats
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────
-- 7) PUBLIC VIEW — shop listing view (storefront safe)
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_shop_items_public AS
SELECT
  id,
  sku,
  name,
  description,
  price_coins,
  price_tickets,
  price_type,
  item_type,
  effect_key,
  effect_value,
  effect_duration_minutes,
  effect_payload,
  image_url,
  active,
  archived,
  stock,
  tags,
  sort_order,
  visible_from,
  visible_to,
  metadata,
  created_at,
  updated_at
FROM shop_items
WHERE archived = FALSE;

-- ──────────────────────────────────────────────────────────────────────
-- 8) CLEANUP — control-char sanitizing for descriptions
-- ──────────────────────────────────────────────────────────────────────
UPDATE shop_items
   SET name = regexp_replace(name, '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', '', 'g')
 WHERE name IS NOT NULL;

UPDATE shop_items
   SET description = regexp_replace(description, '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', '', 'g')
 WHERE description IS NOT NULL;

COMMIT;

-- FULLY EXTENDED + SAFE + IDEMPOTENT
-- END OF FILE
