-- 005_user_profile_and_progress.sql
-- ------------------------------------------------------------------
-- Purpose
--   1) users 테이블을 signup.ts / login.ts 에서 기대하는 스키마와 정합.
--   2) user_progress: 계정별 경험치/레벨/티켓 저장용 테이블 정식 도입.
--   3) wallet_balances: 계정별 포인트(지갑 잔액) 저장용 테이블 정식 도입.
--
-- Design
--   • PostgreSQL 13+ / Neon 호환
--   • 완전 idempotent: 여러 번 실행해도 안전
--   • 001_init.sql, 003_shop_effects.sql 과 충돌 없음
--   • 기존 런타임 DDL(create table if not exists ...)과 타입/컬럼 호환 유지
-- ------------------------------------------------------------------

BEGIN;

-- 1) users 테이블 확장
--    - signup.ts / login.ts 에서 사용하는 컬럼들을 정식 컬럼으로 추가
--    - 기존 001_init.sql 의 users(id UUID, email CITEXT ...) 정의는 유지
--    - 일부 컬럼은 nullable 로 두어 OAuth-only 계정과도 공존 가능하게 설계

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash   TEXT,         -- 일반 로그인용 비밀번호 해시
  ADD COLUMN IF NOT EXISTS gender          TEXT,         -- 선택적 성별 정보
  ADD COLUMN IF NOT EXISTS birth           DATE,         -- 선택적 생년월일
  ADD COLUMN IF NOT EXISTS phone           TEXT,         -- 선택적 연락처
  ADD COLUMN IF NOT EXISTS agree_at        TIMESTAMPTZ,  -- 약관 동의 시각
  ADD COLUMN IF NOT EXISTS avatar          TEXT,         -- signup.ts 가 사용하는 avatar 컬럼 (avatar_url 과 병행)
  ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0, -- 로그인 실패 횟수
  ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ,  -- 계정 잠금 해제 시각
  ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;  -- 마지막 로그인 시각

-- (선택) 로그인 관련 보조 인덱스 예시
--  - 필요 시 주석 해제해서 사용
-- CREATE INDEX IF NOT EXISTS idx_users_last_login_at ON users(last_login_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_users_locked_until  ON users(locked_until);


-- 2) user_progress — 계정별 경험치/레벨/티켓
--    - 미들웨어(_middleware.ts)에서 조회하는 스키마와 정확히 일치
--    - 현재 코드에서는 user_id 를 text 로 사용하므로 그대로 유지
--      (JWT sub 문자열과 1:1 매칭, 기존 런타임 DDL과 완전 호환)

CREATE TABLE IF NOT EXISTS user_progress (
  user_id    TEXT PRIMARY KEY,
  exp        BIGINT      NOT NULL DEFAULT 0,
  level      INT         NOT NULL DEFAULT 1,
  tickets    BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 경험치/티켓 조회 및 정렬을 위한 보조 인덱스
CREATE INDEX IF NOT EXISTS idx_user_progress_updated_at
  ON user_progress (updated_at DESC);


-- 3) wallet_balances — 계정별 포인트(지갑 잔액)
--    - wallet/transaction.ts, _middleware.ts, auth/me.ts 의 DDL/쿼리와 일치
--    - user_id 는 text 로 유지 (기존 런타임 DDL과 타입 호환)

CREATE TABLE IF NOT EXISTS wallet_balances (
  user_id    TEXT PRIMARY KEY,
  balance    BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 최근 갱신 순/조회 최적화를 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_wallet_balances_updated_at
  ON wallet_balances (updated_at DESC);

COMMIT;
