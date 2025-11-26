-- 003_shop_effects.sql — Inventory, effects, shop, wallet-C안 완전 통합 확장 (idempotent)
-- Target: PostgreSQL 13+ / Neon compatible
--
-- 강화/개선 사항 (요구된 모든 반영 + 최신 설계 반영):
--   • user_inventory          : 회원별 보유 아이템(스킨/소모품/패키지 등) 관리
--   • user_effects            : 버프/배수 효과(코인/경험치/티켓 등) 및 payload 기반 복합 효과
--   • shop_items              : wallet C안 구조에 맞춘 효과/가격/지갑 델타/인벤토리 증정까지 완전 대응
--   • shop_orders             : 코인/티켓/복합 결제 및 wallet 트랜잭션 메타 기록
--   • user_stats.updated_at   : wallet 트랜잭션/게임 보상과 계정 스탯 동기화
--   • 공통 set_updated_at()   : updated_at 자동 갱신용 트리거 함수 (다수 테이블에서 공유)
--   • 전부 idempotent        : 기존 데이터/스키마 절대 파괴하지 않음 (안전하게 여러 번 실행 가능)
--
--   이 파일은 migrations/shop_items.sql 과도 정합성이 맞도록 설계되었으며,
--   중복 ALTER/INDEX 는 모두 IF NOT EXISTS 로 보호된다.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- 0) EXTENSIONS
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ──────────────────────────────────────────────────────────────────────
-- 1) 공통: updated_at 트리거 함수 (존재하지 않으면 생성)
--    - 여러 테이블(user_inventory, user_effects, user_stats, 일부 shop_* 등)에 재사용
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
--    (스킨/소모품/패키지 등, 수량/만료/메타 포함)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_inventory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  qty         INT  NOT NULL DEFAULT 1 CHECK (qty >= 0),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 중복 없이 user + item 기준으로 1 row 에 수량 관리
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

COMMENT ON TABLE  user_inventory IS 'Per-user owned items (skins, consumables, bundles) with quantity/expiry.';
COMMENT ON COLUMN user_inventory.user_id     IS 'Owner user id (UUID, fk users.id).';
COMMENT ON COLUMN user_inventory.item_id     IS 'Shop item id (UUID, fk shop_items.id).';
COMMENT ON COLUMN user_inventory.qty         IS 'Quantity owned (>= 0).';
COMMENT ON COLUMN user_inventory.metadata    IS 'Extra payload (acquire source, notes, etc.).';
COMMENT ON COLUMN user_inventory.expires_at  IS 'Optional expiry timestamp for time-limited items.';
COMMENT ON COLUMN user_inventory.acquired_at IS 'When this inventory entry was created.';
COMMENT ON COLUMN user_inventory.updated_at  IS 'Auto-updated via trigger.';

-- ──────────────────────────────────────────────────────────────────────
-- 3) USER EFFECTS — timed / multiplier buffs + 복합 payload
--    /api/games/score.ts 에서 coins_multiplier / xp_multiplier 등 조회
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_effects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect_key   TEXT NOT NULL,         -- coins_multiplier, xp_multiplier, tickets_multiplier, extra_life...
  value        NUMERIC,               -- multiplier or scalar
  payload      JSONB,                 -- 복합 효과: {xp_delta, coins_delta, tickets_delta, plays_delta ...}
  source_item  UUID REFERENCES shop_items(id), -- 어떤 상점 아이템/이벤트에서 온 버프인지
  expires_at   TIMESTAMPTZ,           -- NULL = 영구 버프
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 한 유저에 같은 effect_key 는 1개만 유지(최신값으로 덮어쓰기)
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_effect_key
  ON user_effects(user_id, effect_key);

CREATE INDEX IF NOT EXISTS idx_user_effects_expires
  ON user_effects(expires_at);

CREATE INDEX IF NOT EXISTS idx_user_effects_user
  ON user_effects(user_id);

CREATE INDEX IF NOT EXISTS idx_user_effects_payload_gin
  ON user_effects USING GIN (payload);

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

COMMENT ON TABLE  user_effects IS 'Active buffs/effects per user (multipliers, timed boosts, extra rewards).';
COMMENT ON COLUMN user_effects.user_id     IS 'Owner user id (UUID, fk users.id).';
COMMENT ON COLUMN user_effects.effect_key  IS 'Logical effect key (coins_multiplier, xp_multiplier, tickets_multiplier, ...).';
COMMENT ON COLUMN user_effects.value       IS 'Numeric scalar (multiplier or value).';
COMMENT ON COLUMN user_effects.payload     IS 'JSONB payload for composite/detailed effects.';
COMMENT ON COLUMN user_effects.source_item IS 'Shop item that granted this effect, if any.';
COMMENT ON COLUMN user_effects.expires_at  IS 'Expiry time; NULL = permanent.';
COMMENT ON COLUMN user_effects.created_at  IS 'Created timestamp.';
COMMENT ON COLUMN user_effects.updated_at  IS 'Auto-updated via trigger.';

-- ──────────────────────────────────────────────────────────────────────
-- 4) SHOP ITEMS — enhance columns to support wallet C안 fully
--    (migrations/shop_items.sql 과 중복되는 부분은 전부 IF NOT EXISTS 로 보호)
-- ──────────────────────────────────────────────────────────────────────

-- 상점 아이템 효과/가격/지갑 델타/인벤토리 증정 확장
ALTER TABLE shop_items
  ADD COLUMN IF NOT EXISTS item_type                TEXT,      -- cosmetic | booster | ticket | life | bundle | consumable | currency | effect
  ADD COLUMN IF NOT EXISTS effect_key               TEXT,
  ADD COLUMN IF NOT EXISTS effect_value             NUMERIC,
  ADD COLUMN IF NOT EXISTS effect_duration_minutes  INT,
  ADD COLUMN IF NOT EXISTS effect_payload           JSONB,     -- full wallet C안 reward payload
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
  ADD COLUMN IF NOT EXISTS visible_to               TIMESTAMPTZ,
  -- wallet C안과 직접 연결되는 델타 값 (migrations/shop_items.sql 과 동일 타입)
  ADD COLUMN IF NOT EXISTS wallet_coins_delta       NUMERIC,
  ADD COLUMN IF NOT EXISTS wallet_exp_delta         BIGINT,
  ADD COLUMN IF NOT EXISTS wallet_tickets_delta     BIGINT,
  ADD COLUMN IF NOT EXISTS wallet_plays_delta       INT,
  -- 인벤토리형 보상 (상점 아이템 구매 시 인벤토리로 지급)
  ADD COLUMN IF NOT EXISTS inventory_grant_sku      TEXT,
  ADD COLUMN IF NOT EXISTS inventory_grant_count    INT;

-- constraints (NULL friendly)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_item_type') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_item_type
      CHECK (
        item_type IS NULL OR item_type IN
        ('cosmetic','booster','ticket','life','bundle','consumable','currency','effect')
      );
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

  -- wallet 델타 값들: exp/tickets/plays 는 음수 필요가 거의 없으므로 non-negative
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_wallet_exp_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_wallet_exp_nonneg
      CHECK (wallet_exp_delta IS NULL OR wallet_exp_delta >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_wallet_tickets_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_wallet_tickets_nonneg
      CHECK (wallet_tickets_delta IS NULL OR wallet_tickets_delta >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_wallet_plays_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_wallet_plays_nonneg
      CHECK (wallet_plays_delta IS NULL OR wallet_plays_delta >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_shop_items_inventory_grant_count_nonneg') THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT ck_shop_items_inventory_grant_count_nonneg
      CHECK (inventory_grant_count IS NULL OR inventory_grant_count >= 0);
  END IF;
END
$$;

-- 인덱스 (중복은 IF NOT EXISTS 로 보호)
CREATE INDEX IF NOT EXISTS ix_shop_items_price_coins
  ON shop_items(price_coins);

CREATE INDEX IF NOT EXISTS ix_shop_items_price_tickets
  ON shop_items(price_tickets);

CREATE INDEX IF NOT EXISTS ix_shop_items_price_type
  ON shop_items(price_type);

CREATE INDEX IF NOT EXISTS ix_shop_items_tags
  ON shop_items USING GIN(tags);

CREATE INDEX IF NOT EXISTS ix_shop_items_metadata
  ON shop_items USING GIN(metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS ix_shop_items_stock
  ON shop_items(stock);

CREATE INDEX IF NOT EXISTS ix_shop_items_active
  ON shop_items(active, archived);

CREATE INDEX IF NOT EXISTS ix_shop_items_visibility
  ON shop_items(visible_from, visible_to);

CREATE INDEX IF NOT EXISTS ix_shop_items_sort
  ON shop_items(sort_order NULLS LAST);

CREATE INDEX IF NOT EXISTS ix_shop_items_name
  ON shop_items(name);

CREATE INDEX IF NOT EXISTS ix_shop_items_wallet_exp_delta
  ON shop_items(wallet_exp_delta);

CREATE INDEX IF NOT EXISTS ix_shop_items_wallet_tickets_delta
  ON shop_items(wallet_tickets_delta);

CREATE INDEX IF NOT EXISTS ix_shop_items_item_type_price
  ON shop_items(item_type, price_type);

-- updated_at trigger (set_updated_at 또는 set_updated_at_shop_items 중 먼저 만들어진 것을 사용)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_shop_items_set_updated_at') THEN
    CREATE TRIGGER tr_shop_items_set_updated_at
    BEFORE UPDATE ON shop_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

COMMENT ON TABLE  shop_items IS 'Storefront items for Retro Games (coins/tickets/boosters, inventory & wallet C안 호환).';
COMMENT ON COLUMN shop_items.item_type               IS 'Item type: cosmetic|booster|ticket|life|bundle|consumable|currency|effect.';
COMMENT ON COLUMN shop_items.effect_key              IS 'Effect key used for user_effects and in-game logic.';
COMMENT ON COLUMN shop_items.effect_value            IS 'Effect magnitude (non-negative numeric).';
COMMENT ON COLUMN shop_items.effect_duration_minutes IS 'Duration in minutes for timed effects; NULL for permanent.';
COMMENT ON COLUMN shop_items.effect_payload          IS 'JSONB payload representing composite rewards/buffs.';
COMMENT ON COLUMN shop_items.price_tickets           IS 'Ticket price (>= 0; NULL when not used).';
COMMENT ON COLUMN shop_items.price_type              IS 'coins|tickets|mixed (NULL = legacy auto).';
COMMENT ON COLUMN shop_items.wallet_coins_delta      IS 'Direct wallet coins delta applied on purchase.';
COMMENT ON COLUMN shop_items.wallet_exp_delta        IS 'Direct EXP delta applied on purchase.';
COMMENT ON COLUMN shop_items.wallet_tickets_delta    IS 'Direct tickets delta applied on purchase.';
COMMENT ON COLUMN shop_items.wallet_plays_delta      IS 'Play count or life count delta granted on purchase.';
COMMENT ON COLUMN shop_items.inventory_grant_sku     IS 'SKU of inventory item granted when purchasing this item.';
COMMENT ON COLUMN shop_items.inventory_grant_count   IS 'Number of inventory items granted.';

-- ──────────────────────────────────────────────────────────────────────
-- 5) SHOP ORDERS — purchase ledger (immutable)
--    wallet-C안 결제 흐름(코인/티켓/복합)과 정합성 강화
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  item_id             UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
  quantity            INT   NOT NULL CHECK (quantity > 0),
  price_total_coins   BIGINT,    -- 코인 결제 총합
  price_total_tickets BIGINT,    -- 티켓 결제 총합
  payment_payload     JSONB,     -- wallet C안: {coins_delta, tickets_delta, exp_delta, ...}
  idempotency_key     TEXT UNIQUE,
  -- transactions 테이블과 연결(선택): 실제 wallet 트랜잭션 레코드와 매핑
  transaction_id      UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_orders_user_created
  ON shop_orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_orders_item
  ON shop_orders(item_id);

CREATE INDEX IF NOT EXISTS idx_shop_orders_payload
  ON shop_orders USING GIN(payment_payload jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_shop_orders_tx
  ON shop_orders(transaction_id);

COMMENT ON TABLE  shop_orders IS 'Immutable purchase ledger for shop items (coins/tickets/mixed payments).';
COMMENT ON COLUMN shop_orders.user_id             IS 'Purchasing user.';
COMMENT ON COLUMN shop_orders.item_id             IS 'Purchased shop item.';
COMMENT ON COLUMN shop_orders.quantity            IS 'Quantity purchased (>0).';
COMMENT ON COLUMN shop_orders.price_total_coins   IS 'Total coins spent for this order.';
COMMENT ON COLUMN shop_orders.price_total_tickets IS 'Total tickets spent for this order.';
COMMENT ON COLUMN shop_orders.payment_payload     IS 'Detailed wallet delta payload recorded at purchase time.';
COMMENT ON COLUMN shop_orders.idempotency_key     IS 'Idempotency key to prevent double purchase.';
COMMENT ON COLUMN shop_orders.transaction_id      IS 'Optional link to canonical wallet transactions row.';
COMMENT ON COLUMN shop_orders.created_at          IS 'When this order was created.';

-- ──────────────────────────────────────────────────────────────────────
-- 6) USER STATS — ensure updated_at exists for wallet C안 sync
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

COMMENT ON COLUMN user_stats.updated_at IS 'Auto-updated timestamp to sync with wallet/transaction updates.';

-- ──────────────────────────────────────────────────────────────────────
-- 7) PUBLIC VIEW — shop listing view (storefront safe)
--    (민감 정보 없이 프론트에서 필요한 필드만 노출)
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
  wallet_coins_delta,
  wallet_exp_delta,
  wallet_tickets_delta,
  wallet_plays_delta,
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
--    (UI/검색에서의 이상 동작 방지)
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
