-- 010_game_runs_slug_unify.sql
-- ------------------------------------------------------------------
-- Purpose
--   • 001_init.sql 의 game_id 기반 game_runs 를
--     slug 기반 스키마와 정합되도록 통일.
--   • game_runs.slug 컬럼을 추가/백필하고,
--     v_leaderboard_top 뷰를 slug 기준으로 재정의.
--   • game_id 는 LEGACY 로 남기되, slug 를 canonical 로 사용.
--
-- Assumptions
--   • public.games(id UUID, slug TEXT UNIQUE) 존재
--   • public.game_runs 는 이미 존재 (001_init.sql 기준)
-- ------------------------------------------------------------------

BEGIN;

-- ───────────────────────────────────────────────────────────────
-- 1) game_runs 에 slug 컬럼 추가 (없을 때만)
-- ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'game_runs'
      AND  column_name  = 'slug'
  ) THEN
    ALTER TABLE game_runs
      ADD COLUMN slug TEXT;
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────────
-- 2) 기존 데이터 slug 백필
--    - game_runs.game_id → games.id 조인해서 games.slug 로 채움
-- ───────────────────────────────────────────────────────────────
-- 2-1) 기본 백필: game_id 와 매칭되는 games.slug 가 있을 때
UPDATE game_runs r
SET    slug = g.slug
FROM   games g
WHERE  r.slug IS NULL
  AND  r.game_id IS NOT NULL
  AND  r.game_id = g.id;

-- 2-2) game_id 는 있으나 games 에 매칭 안 되는 경우가 있을 수 있음.
--      이 경우에는 slug 를 그대로 NULL 로 두고, 애널리틱스에서만 제외되도록 둔다.
--      (필요하면 나중에 수동으로 보정)

-- ───────────────────────────────────────────────────────────────
-- 3) game_id 를 LEGACY 로 명시
-- ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'game_runs'
      AND  column_name  = 'game_id'
  ) THEN
    COMMENT ON COLUMN game_runs.game_id IS
      'LEGACY: originally FK to games(id). Canonical link is game_runs.slug (game slug). 새 코드는 slug 를 기준으로 사용.';
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────────
-- 4) slug 기반 인덱스 추가 (조회/랭킹용)
--    - UNIQUE 로 걸면 기존 중복 데이터 때문에 실패할 수 있으므로,
--      우선은 non-unique 인덱스만 생성.
-- ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_game_runs_user_slug_started
  ON game_runs(user_id, slug, started_at);

CREATE INDEX IF NOT EXISTS ix_game_runs_slug_score_desc_started
  ON game_runs(slug, score DESC, started_at ASC);

-- ───────────────────────────────────────────────────────────────
-- 5) v_leaderboard_top 뷰를 slug 기준으로 재정의
--    - 기존: game_runs.game_id → games.id 조인 후 g.slug 사용
--    - 변경: game_runs.slug 를 직접 사용
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_leaderboard_top AS
WITH runs AS (
  SELECT
    r.slug        AS game_slug,
    r.user_id,
    r.score,
    r.started_at,
    row_number() OVER (
      PARTITION BY r.slug, r.user_id
      ORDER BY r.score DESC, r.started_at ASC
    ) AS rn
  FROM game_runs r
  WHERE r.score IS NOT NULL
)
SELECT
  game_slug,
  user_id,
  score AS top_score
FROM runs
WHERE rn = 1;

COMMENT ON VIEW v_leaderboard_top IS
  'Per-game/ per-user leaderboard view based on game_runs.slug. 한 유저가 각 게임에서 기록한 최고 점수를 노출.';

COMMIT;
