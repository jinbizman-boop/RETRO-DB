import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "..//_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateSignup, type SignupPayload } from "../_utils/schema/auth";
import * as Rate from "../_utils/rate-limit";

/**
 * 에디터 오류 해결 메모
 * - ts(2304) PagesFunction 미정의 → 아래에 최소 ambient 타입 선언
 * - ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
 *
 * DB 스키마 정합 메모 (2025-12 최신 상태 기준)
 * - 현재 users.id 는 text 타입 + gen_random_uuid()::text 기본값 사용
 *   • user_stats.user_id / user_wallet.user_id / analytics_events.user_id 등은
 *     모두 text 타입으로 users(id) 를 참조
 *   • 기존 uuid 기반 주석은 호환성 유지 목적의 설명으로만 남겨 둠
 *
 * - migrations/001_init.sql 기반 users 를 기본으로 하되,
 *   • 별도의 users 테이블 생성 X
 *   • migrations/005_user_profile_and_progress.sql 에서
 *     password_hash, gender, birth, phone, agree_at 등 컬럼을 정식 추가
 *   • 여기서는 컬럼 보강 DDL을 "이중 안전망"으로 유지 (alter table if not exists)
 *   • user_stats / user_progress / user_wallet 에 가입 시점 row 생성
 *     (경험치/포인트/티켓/게임 카운트 기본값 0)
 *   • audit_logs / analytics_events 에 signup 이벤트 기록 (존재 시 활용)
 *
 * 기능 고도화 메모
 * - 1) 회원가입 / 로그인 기능 연결:
 *      • SHA-256 password_hash 로 로그인 API 와 동일한 방식 사용
 *      • 선택적으로 JWT 토큰 발급 (env.JWT_SECRET 존재 시)
 * - 2) 게임 플레이 후 경험치/포인트 자동 저장:
 *      • user_stats, user_wallet 테이블/컬럼/제약 조건을 가입 단계에서 안전하게 보강
 * - 3) shop_items 기본 seed 추가:
 *      • 별도 migration 에서 처리하지만, 여기서는 스키마 쪽만 방어적으로 확인
 * - 4) analytics_events 자동 기록:
 *      • 가입 시 analytics_events 에 'signup' 이벤트 기록 (테이블 존재 시)
 *
 * 진단/운영 편의를 위한 추가 메모
 * - 이 파일 하나만으로도 신규 환경에 기본적인 회원/통계/지갑/로그 스키마를
 *   "자기 치유(self-healing)" 방식으로 자동 보강할 수 있게 설계됨.
 * - 프로덕션에서는 migrations/*.sql 을 통해 스키마를 미리 정립해 두되,
 *   이 핸들러의 DDL 은 예외 상황(누락된 컬럼/제약 등)에서 안전망 역할을 수행.
 */

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ───────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (
  ctx: CfEventLike<E>
) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────── */

/* ───────── Crypto helpers (password hash) ───────── */
async function sha256(s: string) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ───────── JWT helpers (optional, for immediate login after signup) ─────────
 * - HS256 (HMAC-SHA256) 기반 간단 JWT 구현
 * - env.JWT_SECRET 존재 시에만 토큰 발급, 없으면 기존 응답 구조만 유지
 */

type JwtPayload = {
  sub: string; // userId
  iat: number;
  exp: number;
  [key: string]: unknown;
};

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;

  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }

  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createJwtToken(
  userId: string,
  secret: string,
  options?: { expiresInSec?: number; extra?: Record<string, unknown> }
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + (options?.expiresInSec ?? 60 * 60 * 24 * 30); // default 30 days

  const payload: JwtPayload = {
    sub: userId,
    iat: nowSec,
    exp: expSec,
    ...(options?.extra ?? {}),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  const sigB64 = base64UrlEncode(sig);

  return `${data}.${sigB64}`;
}

/* ───────── Neon/Postgres 오류 식별: 이메일/아이디 중복 ───────── */
function isUniqueEmailError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    (msg.includes("duplicate key") &&
      (msg.includes("users_email") || msg.includes("users_email_key"))) ||
    (msg.includes("unique constraint") &&
      (msg.includes("users_email") || msg.includes("email")))
  );
}

function isUniqueUsernameError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    (msg.includes("duplicate key") &&
      (msg.includes("users_username") || msg.includes("users_username_key"))) ||
    (msg.includes("unique constraint") &&
      (msg.includes("users_username") || msg.includes("username")))
  );
}

/* ───────── [LEGACY] Helpers: payload 정규화 ─────────
 * validateSignup 가 모든 가입 필드(email/password/username/gender/birth/phone/agree)를
 * 정규화/검증하도록 고도화되었기 때문에, 아래 헬퍼들은 더 이상 직접 사용하지 않음.
 * 다만, 기존 구성/배치를 최대한 유지하기 위해 남겨둔 상태(호환 목적).
 */
function normalizeString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function normalizeGender(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const g = v.trim().toLowerCase();
  if (g === "male" || g === "female" || g === "other") return g;
  return null;
}

function normalizeBirth(v: unknown): string | null {
  // "YYYY-MM-DD" 문자열만 허용 (Postgres DATE로 캐스팅 가능)
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const digits = String(v).replace(/\D/g, "");
  // 0으로 시작 + 9~11자리 정도만 허용 (01012345678 형태)
  if (!/^0\d{8,10}$/.test(digits)) return null;
  return digits;
}

function normalizeAgree(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1" || v === "on";
}

/* ───────── Helpers: 클라이언트 메타데이터 (IP / UA) ───────── */
function getClientMeta(request: Request) {
  const headers = request.headers;
  const ip =
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    null;
  const ua = headers.get("user-agent") || null;
  return { ip, ua };
}

/* ───────── Helpers: audit_logs / analytics_events 사용 가능 여부 체크 ───────── */
async function hasAuditLogsTable(
  sql: ReturnType<typeof getSql>
): Promise<boolean> {
  const rows = await sql/* sql */ `
    select to_regclass('public.audit_logs') as name
  `;
  return Boolean(rows[0]?.name);
}

async function hasAnalyticsEventsTable(
  sql: ReturnType<typeof getSql>
): Promise<boolean> {
  const rows = await sql/* sql */ `
    select to_regclass('public.analytics_events') as name
  `;
  return Boolean(rows[0]?.name);
}

/* ───────── Helpers: user_wallet 스키마 보강 ─────────
 * - 게임 플레이 후 포인트/티켓 자동 저장을 위한 지갑 테이블
 * - 현재 users.id 가 text 인 환경과 uuid 인 환경 모두를 고려하여
 *   user_wallet.user_id 는 text → users(id) 참조 구조로 정의
 * - migrations/005_user_stats_wallet_extension.sql 과 호환되도록 방어적 설계
 */
async function ensureUserWalletSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
  // 기본 테이블 생성 (이미 있으면 아무 일도 하지 않음)
  await sql/* sql */ `
    create table if not exists user_wallet (
      user_id    text primary key references users(id) on delete cascade,
      points     bigint not null default 0,
      tickets    bigint not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  // 누락된 컬럼 방어적 추가
  await sql/* sql */ `
    alter table user_wallet
      add column if not exists points     bigint not null default 0,
      add column if not exists tickets    bigint not null default 0,
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now()
  `;

  // 음수 방지 제약조건 (존재하지 않는 경우에만 추가)
  await sql/* sql */ `
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conrelid = 'user_wallet'::regclass
          and conname = 'user_wallet_points_nonneg'
      ) then
        alter table user_wallet
          add constraint user_wallet_points_nonneg check (points >= 0);
      end if;

      if not exists (
        select 1 from pg_constraint
        where conrelid = 'user_wallet'::regclass
          and conname = 'user_wallet_tickets_nonneg'
      ) then
        alter table user_wallet
          add constraint user_wallet_tickets_nonneg check (tickets >= 0);
      end if;
    end
    $$;
  `;

  // updated_at 트리거 세팅 (set_updated_at() 함수가 존재할 때만)
  await sql/* sql */ `
    do $$
    begin
      if exists (
        select 1 from pg_proc where proname = 'set_updated_at'
      ) then
        if not exists (
          select 1 from pg_trigger where tgname = 'user_wallet_set_updated_at'
        ) then
          create trigger user_wallet_set_updated_at
          before update on user_wallet
          for each row execute function set_updated_at();
        end if;
      end if;
    end
    $$;
  `;
}

/* ───────── Cloudflare Pages handler ───────── */
export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // CORS / preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "method_not_allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 과도한 가입 시도 제한
  if (!(await Rate.allow(request))) {
    return withCORS(
      json(
        { error: "too_many_requests" },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);

    // ─────────────────────────────────────────────────────────────
    // 이메일/비밀번호 + 추가 필드는 고도화된 validateSignup 이 모두 처리
    //   - email/password/username/gender/birth/phone/agree 검증/정규화
    //   - agree=false 인 경우 validateSignup 내부에서 terms_not_agreed 로 에러 발생
    // ─────────────────────────────────────────────────────────────
    const payload: SignupPayload = validateSignup(body);
    const { email, password, username, gender, birth, phone, agree } = payload;

    const sql = getSql(env);
    const { ip, ua } = getClientMeta(request);

    // ─────────────────────────────────────────────────────────────
    // users / user_stats / user_progress / user_wallet / analytics_events 스키마 보강
    //  - users 컬럼은 migrations/005_user_profile_and_progress.sql 에서
    //    이미 추가되지만, 여기서도 alter table if not exists 로 이중 안전망 유지
    //  - user_stats / user_progress / user_wallet 은 가입 시점 기본 row 생성 전,
    //    테이블/컬럼/제약 조건을 방어적으로 체크
    // ─────────────────────────────────────────────────────────────

    // users: password_hash 및 회원정보 컬럼 보강
    await sql/* sql */ `alter table users add column if not exists password_hash text`;
    await sql/* sql */ `alter table users add column if not exists gender text`;
    await sql/* sql */ `alter table users add column if not exists birth date`;
    await sql/* sql */ `alter table users add column if not exists phone text`;
    await sql/* sql */ `alter table users add column if not exists agree_at timestamptz`;
    await sql/* sql */ `alter table users add column if not exists avatar text`;
    await sql/* sql */ `alter table users add column if not exists failed_attempts int not null default 0`;
    await sql/* sql */ `alter table users add column if not exists locked_until timestamptz`;
    await sql/* sql */ `alter table users add column if not exists last_login_at timestamptz`;

    // display_name 은 001_init.sql 에 이미 존재. username 과 별도로 사용 가능.

    // 인덱스 보강 (이미 migrations 에도 있지만 idempotent)
    await sql/* sql */ `create index if not exists users_email_idx on users (email)`;
    await sql/* sql */ `
      create unique index if not exists users_username_idx
      on users (username) where username is not null
    `;

    // user_stats: 가입 시점에 기본 row 를 넣기 위해, 테이블/컬럼 보강
    await sql/* sql */ `
      create table if not exists user_stats (
        user_id       text primary key references users(id) on delete cascade,
        xp            bigint not null default 0,
        level         int generated always as (greatest(1, (xp/1000)::int + 1)) stored,
        coins         bigint not null default 0,
        exp           bigint not null default 0,
        tickets       bigint not null default 0,
        games_played  bigint not null default 0,
        last_login_at timestamptz,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now()
      )
    `;

    await sql/* sql */ `
      alter table user_stats
        add column if not exists coins         bigint not null default 0,
        add column if not exists exp           bigint not null default 0,
        add column if not exists tickets       bigint not null default 0,
        add column if not exists games_played  bigint not null default 0,
        add column if not exists created_at    timestamptz not null default now(),
        add column if not exists updated_at    timestamptz not null default now()
    `;

    await sql/* sql */ `
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_coins_nonneg'
        ) then
          alter table user_stats
            add constraint user_stats_coins_nonneg check (coins >= 0);
        end if;
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_exp_nonneg'
        ) then
          alter table user_stats
            add constraint user_stats_exp_nonneg check (exp >= 0);
        end if;
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_tickets_nonneg'
        ) then
          alter table user_stats
            add constraint user_stats_tickets_nonneg check (tickets >= 0);
        end if;
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_games_played_nonneg'
        ) then
          alter table user_stats
            add constraint user_stats_games_played_nonneg check (games_played >= 0);
        end if;
      end
      $$;
    `;

    // user_stats.updated_at 트리거 (있는 경우 그대로 사용)
    await sql/* sql */ `
      do $$
      begin
        if exists (
          select 1 from pg_proc where proname = 'set_updated_at'
        ) then
          if not exists (
            select 1
            from pg_trigger
            where tgname = 'user_stats_set_updated_at'
          ) then
            create trigger user_stats_set_updated_at
            before update on user_stats
            for each row execute function set_updated_at();
          end if;
        end if;
      end
      $$;
    `;

    // user_wallet 스키마 보강 (게임 포인트/티켓 관리용)
    await ensureUserWalletSchema(sql);

    // analytics_events 테이블: 최소 스키마 보장
    await sql/* sql */ `
      create table if not exists analytics_events (
        id         bigserial primary key,
        user_id    text references users(id) on delete cascade,
        event_name text not null,
        game_id    text,
        score      bigint,
        metadata   jsonb,
        created_at timestamptz not null default now()
      )
    `;

    // ── 가입 처리 ─────────────────────────────────────────────────────
    const passHash = await sha256(password);
    const nowIso = new Date().toISOString();

    try {
      // users.insert
      const rows = await sql/* sql */ `
        insert into users (
          email,
          password_hash,
          username,
          display_name,
          gender,
          birth,
          phone,
          agree_at
        )
        values (
          ${email},
          ${passHash},
          ${username},
          ${username ?? null},
          ${gender},
          ${birth},
          ${phone},
          ${agree ? nowIso : null}
        )
        returning id
      `;

      const userId = String(rows[0].id);

      // user_stats 기본 row 생성 (coins/exp/tickets/games_played = 0)
      await sql/* sql */ `
        insert into user_stats (user_id)
        values (${userId})
        on conflict (user_id) do nothing
      `;

      // user_progress 기본 row 생성 (exp/level/tickets = 0/1/0) — 스키마 존재 시
      await sql/* sql */ `
        do $$
        begin
          if to_regclass('public.user_progress') is not null then
            insert into user_progress (user_id)
            values (${userId})
            on conflict (user_id) do nothing;
          end if;
        end
        $$;
      `;

      // user_wallet 기본 row 생성 (points/tickets = 0) — ensureUserWalletSchema 이후 안전
      await sql/* sql */ `
        insert into user_wallet (user_id)
        values (${userId})
        on conflict (user_id) do nothing
      `;

      // audit_logs 테이블이 있으면 가입 기록 남기기 (옵션)
      if (await hasAuditLogsTable(sql)) {
        const payloadAudit = {
          email,
          username,
          ip,
          ua,
          signup_source: "local_form",
        };
        await sql/* sql */ `
          insert into audit_logs (user_id, action, payload)
          values (
            ${userId},
            'signup_local',
            ${JSON.stringify(payloadAudit)}::jsonb
          )
        `;
      }

      // analytics_events 테이블이 있으면 signup 이벤트 기록
      if (await hasAnalyticsEventsTable(sql)) {
        const payloadAnalytics = {
          ip,
          ua,
          signup_source: "local_form",
        };
        await sql/* sql */ `
          insert into analytics_events (user_id, event_name, metadata)
          values (
            ${userId},
            'signup',
            ${JSON.stringify(payloadAnalytics)}::jsonb
          )
        `;
      }

      // JWT 토큰 (선택적) 발급: env.JWT_SECRET 이 설정된 경우에만
      let token: string | null = null;
      if (env && (env as any).JWT_SECRET) {
        try {
          token = await createJwtToken(userId, (env as any).JWT_SECRET, {
            expiresInSec: 60 * 60 * 24 * 30, // 30 days
            extra: {
              email,
              username,
            },
          });
        } catch {
          // 토큰 발급 실패는 치명적 에러가 아니므로 무시하고 계속 진행
          token = null;
        }
      }

      // 응답: 기존 구조 유지 (ok + userId) + token 이 있으면 추가
      const tookMs = Math.round(performance.now() - t0);
      const payloadResponse: Record<string, any> = {
        ok: true,
        userId,
      };
      if (token) {
        payloadResponse.token = token;
      }

      return withCORS(
        json(payloadResponse, {
          headers: {
            "Cache-Control": "no-store",
            "X-Signup-Took-ms": String(tookMs),
          },
        }),
        env.CORS_ORIGIN
      );
    } catch (e: any) {
      if (isUniqueEmailError(e)) {
        return withCORS(
          json({ error: "email_taken" }, { status: 409 }),
          env.CORS_ORIGIN
        );
      }
      if (isUniqueUsernameError(e)) {
        return withCORS(
          json({ error: "username_taken" }, { status: 409 }),
          env.CORS_ORIGIN
        );
      }
      // 기타 DB 오류는 아래의 catch로 위임
      throw e;
    }
  } catch (e: any) {
    // validateSignup 에러 포함 모든 유효성/파싱 실패 및 기타 예외 → 400
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
