-- 004_analytics_events.sql — analytics event storage (idempotent, hardened)
-- Target: PostgreSQL 13+ / Neon compatible
-- Contract kept:
--   • Table name/columns preserved (no removals, same types and nullability).
--   • Existing INSERT/SELECT code keeps working.
-- Enhancements:
--   • Safe defaults on JSONB columns (do not rewrite existing rows).
--   • Practical composite/GIN indexes for common queries.
--   • Lightweight helper view for recent traffic (optional; non-breaking).
--   • All operations are idempotent (safe to re-run).

BEGIN;

-- 1) Base table (create if missing)
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  uid         TEXT,
  session_id  TEXT,
  path        TEXT,
  event       TEXT NOT NULL,
  payload     JSONB,
  ua          TEXT,
  referrer    TEXT,
  utm         JSONB
);

-- 2) Gentle defaults on JSONB columns (keep existing NULLs as-is)
ALTER TABLE analytics_events
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
ALTER TABLE analytics_events
  ALTER COLUMN utm     SET DEFAULT '{}'::jsonb;

-- 3) Core indexes (kept from original)
CREATE INDEX IF NOT EXISTS idx_ae_ts    ON analytics_events(ts);
CREATE INDEX IF NOT EXISTS idx_ae_event ON analytics_events(event);

-- 4) Additional selective indexes (common filters / sort patterns)
--    NOTE: These are additive and safe; they do not change behavior.
--    a) By uid, latest-first access (profiles, funnels)
CREATE INDEX IF NOT EXISTS idx_ae_uid_ts
  ON analytics_events(uid, ts DESC);

--    b) By session, latest-first access (session replay/trace)
CREATE INDEX IF NOT EXISTS idx_ae_session_ts
  ON analytics_events(session_id, ts DESC);

--    c) By path, latest-first access (page-specific dashboards)
CREATE INDEX IF NOT EXISTS idx_ae_path_ts
  ON analytics_events(path, ts DESC);

--    d) Fast lookup for JSON searches on payload/utm (properties & UTM queries)
CREATE INDEX IF NOT EXISTS idx_ae_payload_gin
  ON analytics_events USING GIN (payload jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_ae_utm_gin
  ON analytics_events USING GIN (utm     jsonb_path_ops);

-- 5) Optional helper view — “latest 10k events” (non-breaking; handy for BI)
--    Use in dashboards:  SELECT * FROM v_analytics_events_recent WHERE event='pageview';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relkind IN ('v') AND n.nspname = 'public' AND c.relname = 'v_analytics_events_recent'
  ) THEN
    EXECUTE $V$
      CREATE VIEW v_analytics_events_recent AS
      SELECT *
      FROM analytics_events
      ORDER BY ts DESC
      LIMIT 10000
    $V$;
  END IF;
END
$$;

COMMIT;

-- DOWN (optional; run inside a transaction if you need to revert)
-- DROP VIEW  IF EXISTS v_analytics_events_recent;
-- DROP INDEX IF EXISTS idx_ae_utm_gin;
-- DROP INDEX IF EXISTS idx_ae_payload_gin;
-- DROP INDEX IF EXISTS idx_ae_path_ts;
-- DROP INDEX IF EXISTS idx_ae_session_ts;
-- DROP INDEX IF EXISTS idx_ae_uid_ts;
-- DROP INDEX IF EXISTS idx_ae_event;
-- DROP INDEX IF EXISTS idx_ae_ts;
-- DROP TABLE IF EXISTS analytics_events;
