-- 008_fix_analytics_events_schema.sql
-- 목적: 실제 DB에 남아 있는 analytics_events.event_type NOT NULL 제약을
--       안전하게 완화해서, 현재 코드/마이그레이션(004_analytics_events.sql)과 호환되게 만들기.

DO $$
BEGIN
  -- 1) analytics_events 테이블이 실제로 있을 때만 진행
  IF to_regclass('public.analytics_events') IS NOT NULL THEN

    -- 2) event_type 컬럼이 존재할 때만 진행
    IF EXISTS (
      SELECT 1
      FROM   information_schema.columns
      WHERE  table_schema = 'public'
      AND    table_name   = 'analytics_events'
      AND    column_name  = 'event_type'
    ) THEN

      -- 2-1) 혹시 NULL 값이 이미 있으면 임시 기본값으로 채워 넣기
      UPDATE analytics_events
      SET    event_type = COALESCE(event_type, 'generic');

      -- 2-2) NOT NULL 제약 제거 (가장 중요한 한 줄)
      BEGIN
        ALTER TABLE analytics_events
          ALTER COLUMN event_type DROP NOT NULL;
      EXCEPTION
        WHEN undefined_column THEN
          -- 컬럼이 없으면 조용히 무시
          NULL;
      END;

      -- 2-3) 앞으로 들어올 레코드에 대한 기본값 설정(선택)
      BEGIN
        ALTER TABLE analytics_events
          ALTER COLUMN event_type SET DEFAULT 'generic';
      EXCEPTION
        WHEN undefined_column THEN
          NULL;
      END;

    END IF;
  END IF;
END $$;
