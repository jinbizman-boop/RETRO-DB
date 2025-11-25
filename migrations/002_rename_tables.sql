-- 002_rename_tables.sql — Conservative/idempotent renames with full hygiene
-- Goal (C안 / 최신 스키마 기준):
--   - wallet_transactions  → transactions
--   - daily_spins          → daily_luck_spins
--
-- 배경
--   - 001_init.sql 에서 canonical 이름은 다음과 같이 정의되어 있음:
--       • transactions      : 지갑/포인트/경험치 등 모든 트랜잭션 로그
--       • daily_luck_spins  : 일일 뽑기(럭키 스핀) 로그
--   - 과거 일부 배포본에서는 wallet_transactions / daily_spins 이름을
--     사용했을 수 있으므로, 이 마이그레이션은 “옛 이름 → 새 이름”으로
--     정리(정규화)하는 역할만 수행한다.
--
-- 특성
--   • Idempotent (여러 번 실행해도 안전).
--   • Schema-aware (기본 스키마는 public).
--   • Postgres 의 OID 의존성을 깨지 않음 (VIEW / FUNCTION 등은 그대로 동작).
--   • 추가 위생:
--       - 구 prefix 로 시작하는 PK/UK/FK 제약조건 이름도 함께 rename.
--       - 관련 인덱스/시퀀스/트리거 이름도 prefix 기준으로 rename.
--
-- Tested on PostgreSQL 13+ / Neon.

BEGIN;

DO $$
DECLARE
  SCHEMA_NAME text := 'public';

  -- rename plan rows: (old_table, new_table, old_prefix, new_prefix)
  -- ※ 여기에서 "old_*" 는 과거/레거시 이름, "new_*" 는 001_init 기준 canonical 이름.
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

BEGIN
  ---------------------------------------------------------------------------
  -- 1) 테이블 이름 정리 계획 설정
  --
  --   (과거) wallet_transactions   → (현재 표준) transactions
  --   (과거) daily_spins           → (현재 표준) daily_luck_spins
  --
  --   - old_prefix / new_prefix 는 제약조건, 인덱스, 시퀀스, 트리거 이름에도
  --     동일하게 적용된다.
  ---------------------------------------------------------------------------
  FOR rec IN
    SELECT *
    FROM (VALUES
      ('wallet_transactions', 'transactions',      'wallet_transactions_', 'transactions_'),
      ('daily_spins',         'daily_luck_spins',  'daily_spins_',         'daily_luck_spins_')
    ) AS t(old_table, new_table, old_prefix, new_prefix)
  LOOP
    fq_old := format('%I.%I', SCHEMA_NAME, rec.old_table);
    fq_new := format('%I.%I', SCHEMA_NAME, rec.new_table);

    -- Resolve OIDs (NULL if not found)
    SELECT to_regclass(fq_old) INTO old_oid;
    SELECT to_regclass(fq_new) INTO new_oid;

    -------------------------------------------------------------------------
    -- 0) old/new 둘 다 없으면 할 일이 없음
    -------------------------------------------------------------------------
    IF old_oid IS NULL AND new_oid IS NULL THEN
      RAISE NOTICE '[rename:%] skipped (no old/new table)', rec.old_table;
      CONTINUE;
    END IF;

    -------------------------------------------------------------------------
    -- 1) 테이블 rename
    --
    --   - old 가 존재하고, new 가 아직 없을 때만 rename.
    --   - 이미 new 가 있으면 "이미 목표 상태"로 판단하고 rename 안 함.
    --
    --   예)
    --     • wallet_transactions O, transactions X → 이름 변경 수행
    --     • wallet_transactions X, transactions O → 아무 것도 안 함
    -------------------------------------------------------------------------
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

    -------------------------------------------------------------------------
    -- 2) Primary/Unique/FK constraint names on the renamed table itself
    --    - new 테이블에 붙어 있는 제약조건 중 이름이 old_prefix 로 시작하면
    --      new_prefix 로 치환한다.
    --
    --    예)
    --      wallet_transactions_pkey → transactions_pkey
    -------------------------------------------------------------------------
    FOR con IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t  ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = SCHEMA_NAME
        AND t.oid = new_oid
        AND c.conname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format(
        'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
        fq_new,
        con.conname,
        replace(con.conname, rec.old_prefix, rec.new_prefix)
      );
      RAISE NOTICE '[rename:%] constraint % → %',
        rec.new_table,
        con.conname,
        replace(con.conname, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -------------------------------------------------------------------------
    -- 3) Index names associated with the renamed table
    --    - new 테이블 기준으로, 인덱스 이름이 old_prefix 로 시작하면
    --      new_prefix 로 rename.
    -------------------------------------------------------------------------
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
      EXECUTE format(
        'ALTER INDEX %I.%I RENAME TO %I',
        SCHEMA_NAME,
        idx.idx_name,
        replace(idx.idx_name, rec.old_prefix, rec.new_prefix)
      );
      RAISE NOTICE '[rename:%] index % → %',
        rec.new_table,
        idx.idx_name,
        replace(idx.idx_name, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -------------------------------------------------------------------------
    -- 4) Trigger names on the renamed table (non-internal only)
    --    - 트리거 이름도 prefix 기반으로 rename.
    -------------------------------------------------------------------------
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
      EXECUTE format(
        'ALTER TRIGGER %I ON %s RENAME TO %I',
        trig.trigger_name,
        fq_new,
        replace(trig.trigger_name, rec.old_prefix, rec.new_prefix)
      );
      RAISE NOTICE '[rename:%] trigger % → %',
        rec.new_table,
        trig.trigger_name,
        replace(trig.trigger_name, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -------------------------------------------------------------------------
    -- 5) OWNED BY sequences attached to columns of the renamed table
    --    - 기본키/일련번호에 붙어 있는 sequence 이름도 prefix 기준으로 정리.
    -------------------------------------------------------------------------
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
      EXECUTE format(
        'ALTER SEQUENCE %I.%I RENAME TO %I',
        SCHEMA_NAME,
        seq.seq_name,
        replace(seq.seq_name, rec.old_prefix, rec.new_prefix)
      );
      RAISE NOTICE '[rename:%] sequence % → %',
        rec.new_table,
        seq.seq_name,
        replace(seq.seq_name, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -------------------------------------------------------------------------
    -- 6) (Extra) Foreign-key constraints 정의가 "다른 테이블"에 있으면서
    --    이 renamed 테이블을 참조하는 경우:
    --      - FK constraint 이름이 old_prefix 로 시작하면 new_prefix 로 rename.
    --      - 실제 참조는 OID 기반이라 동작에는 영향 없음 (이름만 정리).
    -------------------------------------------------------------------------
    FOR fkcon IN
      SELECT
        c.conname,
        n2.nspname  AS fk_schema,
        t2.relname  AS fk_table
      FROM pg_constraint c
      JOIN pg_class     t2  ON t2.oid = c.conrelid           -- the referencing table
      JOIN pg_namespace n2  ON n2.oid = t2.relnamespace
      WHERE c.contype = 'f'
        AND c.confrelid = new_oid                             -- references our renamed table
        AND c.conname LIKE rec.old_prefix || '%'
    LOOP
      EXECUTE format(
        'ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',
        fkcon.fk_schema,
        fkcon.fk_table,
        fkcon.conname,
        replace(fkcon.conname, rec.old_prefix, rec.new_prefix)
      );
      RAISE NOTICE '[rename:%] FK on %.%: % → %',
        rec.new_table,
        fkcon.fk_schema || '.' || fkcon.fk_table,
        fkcon.conname,
        replace(fkcon.conname, rec.old_prefix, rec.new_prefix);
    END LOOP;

    -------------------------------------------------------------------------
    -- Notes:
    --  - View / Function / Default nextval('…') 등은 모두 regclass(OID)에
    --    의존하므로, 이 스크립트가 이름만 변경해도 동작에는 영향을 주지 않는다.
    --  - "미관상 이름까지 정리"하는 데 초점을 두었으며, 스키마 정의 자체를
    --    ALTER 하지 않는다.
    --  - 추가로 rename 하고 싶은 view 이름 등이 있다면, 이 블록 아래에
    --    별도의 ALTER VIEW ... 명령으로 확장하면 된다.
    -------------------------------------------------------------------------
  END LOOP;
END
$$ LANGUAGE plpgsql;

COMMIT;

-- 확장 방법:
--   • 다른 레거시 테이블 이름을 표준 이름으로 가져오고 싶다면
--     FOR rec IN ... VALUES(...) 목록에
--       ('old_name','new_name','old_prefix_','new_prefix_')
--     튜플을 추가하면 된다.
--   • 이 스크립트는 "이름 정리"만 담당하므로, 실제 컬럼 추가/삭제/변경은
--     001_init.sql 또는 후속 마이그레이션에서 처리해야 한다.
