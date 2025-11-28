-- 007_shop_items_seed.sql — Default RETRO GAMES shop catalog seed (idempotent)
-- Target: PostgreSQL 13+ / Neon-compatible
--
-- Goals:
--   1) Provide a minimal, always-available shop catalog:
--        • Ticket packs (points → tickets 전환용)
--        • EXP booster items (일정 시간/판수 동안 경험치 배율 증가)
--   2) Respect existing shop_items schema & constraints from:
--        • 001_init.sql
--        • 003_shop_effects.sql
--        • migrations/shop_items.sql (hardened upgrade)
--   3) Seed is fully idempotent:
--        • ON CONFLICT(name) DO UPDATE for stable “upsert” semantics.
--   4) No destructive changes:
--        • 테이블 구조/제약조건은 전혀 변경하지 않음
--        • stock/metadata/tags만 현실적인 값으로 세팅
--
-- Contract / Assumptions:
--   • Table name: shop_items
--   • Important columns (from previous migrations):
--       - name          TEXT UNIQUE NOT NULL       -- item display name
--       - item_type     TEXT                       -- 'cosmetic' | 'booster' | 'ticket' | 'life'
--       - effect_key    TEXT                       -- 'tickets' | 'exp_multiplier' | ...
--       - effect_value  NUMERIC                    -- effect strength (e.g., 5, 1.1)
--       - effect_duration_minutes INT              -- 효과 지속 시간 (분 단위, NULL=영구/즉시)
--       - price_coins  NUMERIC                     -- wallet.points 기반 결제 금액
--       - sku          TEXT                        -- optional, 자동/backfill 가능
--       - stock        BIGINT                      -- NULL = 무제한
--       - metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
--       - active       BOOLEAN NOT NULL DEFAULT TRUE
--       - sort_order   INT
--       - tags         JSONB NOT NULL DEFAULT '[]'::jsonb
--       - visible_from / visible_to TIMESTAMPTZ
--       - archived     BOOLEAN NOT NULL DEFAULT FALSE
--
-- Usage:
--   • Safe to run multiple times (deploy, local dev, staging, prod).
--   • If you later change item names, remember ON CONFLICT(name) 기준이므로
--     “이름이 ID 역할”을 한다고 보면 됨.
-- =====================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 0) Safety check: ensure shop_items exists
--    (We intentionally do NOT create the table here; 001/003 + shop_items.sql
--     가 먼저 적용되어 있어야 함)
-- ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.shop_items') IS NULL THEN
    RAISE EXCEPTION
      'shop_items table does not exist. Apply 001_init.sql, 003_shop_effects.sql, and migrations/shop_items.sql first.';
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────
-- 1) Default catalog definition (CTE 기반, 관리/수정 편의용)
--    - 여기에 있는 행이 “기본 상점 목록”이 됨
--    - 실제 INSERT 는 아래에서 ON CONFLICT(name) DO UPDATE 로 처리
-- ──────────────────────────────────────────────────────────────
WITH default_items AS (
  SELECT *
  FROM (
    VALUES
      -- Ticket Packs: points → tickets
      (
        'Small Ticket Pack',     -- name (UNIQUE)
        'ticket',                -- item_type
        'tickets',               -- effect_key
        5::numeric,              -- effect_value (추가 티켓 수)
        NULL::int,               -- effect_duration_minutes (즉시 지급, 기간 없음)
        500::numeric,            -- price_coins
        1000::bigint,            -- stock (NULL=무제한, 여기선 예시로 1000개)
        jsonb_build_object(
          'label', '티켓 소량 패키지',
          'i18n', jsonb_build_object('ko', '티켓 소량 패키지', 'en', 'Small Ticket Pack'),
          'category', 'ticket_pack',
          'description', '게임 보상용 티켓 5장을 즉시 획득합니다.'
        ),
        true,                    -- active
        10,                      -- sort_order
        jsonb_build_array('ticket','pack','starter')  -- tags
      ),
      (
        'Medium Ticket Pack',
        'ticket',
        'tickets',
        10::numeric,
        NULL::int,
        900::numeric,
        1000::bigint,
        jsonb_build_object(
          'label', '티켓 중간 패키지',
          'i18n', jsonb_build_object('ko', '티켓 중간 패키지', 'en', 'Medium Ticket Pack'),
          'category', 'ticket_pack',
          'description', '티켓 10장을 획득하는 중간 패키지입니다.'
        ),
        true,
        20,
        jsonb_build_array('ticket','pack','value')
      ),
      (
        'Large Ticket Pack',
        'ticket',
        'tickets',
        20::numeric,
        NULL::int,
        1700::numeric,
        1000::bigint,
        jsonb_build_object(
          'label', '티켓 대량 패키지',
          'i18n', jsonb_build_object('ko', '티켓 대량 패키지', 'en', 'Large Ticket Pack'),
          'category', 'ticket_pack',
          'description', '티켓 20장을 한 번에 획득하는 대량 패키지입니다.'
        ),
        true,
        30,
        jsonb_build_array('ticket','pack','best')
      ),

      -- EXP Boosters: 일정 시간 동안 경험치 배율 증가
      (
        'EXP Boost 10%',
        'booster',               -- item_type (CHECK 제약: booster 허용됨)
        'exp_multiplier',        -- effect_key
        1.1::numeric,            -- effect_value (기본 경험치의 1.1배)
        60::int,                 -- effect_duration_minutes (60분)
        1000::numeric,           -- price_coins
        NULL::bigint,            -- stock (NULL = 무제한 판매)
        jsonb_build_object(
          'label', '경험치 10% 부스트',
          'i18n', jsonb_build_object('ko', '경험치 10% 부스트', 'en', 'EXP Boost +10%'),
          'category', 'exp_boost',
          'description', '60분 동안 게임에서 얻는 경험치가 10% 증가합니다.',
          'durationGames', 5
        ),
        true,
        40,
        jsonb_build_array('booster','exp','time-limited')
      ),
      (
        'EXP Boost 20%',
        'booster',
        'exp_multiplier',
        1.2::numeric,
        60::int,
        1800::numeric,
        NULL::bigint,
        jsonb_build_object(
          'label', '경험치 20% 부스트',
          'i18n', jsonb_build_object('ko', '경험치 20% 부스트', 'en', 'EXP Boost +20%'),
          'category', 'exp_boost',
          'description', '60분 동안 게임에서 얻는 경험치가 20% 증가합니다.',
          'durationGames', 5
        ),
        true,
        50,
        jsonb_build_array('booster','exp','premium','time-limited')
      )
  ) AS t (
    name,
    item_type,
    effect_key,
    effect_value,
    effect_duration_minutes,
    price_coins,
    stock,
    metadata,
    active,
    sort_order,
    tags
  )
)

-- ──────────────────────────────────────────────────────────────
-- 2) Upsert into shop_items
--    - name 기준 ON CONFLICT
--    - 기존 metadata/tags 를 최대한 유지하면서 병합
-- ──────────────────────────────────────────────────────────────
INSERT INTO shop_items (
  name,
  item_type,
  effect_key,
  effect_value,
  effect_duration_minutes,
  price_coins,
  stock,
  metadata,
  active,
  sort_order,
  tags
)
SELECT
  di.name,
  di.item_type,
  di.effect_key,
  di.effect_value,
  di.effect_duration_minutes,
  di.price_coins,
  di.stock,
  di.metadata,
  di.active,
  di.sort_order,
  di.tags
FROM default_items AS di
ON CONFLICT (name) DO UPDATE
SET
  item_type               = EXCLUDED.item_type,
  effect_key              = EXCLUDED.effect_key,
  effect_value            = EXCLUDED.effect_value,
  effect_duration_minutes = EXCLUDED.effect_duration_minutes,
  price_coins             = EXCLUDED.price_coins,
  -- stock 은 NULL(무제한)로 손댈지, seed 기준으로 맞출지 프로젝트 정책에 따라 다름.
  -- 여기서는 “NULL → seed 값”, “이미 값이 있으면 그대로 유지(<= 기존 운영 데이터 우선)” 전략을 사용.
  stock                   = COALESCE(shop_items.stock, EXCLUDED.stock),
  active                  = EXCLUDED.active,
  sort_order              = EXCLUDED.sort_order,
  -- metadata/tags 는 기존에 값이 있으면 지우지 않고 병합
  metadata                = COALESCE(shop_items.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  tags                    = (
                              CASE
                                WHEN shop_items.tags IS NULL OR jsonb_typeof(shop_items.tags) <> 'array'
                                  THEN EXCLUDED.tags
                                ELSE shop_items.tags || EXCLUDED.tags
                              END
                            );

COMMIT;

-- Notes:
--   • 이 seed 는 상점 “기본 카탈로그” 역할만 한다.
--     실제 구매 로직은:
--       - user_wallet.points 차감
--       - user_stats / user_effects 갱신
--       - shop_orders insert
--       - analytics_events('shop_purchase') 기록
--     에서 처리하면 된다.
--   • 이름(name)이 ID 역할을 하므로, 나중에 이름을 바꾸고 싶다면:
--       1) 여기 seed 파일의 name 수정
--       2) 운영 DB 에서도 rename update
--     를 함께 해줘야 충돌/중복을 피할 수 있다.
