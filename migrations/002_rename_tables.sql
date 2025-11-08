-- 002_rename_tables.sql — Conservative/idempotent renames with full hygiene
-- Goal:
--   - transactions          → wallet_transactions
--   - daily_luck_spins      → daily_spins
-- Plus: consistently rename related indexes, constraints, triggers, and
--       sequences that follow the conventional prefixes.
--
-- Properties:
--   • Idempotent (safe to re-run).
--   • Schema-aware (defaults to public).
--   • Does NOT break dependencies: Postgres tracks OIDs, not names.
--   • Extra hygiene: also renames PK/UK/FK constraint names that match
--     the old prefix, so your catalog looks consistent.
--
-- Tested on PostgreSQL 13+ / Neon.

BEGIN;

DO $$
DECLARE
  SCHEMA_NAME text := 'public';

  -- rename plan rows: (old_table, new_table, old_prefix, new_prefix)
  rec    record;

  -- loop variables
  idx    record;
  trig   record;
  seq    record;
  con    record;
  fkcon  record;

  -- helper OIDs
  old_oid oid;
  new_oid oid;

  -- convenience formatters
  fq_old  text;
  fq_new  text;

  -- returns schema-qualified regclass string with proper quoting
  -- (example: public.transactions)
  -- not a function, just building via format() per use.
BEGIN
  FOR rec IN
    SELECT *
    FROM (VALUES
      ('transactions',     'wallet_transactions', 'transactions_',     'wallet_transactions_'),
      ('daily_luck_spins', 'daily_spins',         'daily_luck_spins_', 'daily_spins_')
    ) AS t(old_table, new_table, old_prefix, new_prefix)
  LOOP
    fq_old := format('%I.%I', SCHEMA_NAME, rec.old_table);
    fq_new := format('%I.%I', SCHEMA_NAME, rec.new_table);

    -- Resolve OIDs (NULL if not found)
    SELECT to_regclass(fq_old) INTO old_oid;
    SELECT to_regclass(fq_new) INTO new_oid;

    -- 0) Nothing to do if neither old nor new exists.
    IF old_oid IS NULL AND new_oid IS NULL THEN
      RAISE NOTICE '[rename:%] skipped (no old/new table)', rec.old_table;
      CONTINUE;
    END IF;

    -- 1) Table rename: only when old exists and new does not.
    IF old_oid IS NOT NULL AND new_oid IS NULL THEN
      EXECUTE format('ALTER TABLE %s RENAME TO %I', fq_old, rec.new_table);
      RAISE NOTICE '[rename:%] table renamed → %', rec.old_table, rec.new_table;
      -- refresh OID
      SELECT to_regclass(fq_new) INTO new_oid;
    ELSE
      RAISE NOTICE '[rename:%] table OK (already at target)', rec.new_table;
    END IF;

    -- defensive: if still no new_oid, continue safely
    IF new_oid IS NULL THEN
      RAISE NOTICE '[rename:%] target table not present; continuing', rec.new_table;
      CONTINUE;
    END IF;

    -- 2) Primary/Unique/FK constraint names on the renamed table itself
    --    Rename any constraint whose name starts with old_prefix → new_prefix.
    FOR con IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t  ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = SCHEMA_NAME
        AND t.oid = new_oid
        AND c.conname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
                     fq_new, con.conname,
                     replace(con.conname, rec.old_prefix, rec.new_prefix));
      RAISE NOTICE '[rename:%] constraint % → %',
        rec.new_table,
        con.conname,
        replace(con.conname, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -- 3) Index names associated with the renamed table
    --    If index name begins with old_prefix, swap it to new_prefix.
    FOR idx IN
      SELECT i.relname AS idx_name
      FROM pg_class i
      JOIN pg_index ix ON ix.indexrelid = i.oid
      JOIN pg_class t  ON t.oid = ix.indrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE ns.nspname = SCHEMA_NAME
        AND t.oid = new_oid
        AND i.relname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I',
                     SCHEMA_NAME,
                     idx.idx_name,
                     replace(idx.idx_name, rec.old_prefix, rec.new_prefix));
      RAISE NOTICE '[rename:%] index % → %',
        rec.new_table,
        idx.idx_name,
        replace(idx.idx_name, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -- 4) Trigger names on the renamed table (non-internal only)
    FOR trig IN
      SELECT tg.tgname AS trigger_name
      FROM pg_trigger tg
      JOIN pg_class t ON t.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE ns.nspname = SCHEMA_NAME
        AND t.oid = new_oid
        AND NOT tg.tgisinternal
        AND tg.tgname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format('ALTER TRIGGER %I ON %s RENAME TO %I',
                     trig.trigger_name, fq_new,
                     replace(trig.trigger_name, rec.old_prefix, rec.new_prefix));
      RAISE NOTICE '[rename:%] trigger % → %',
        rec.new_table,
        trig.trigger_name,
        replace(trig.trigger_name, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -- 5) Rename OWNED BY sequences attached to columns of the renamed table
    FOR seq IN
      SELECT s.relname AS seq_name
      FROM pg_class s
      JOIN pg_namespace ns   ON ns.oid = s.relnamespace
      JOIN pg_depend d       ON d.objid = s.oid AND d.deptype = 'a' -- auto dependency (OWNED BY)
      JOIN pg_class t        ON t.oid = d.refobjid
      JOIN pg_namespace ns2  ON ns2.oid = t.relnamespace
      WHERE ns.nspname  = SCHEMA_NAME
        AND ns2.nspname = SCHEMA_NAME
        AND t.oid       = new_oid
        AND s.relkind   = 'S'
        AND s.relname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format('ALTER SEQUENCE %I.%I RENAME TO %I',
                     SCHEMA_NAME,
                     seq.seq_name,
                     replace(seq.seq_name, rec.old_prefix, rec.new_prefix));
      RAISE NOTICE '[rename:%] sequence % → %',
        rec.new_table,
        seq.seq_name,
        replace(seq.seq_name, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -- 6) (Extra) Foreign-key constraints defined on OTHER tables that
    --    reference the renamed table and whose constraint names follow
    --    the old prefix. We only rename the constraint name; the FK
    --    continues to work because it is OID-based.
    FOR fkcon IN
      SELECT c.conname,
             n2.nspname  AS fk_schema,
             t2.relname  AS fk_table
      FROM pg_constraint c
      JOIN pg_class     t2  ON t2.oid = c.conrelid           -- the referencing table
      JOIN pg_namespace n2  ON n2.oid = t2.relnamespace
      WHERE c.contype = 'f'
        AND c.confrelid = new_oid                             -- references our renamed table
        AND c.conname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',
                     fkcon.fk_schema,
                     fkcon.fk_table,
                     fkcon.conname,
                     replace(fkcon.conname, rec.old_prefix, rec.new_prefix));
      RAISE NOTICE '[rename:%] FK on %.%: % → %',
        rec.new_table,
        fkcon.fk_schema || '.' || fkcon.fk_table,
        fkcon.conname,
        replace(fkcon.conname, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -- Notes:
    --  - Views/functions remain valid (OID deps). If you also want to
    --    rename view names that embed prefixes purely for aesthetics,
    --    do it explicitly below this block in your own project.
    --  - DEFAULT nextval('…') uses regclass OIDs; renaming sequences
    --    above is cosmetic and safe.

  END LOOP;
END
$$ LANGUAGE plpgsql;

COMMIT;

-- You can extend the plan by adding (old,new,old_prefix,new_prefix) tuples
-- to the VALUES(...) list above. This script purposefully avoids touching
-- object definitions; it only normalizes *names* while preserving behavior.
