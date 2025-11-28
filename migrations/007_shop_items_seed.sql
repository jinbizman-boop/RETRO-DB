-- migrations/007_shop_items_seed.sql
-- ------------------------------------------------------------
-- RETRO GAMES 기본 상점 아이템 Seed (현재 shop_items 스키마용)
--
-- 현재 테이블 컬럼:
--   id, item_key, name, description,
--   price_points, price_tickets,
--   duration_sec, max_stack,
--   is_active, created_at, updated_at
--
-- 목표
--   - ticket_small / medium / large : 티켓 패키지 3종
--   - exp_boost_10 / exp_boost_20   : 경험치 부스트 2종
--   - 여러 번 실행해도 안전하도록 item_key 기준 upsert
-- ------------------------------------------------------------

BEGIN;

-- 0) shop_items 존재 여부 확인
DO $$
BEGIN
  IF to_regclass('public.shop_items') IS NULL THEN
    RAISE EXCEPTION
      'shop_items table does not exist. Apply base migrations first.';
  END IF;
END
$$;

-- 1) item_key 에 유니크 제약이 없으면 추가 (seed 의 기준 key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'shop_items'::regclass
      AND  contype  = 'u'
      AND  conname  = 'shop_items_item_key_unique'
  ) THEN
    ALTER TABLE shop_items
      ADD CONSTRAINT shop_items_item_key_unique UNIQUE (item_key);
  END IF;
END
$$;

-- 2) 기본 아이템 목록 CTE 정의
WITH seed_items AS (
  SELECT *
  FROM (
    VALUES
      -- ① 티켓 패키지 3종
      (
        'ticket_small',                           -- item_key
        '티켓 소량 패키지',                       -- name
        '게임 보상용 티켓 5장을 즉시 획득합니다.', -- description
        500::bigint,                              -- price_points
        0::bigint,                                -- price_tickets (미사용)
        NULL::integer,                            -- duration_sec (영구/즉시)
        0::integer,                               -- max_stack (0 = 제한 없음으로 사용)
        true                                      -- is_active
      ),
      (
        'ticket_medium',
        '티켓 중간 패키지',
        '티켓 10장을 획득하는 중간 패키지입니다.',
        900::bigint,
        0::bigint,
        NULL::integer,
        0::integer,
        true
      ),
      (
        'ticket_large',
        '티켓 대량 패키지',
        '티켓 20장을 한 번에 획득하는 대량 패키지입니다.',
        1700::bigint,
        0::bigint,
        NULL::integer,
        0::integer,
        true
      ),

      -- ② 경험치 부스트 2종 (예시: 1시간 지속)
      (
        'exp_boost_10',
        '경험치 10% 부스트',
        '60분 동안 게임에서 얻는 경험치가 약 10% 증가합니다.',
        1000::bigint,
        0::bigint,
        3600::integer,      -- duration_sec = 60분
        0::integer,
        true
      ),
      (
        'exp_boost_20',
        '경험치 20% 부스트',
        '60분 동안 게임에서 얻는 경험치가 약 20% 증가합니다.',
        1800::bigint,
        0::bigint,
        3600::integer,
        0::integer,
        true
      )
  ) AS t (
    item_key,
    name,
    description,
    price_points,
    price_tickets,
    duration_sec,
    max_stack,
    is_active
  )
)

-- 3) item_key 기준으로 upsert
INSERT INTO shop_items (
  item_key,
  name,
  description,
  price_points,
  price_tickets,
  duration_sec,
  max_stack,
  is_active
)
SELECT
  s.item_key,
  s.name,
  s.description,
  s.price_points,
  s.price_tickets,
  s.duration_sec,
  s.max_stack,
  s.is_active
FROM seed_items AS s
ON CONFLICT (item_key) DO UPDATE
SET
  name          = EXCLUDED.name,
  description   = EXCLUDED.description,
  price_points  = EXCLUDED.price_points,
  price_tickets = EXCLUDED.price_tickets,
  duration_sec  = EXCLUDED.duration_sec,
  max_stack     = EXCLUDED.max_stack,
  is_active     = EXCLUDED.is_active;

COMMIT;
