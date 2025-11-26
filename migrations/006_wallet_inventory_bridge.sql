-- 006_wallet_inventory_bridge.sql
-- ------------------------------------------------------------------
-- Purpose
--   1) 정식 wallet_items 테이블을 도입해서 runtime DDL 의존을 제거.
--   2) 003_shop_effects.sql 의 user_inventory 와 스키마를 브리지:
--        - 가능한 경우 user_inventory → wallet_items 로 1회 동기화.
--   3) 인덱스 & updated_at 트리거까지 포함한 “지갑 인벤토리 하드닝”.
--
-- Design
--   • PostgreSQL 13+ / Neon 호환.
--   • 완전 idempotent: 여러 번 실행해도 안전.
--   • 기존 wallet/inventory.ts, wallet/redeem.ts 와 스키마/계약 일치:
--       user_id text, item_id text, qty int, updated_at timestamptz.
--   • 003_shop_effects.sql 의 user_inventory (UUID 기반) 와는
--     직접 FK 연동 대신, “최초 1회 베스트-에포트 복사”만 수행.
-- ------------------------------------------------------------------

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1) WALLET_ITEMS — runtime DDL을 마이그레이션으로 고정
--    (wallet/inventory.ts, wallet/redeem.ts 계약 그대로)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_items (
  user_id    TEXT       NOT NULL,
  item_id    TEXT       NOT NULL,
  qty        INT        NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_items_pkey PRIMARY KEY (user_id, item_id)
);

-- 자주 사용하는 조회 패턴 인덱스 (코드와 동일 이름 유지)
CREATE INDEX IF NOT EXISTS wallet_items_user_idx
  ON wallet_items (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS wallet_items_item_idx
  ON wallet_items (item_id);

-- ─────────────────────────────────────────────────────────────
-- 2) BRIDGE — 기존 user_inventory → wallet_items 베스트-에포트 동기화
--
--    시나리오:
--      • 003_shop_effects.sql 이후 user_inventory 에 데이터가
--        이미 들어있고, wallet_items 는 비어있는 초기 상황일 수 있음.
--      • 이 경우 user_inventory 를 기반으로 wallet_items 를
--        한 번 채워 넣어주면, 새 wallet_* API 와도 자연스럽게 연결.
--
--    주의:
--      • user_inventory.user_id / item_id 는 UUID 타입,
--        wallet_items.user_id / item_id 는 text 타입 → ::text 캐스팅 사용.
--      • wallet_items 에 데이터가 이미 있는 경우에는 “존중”하고,
--        복사는 수행하지 않음.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  has_user_inventory  BOOLEAN := FALSE;
  has_wallet_items    BOOLEAN := FALSE;
  wallet_items_count  BIGINT  := 0;
BEGIN
  -- user_inventory 존재 여부
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'user_inventory'
  )
  INTO has_user_inventory;

  -- wallet_items 존재 여부 (위에서 생성했으므로 TRUE 일 것, 그래도 방어코드)
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'wallet_items'
  )
  INTO has_wallet_items;

  IF has_user_inventory AND has_wallet_items THEN
    -- wallet_items 가 “비어 있는 경우에만” 브리지 수행
    SELECT COUNT(*) INTO wallet_items_count FROM wallet_items;

    IF wallet_items_count = 0 THEN
      BEGIN
        INSERT INTO wallet_items(user_id, item_id, qty, updated_at)
        SELECT
          user_id::text,
          item_id::text,
          qty,
          COALESCE(updated_at, now())
        FROM user_inventory
        ON CONFLICT (user_id, item_id) DO UPDATE
          SET qty        = EXCLUDED.qty,
              updated_at = EXCLUDED.updated_at;
      EXCEPTION
        WHEN others THEN
          -- 타입/데이터 불일치 등 예상치 못한 문제가 있어도
          -- 전체 마이그레이션이 실패하지 않도록 조용히 무시
          NULL;
      END;
    END IF;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────
-- 3) UPDATED_AT 트리거 연결 (있으면 재사용)
--
--    003_shop_effects.sql 에서 정의한 set_updated_at() 함수가
--    이미 존재한다면, wallet_items 도 동일한 패턴으로 관리.
--    • 없으면 아무 것도 하지 않고 통과 (완전 선택적).
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'set_updated_at'
      AND pg_function_is_visible(oid)
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgname = 'wallet_items_set_updated_at'
  ) THEN
      CREATE TRIGGER wallet_items_set_updated_at
      BEFORE UPDATE ON wallet_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
  END IF;
END
$$;

COMMIT;
