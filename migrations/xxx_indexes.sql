-- xxx_indexes.sql — Hardened, idempotent index pack for RETRO GAMES
-- Goal (contract kept, non-destructive):
--   • Wallet transactions: cursor pagination by user + created_at + id
--   • shop_items: fast active/visibility/stock listing (keeps original active index)
--   • daily_spins: uniqueness by (user_id, spin_date)
--   • promo_redemptions: uniqueness by (user_id, code)
-- Notes:
--   • All operations are idempotent and guard for table/column existence.
--   • We prefer (user_id, created_at DESC, id DESC) for wallet tx; fall back to wallet_id if schema uses that.
--   • No ANALYZE here; leave to autovacuum or ops.

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1) wallet_transactions cursor index (user + created_at + id)
--    - Prefer user_id (matches 001/002 migrations), but support wallet_id fallback.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  has_table   boolean;
  has_user_id boolean;
  has_wallet  boolean;
  idx_name    text := 'idx_wallet_tx_user_created_id';
BEGIN
  SELECT (to_regclass('public.wallet_transactions') IS NOT NULL) INTO has_table;
  IF has_table THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wallet_transactions' AND column_name='user_id'
    ) INTO has_user_id;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wallet_transactions' AND column_name='wallet_id'
    ) INTO has_wallet;

    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relkind='i' AND c.relname=idx_name) THEN
      IF has_user_id THEN
        EXECUTE format('CREATE INDEX %I ON public.wallet_transactions (user_id, created_at DESC, id DESC)', idx_name);
      ELSIF has_wallet THEN
        -- Backward-compat fallback if schema uses wallet_id
        EXECUTE format('CREATE INDEX %I ON public.wallet_transactions (wallet_id, created_at DESC, id DESC)', idx_name);
      END IF;
    END IF;
  END IF;
END $$;

-- Optional narrower index for pure keyset paging by id within a user (helps deep pages)
DO $$
BEGIN
  IF to_regclass('public.wallet_transactions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='wallet_transactions' AND column_name='user_id')
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind='i' AND c.relname='idx_wallet_tx_user_id_id_desc') THEN
    EXECUTE 'CREATE INDEX idx_wallet_tx_user_id_id_desc ON public.wallet_transactions (user_id, id DESC)';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 2) shop_items listing/search indexes
--    - Preserve original "active" index and add helpful companions.
-- ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.shop_items') IS NOT NULL THEN
    -- Original: active flag
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relkind='i' AND c.relname='idx_shop_items_active') THEN
      EXECUTE 'CREATE INDEX idx_shop_items_active ON public.shop_items(active)';
    END IF;

    -- Visibility window (if columns exist)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_items' AND column_name='visible_from')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_items' AND column_name='visible_to')
       AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       WHERE n.nspname='public' AND c.relkind='i' AND c.relname='idx_shop_items_visibility') THEN
      EXECUTE 'CREATE INDEX idx_shop_items_visibility ON public.shop_items(visible_from, visible_to)';
    END IF;

    -- Stock (fast filters like WHERE stock IS NULL OR stock > 0)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_items' AND column_name='stock')
       AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       WHERE n.nspname='public' AND c.relkind='i' AND c.relname='idx_shop_items_stock') THEN
      EXECUTE 'CREATE INDEX idx_shop_items_stock ON public.shop_items(stock)';
    END IF;

    -- Sort order (NULLS LAST helps storefront ordering)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shop_items' AND column_name='sort_order')
       AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       WHERE n.nspname='public' AND c.relkind='i' AND c.relname='idx_shop_items_sort_order') THEN
      EXECUTE 'CREATE INDEX idx_shop_items_sort_order ON public.shop_items(sort_order NULLS LAST)';
    END IF;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 3) daily_spins uniqueness
-- ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.daily_spins') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind='i' AND c.relname='uid_daily_spins_user_date') THEN
    EXECUTE 'CREATE UNIQUE INDEX uid_daily_spins_user_date ON public.daily_spins(user_id, spin_date)';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 4) promo_redemptions uniqueness
-- ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.promo_redemptions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relkind='i' AND c.relname='uid_promo_redemptions_user_code') THEN
    EXECUTE 'CREATE UNIQUE INDEX uid_promo_redemptions_user_code ON public.promo_redemptions(user_id, code)';
  END IF;
END $$;

COMMIT;
