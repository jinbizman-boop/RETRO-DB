-- 010_game_runs_slug_unify.sql (v2 - games 테이블이 없을 수도 있는 환경 방어)
-- ------------------------------------------------------------------
-- Purpose
--   • 001_init.sql 의 game_id 기반 game_runs 를
--     slug 기반 스키마와 정합되도록 통일.
--   • game_runs.slug 컬럼을 추가하고,
--     가능하다면 games.slug 로 백필.
--   • v_leaderboard_top 뷰를 slug 기준으로 재정의.
-- ------------------------------------------------------------------

BEGIN;

-- 1) game_runs 에 slug 컬럼 추가 (없을 때만)
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

-- 2) slug 백필 (games 테이블이 있을 때만 안전하게 실행)
DO $$
BEGIN
  IF to_regclass('public.games') IS NOT NULL THEN
    -- games 테이블이 존재하는 경우에만 백필 수행
    EXECUTE $upd$
      UPDATE game_runs r
      SET    slug = g.slug
      FROM   games g
      WHERE  r.slug IS NULL
        AND  r.game_id IS NOT NULL
        AND  r.game_id = g.id;
    $upd$;
  END IF;
  -- games 테이블이 없으면 아무 것도 하지 않음 (기존 기록의 slug 는 NULL 유지)
END
$$;

-- 3) game_id 를 LEGACY 로 명시
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

-- 4) slug 기반 인덱스 추가
CREATE INDEX IF NOT EXISTS ix_game_runs_user_slug_started
  ON game_runs(user_id, slug, started_at);

CREATE INDEX IF NOT EXISTS ix_game_runs_slug_score_desc_started
  ON game_runs(slug, score DESC, started_at ASC);

-- 5) v_leaderboard_top 뷰를 slug 기준으로 재정의
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
