// functions/api/auth/login.ts
// ------------------------------------------------------------
// RETRO-GAMES Cloudflare 로그인 API (강화 버전)
// 로그인.html과 완전 호환 + signup.ts와 정합성 강화
// email 또는 username 모두 지원
// - users 스키마는 migrations 기반(001 + 005)과 일치
// - 계정 잠금, 실패횟수, last_login_at, user_stats 연동
// - user_wallet 및 analytics_events 와도 자동 연계
//   (1) 회원가입/로그인 기능 연결
//   (2) 게임 플레이 후 경험치/포인트 자동 저장을 위한 준비
//   (3) shop_items / wallet 과의 정합성 확보
//   (4) analytics_events 에 login 이벤트 자동 기록
// ------------------------------------------------------------

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateLogin } from "../_utils/schema/auth";
import { jwtSign } from "../_utils/auth";
import * as Rate from "../_utils/rate-limit";

/* ────────────────────────────────────────────────────────────
    Editor Types for Cloudflare Pages Functions (for VSCode)
─────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────
    Security Utilities
    - signup.ts 의 password_hash(sha256) 와 정합성 유지
    - 타이밍 공격 방지를 위한 timing-safe 비교
─────────────────────────────────────────────────────────────── */
async function sha256Hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

/* ────────────────────────────────────────────────────────────
    Policy Values (계정 잠금 정책)
─────────────────────────────────────────────────────────────── */
const MAX_FAILS = 5;
const LOCK_MINUTES = 10;

/* ────────────────────────────────────────────────────────────
    Client Meta Helpers (IP / User-Agent)
    - analytics_events, audit_logs 에 공통으로 사용
─────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────
    Table Existence Helpers (audit_logs / analytics_events)
─────────────────────────────────────────────────────────────── */
async function hasAuditLogsTable(sql: ReturnType<typeof getSql>): Promise<boolean> {
  const rows = await sql/* sql */`
    select to_regclass('public.audit_logs') as name
  `;
  return Boolean(rows[0]?.name);
}

async function hasAnalyticsEventsTable(sql: ReturnType<typeof getSql>): Promise<boolean> {
  const rows = await sql/* sql */`
    select to_regclass('public.analytics_events') as name
  `;
  return Boolean(rows[0]?.name);
}

/* ────────────────────────────────────────────────────────────
    user_wallet Schema 보강
    - 게임 플레이 후 포인트/티켓 자동 저장 준비
    - signup.ts 의 ensureUserWalletSchema 와 정합성
─────────────────────────────────────────────────────────────── */
async function ensureUserWalletSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  // 기본 테이블 생성 (이미 있으면 no-op)
  await sql/* sql */`
    create table if not exists user_wallet (
      user_id    uuid primary key references users(id) on delete cascade,
      points     bigint not null default 0,
      tickets    bigint not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  // 컬럼 보강
  await sql/* sql */`
    alter table user_wallet
      add column if not exists points     bigint not null default 0,
      add column if not exists tickets    bigint not null default 0,
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now()
  `;

  // 음수 방지 제약조건
  await sql/* sql */`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'user_wallet'::regclass
          and conname = 'user_wallet_points_nonneg'
      ) then
        alter table user_wallet
          add constraint user_wallet_points_nonneg check (points >= 0);
      end if;

      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'user_wallet'::regclass
          and conname = 'user_wallet_tickets_nonneg'
      ) then
        alter table user_wallet
          add constraint user_wallet_tickets_nonneg check (tickets >= 0);
      end if;
    end
    $$;
  `;

  // updated_at 트리거 (set_updated_at() 존재 시에만)
  await sql/* sql */`
    do $$
    begin
      if exists (
        select 1 from pg_proc where proname = 'set_updated_at'
      ) then
        if not exists (
          select 1 from pg_trigger
          where tgname = 'user_wallet_set_updated_at'
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

/* ────────────────────────────────────────────────────────────
    analytics_events 최소 스키마 보강
    - 4) analytics_events 자동 기록을 위해 방어적 생성
    - signup.ts 와 동일한 구조를 유지
─────────────────────────────────────────────────────────────── */
async function ensureAnalyticsEventsSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  await sql/* sql */`
    create table if not exists analytics_events (
      id         bigserial primary key,
      user_id    uuid references users(id) on delete cascade,
      event_name text not null,
      game_id    text,
      score      bigint,
      metadata   jsonb,
      created_at timestamptz not null default now()
    )
  `;
}

/* ────────────────────────────────────────────────────────────
    (Core) identifier(email or username) + password 파싱
    - signup.ts 의 validateLogin 과 호환되게 email 경로는 재검증
    - username 경로는 CITEXT 를 이용한 case-insensitive 비교
─────────────────────────────────────────────────────────────── */
function extractLoginPayload(body: unknown): {
  email: string | null;
  username: string | null;
  password: string;
} {
  const b = body as any;

  const pw = toStringOrNull(b?.password);
  if (!pw) throw new Error("password_required");

  const rawEmail = toStringOrNull(b?.email);
  const rawUsername =
    toStringOrNull(b?.username) ||
    toStringOrNull(b?.identifier) ||
    toStringOrNull(b?.id);

  // Email 로그인 (validateLogin 사용: email 정규화 + 강한 패스워드 검증 재사용)
  if (rawEmail && rawEmail.includes("@")) {
    const { email, password } = validateLogin({
      email: rawEmail,
      password: pw,
    });
    return { email, username: null, password };
  }

  // Username 로그인
  if (rawUsername) {
    const username = rawUsername.trim();
    if (!username.length) throw new Error("username_required");
    // username 은 signup 시 normalizeUsername 을 거치지만,
    // 로그인에서는 사용자가 입력한 원문을 그대로 비교 (CITEXT 로 case-insensitive 보완)
    return { email: null, username, password: pw };
  }

  // identifier 없음
  throw new Error("identifier_required");
}

/* ────────────────────────────────────────────────────────────
    Main Handler
    - 기존 응답 구조 유지 (ok + token + userId + X-Login-Took-ms)
    - 기능만 확장 (user_wallet, analytics_events, audit_logs)
─────────────────────────────────────────────────────────────── */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  // Preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  // Allow only POST
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "method_not_allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // Rate limit
  if (!(await Rate.allow(request))) {
    return withCORS(
      json(
        { error: "too_many_requests" },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const started = performance.now();

  try {
    const body = await readJSON(request);

    // identifier(email or username) 추출
    const { email, username, password } = extractLoginPayload(body);

    const sql = getSql(env);
    const { ip, ua } = getClientMeta(request);

    /* ────────────────────────────────────────────────────────
        users TABLE SCHEMA 보강 (migrations/001 + 005 와 정합)
        - 여기서는 create table X, alter table only (이중 안전망)
    ───────────────────────────────────────────────────────── */
    await sql/* sql */`alter table users add column if not exists password_hash   text`;
    await sql/* sql */`alter table users add column if not exists gender          text`;
    await sql/* sql */`alter table users add column if not exists birth           date`;
    await sql/* sql */`alter table users add column if not exists phone           text`;
    await sql/* sql */`alter table users add column if not exists agree_at        timestamptz`;
    await sql/* sql */`alter table users add column if not exists avatar          text`;
    await sql/* sql */`alter table users add column if not exists failed_attempts int not null default 0`;
    await sql/* sql */`alter table users add column if not exists locked_until    timestamptz`;
    await sql/* sql */`alter table users add column if not exists last_login_at   timestamptz`;
    await sql/* sql */`alter table users add column if not exists created_at      timestamptz not null default now()`;

    await sql/* sql */`create index if not exists users_email_idx on users(email)`;
    await sql/* sql */`
      create unique index if not exists users_username_idx
      on users(username) where username is not null
    `;

    /* ────────────────────────────────────────────────────────
        user_stats / user_progress 테이블(로그인 시점 row 보정)
        - signup 이전 가입자도 로그인 순간 기본 row 를 확보
    ───────────────────────────────────────────────────────── */
    await sql/* sql */`
      create table if not exists user_stats (
        user_id       uuid primary key references users(id) on delete cascade,
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

    await sql/* sql */`
      alter table user_stats
        add column if not exists coins         bigint not null default 0,
        add column if not exists exp           bigint not null default 0,
        add column if not exists tickets       bigint not null default 0,
        add column if not exists games_played  bigint not null default 0,
        add column if not exists created_at    timestamptz not null default now(),
        add column if not exists updated_at    timestamptz not null default now()
    `;

    await sql/* sql */`
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

    await sql/* sql */`
      do $$
      begin
        if not exists (
          select 1
          from pg_trigger
          where tgname = 'user_stats_set_updated_at'
        ) then
          create trigger user_stats_set_updated_at
          before update on user_stats
          for each row execute function set_updated_at();
        end if;
      end
      $$;
    `;

    // user_progress: migrations/005_user_profile_and_progress.sql 과 호환
    await sql/* sql */`
      create table if not exists user_progress (
        user_id    text primary key,
        exp        bigint      not null default 0,
        level      int         not null default 1,
        tickets    bigint      not null default 0,
        updated_at timestamptz not null default now()
      )
    `;

    // user_wallet / analytics_events 스키마 방어적 보강
    await ensureUserWalletSchema(sql);
    await ensureAnalyticsEventsSchema(sql);

    /* ────────────────────────────────────────────────────────
        사용자 조회
    ───────────────────────────────────────────────────────── */
    let rows: any[] = [];

    if (email) {
      rows = await sql/* sql */`
        select
          id,
          password_hash,
          failed_attempts,
          locked_until
        from users
        where email = ${email}
      `;
    } else if (username) {
      rows = await sql/* sql */`
        select
          id,
          password_hash,
          failed_attempts,
          locked_until
        from users
        where username = ${username}
      `;
    }

    if (!rows?.length) {
      // identifier 에 해당하는 계정 자체가 없는 경우
      // analytics_events 에도 user_id 없이 login_failed 기록 가능 (선택)
      if (await hasAnalyticsEventsTable(sql)) {
        const payload = {
          email,
          username,
          ip,
          ua,
          reason: "user_not_found",
        };
        await sql/* sql */`
          insert into analytics_events (user_id, event_name, metadata)
          values (
            null,
            'login_failed',
            ${JSON.stringify(payload)}::jsonb
          )
        `;
      }

      return withCORS(
        json({ error: "invalid_credentials" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    const raw = rows[0];
    const uid = String(raw.id);
    const dbHash = toStringOrNull(raw.password_hash) || "";

    const now = new Date();

    /* ────────────────────────────────────────────────────────
        계정 잠금 확인
    ───────────────────────────────────────────────────────── */
    const lockedUntilStr = toStringOrNull(raw.locked_until);
    if (lockedUntilStr) {
      const until = new Date(lockedUntilStr);
      if (!Number.isNaN(until.getTime()) && now < until) {
        // 잠긴 계정 접근 시도도 analytics 에 기록 (옵션)
        if (await hasAnalyticsEventsTable(sql)) {
          const payload = {
            ip,
            ua,
            email,
            username,
            reason: "locked",
          };
          await sql/* sql */`
            insert into analytics_events (user_id, event_name, metadata)
            values (
              ${uid}::uuid,
              'login_locked',
              ${JSON.stringify(payload)}::jsonb
            )
          `;
        }

        return withCORS(
          json({ error: "account_locked" }, { status: 423 }),
          env.CORS_ORIGIN
        );
      }
    }

    /* ────────────────────────────────────────────────────────
        Password Hash Validate
        - signup.ts 의 sha256(password) 와 동일한 방식
    ───────────────────────────────────────────────────────── */
    const candidate = await sha256Hex(password);
    const ok = dbHash && timingSafeEqualHex(candidate, dbHash);
    if (!ok) {
      const fails = toNumber(raw.failed_attempts) + 1;

      if (fails >= MAX_FAILS) {
        const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString();
        await sql/* sql */`
          update users
          set failed_attempts = 0,
              locked_until   = ${lockedUntil}
          where id = ${uid}
        `;

        if (await hasAnalyticsEventsTable(sql)) {
          const payload = {
            ip,
            ua,
            email,
            username,
            reason: "too_many_fails",
            fails,
          };
          await sql/* sql */`
            insert into analytics_events (user_id, event_name, metadata)
            values (
              ${uid}::uuid,
              'login_locked',
              ${JSON.stringify(payload)}::jsonb
            )
          `;
        }
      } else {
        await sql/* sql */`
          update users
          set failed_attempts = ${fails},
              locked_until   = null
          where id = ${uid}
        `;

        if (await hasAnalyticsEventsTable(sql)) {
          const payload = {
            ip,
            ua,
            email,
            username,
            reason: "wrong_password",
            fails,
          };
          await sql/* sql */`
            insert into analytics_events (user_id, event_name, metadata)
            values (
              ${uid}::uuid,
              'login_failed',
              ${JSON.stringify(payload)}::jsonb
            )
          `;
        }
      }

      return withCORS(
        json({ error: "invalid_credentials" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    /* ────────────────────────────────────────────────────────
        로그인 성공 처리
        - users.last_login_at 갱신
        - user_stats.last_login_at upsert
        - user_progress 기본 row 보정
        - user_wallet 기본 row 보정
        - audit_logs / analytics_events 에 login 이벤트 기록
    ───────────────────────────────────────────────────────── */
    await sql/* sql */`
      update users
      set failed_attempts = 0,
          locked_until    = null,
          last_login_at   = now()
      where id = ${uid}
    `;

    // user_stats: 기존 row 없으면 생성, 있으면 last_login_at 업데이트
    await sql/* sql */`
      insert into user_stats (user_id, last_login_at)
      values (${uid}::uuid, now())
      on conflict (user_id) do update
        set last_login_at = excluded.last_login_at
    `;

    // user_progress: 기존 row 없으면 기본값(0/1/0)으로 생성
    await sql/* sql */`
      insert into user_progress (user_id)
      values (${uid})
      on conflict (user_id) do nothing
    `;

    // user_wallet: 기존 row 없으면 기본값(0/0)으로 생성
    await sql/* sql */`
      insert into user_wallet (user_id)
      values (${uid}::uuid)
      on conflict (user_id) do nothing
    `;

    // audit_logs: 테이블이 존재하는 경우 login 이벤트 기록
    if (await hasAuditLogsTable(sql)) {
      const payloadAudit = {
        ip,
        ua,
        email,
        username,
        login_source: "local_form",
      };
      await sql/* sql */`
        insert into audit_logs (user_id, action, payload)
        values (
          ${uid}::uuid,
          'login_local',
          ${JSON.stringify(payloadAudit)}::jsonb
        )
      `;
    }

    // analytics_events: 로그인 성공 이벤트 기록
    if (await hasAnalyticsEventsTable(sql)) {
      const payloadAnalytics = {
        ip,
        ua,
        email,
        username,
        login_source: "local_form",
      };
      await sql/* sql */`
        insert into analytics_events (user_id, event_name, metadata)
        values (
          ${uid}::uuid,
          'login',
          ${JSON.stringify(payloadAnalytics)}::jsonb
        )
      `;
    }

    /* ────────────────────────────────────────────────────────
        JWT 발급
        - signup.ts 의 createJwtToken 과 논리는 다르지만,
          공통으로 env.JWT_SECRET 기반 HS256 서명 사용
        - _middleware.ts 에서 jwtVerify 로 일관되게 검증
    ───────────────────────────────────────────────────────── */
    const secret = env.JWT_SECRET;
    if (!secret || typeof secret !== "string" || secret.length < 16) {
      return withCORS(
        json(
          { ok: false, error: "JWT_SECRET not set (or too short)" },
          { status: 500, headers: { "Cache-Control": "no-store" } }
        ),
        env.CORS_ORIGIN
      );
    }

    const token = await jwtSign(
      {
        sub: uid,
        iss: env.JWT_ISSUER || "retro-games",
        aud: env.JWT_AUD || "retro-games-web",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12, // 12h
      },
      secret
    );

    const took = Math.round(performance.now() - started);

    return withCORS(
      json(
        { ok: true, token, userId: uid },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Login-Took-ms": String(took),

            // ✅ 로그인 튕김/루프 방지: 토큰을 Cookie에도 저장(허브에서 Bearer가 비어도 복구 가능)
            // - 12시간(43200s) 유지, Secure/Lax
            "Set-Cookie": `rg_jwt_token=${encodeURIComponent(token)}; Path=/; Max-Age=43200; Secure; SameSite=Lax`,
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (err: any) {
    // 파싱/검증 에러 포함 모든 예외 → 400
    return withCORS(
      json(
        { error: String(err?.message || err) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
