// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\signup.ts

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateSignup } from "../_utils/schema/auth";
import * as Rate from "../_utils/rate-limit";

/**
 * 에디터 오류 해결 메모
 * - ts(2304) PagesFunction 미정의 → 아래에 최소 ambient 타입 선언
 * - ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
 *
 * DB 스키마 정합 메모
 * - migrations/001_init.sql 기반 users (UUID PK, citext email/username)와
 *   이 signup API를 완전히 일치시키기 위해:
 *   • 별도의 users 테이블 생성 X (create table if not exists 제거)
 *   • 기존 users 테이블에 password_hash, gender, birth, phone, agree_at 등만 보강
 *   • user_stats 에 가입 시점에 row 생성 (coins/exp/tickets/games_played 기본값 0)
 *   • audit_logs 에 signup 이벤트 기록 (선택적, 스키마 있으면 활용)
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

/* ───────── Crypto helpers ───────── */
async function sha256(s: string) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

/* ───────── Helpers: payload 정규화 ───────── */
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
  return (
    v === true ||
    v === "true" ||
    v === 1 ||
    v === "1" ||
    v === "on"
  );
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

/* ───────── Helpers: audit_logs 사용 가능 여부 체크 ───────── */
async function hasAuditLogsTable(sql: ReturnType<typeof getSql>): Promise<boolean> {
  const rows = await sql/* sql */`
    select to_regclass('public.audit_logs') as name
  `;
  return Boolean(rows[0]?.name);
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

    // 이메일/비밀번호는 기존 Zod 스키마(validateSignup)로 검증 (소문자/trim 정규화 포함)
    const { email, password } = validateSignup(body);

    // 나머지 필드는 optional + 서버에서 최소한만 정규화 (프론트 UI 그대로 유지)
    const username = normalizeString((body as any).username);
    const gender = normalizeGender((body as any).gender);
    const birth = normalizeBirth((body as any).birth);
    const phone = normalizePhone((body as any).phone);
    const agreed = normalizeAgree((body as any).agree);

    if (!agreed) {
      // 프론트의 "약관 동의가 필요합니다." 와 매핑될 코드
      return withCORS(
        json({ error: "agree_required" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    const sql = getSql(env);
    const { ip, ua } = getClientMeta(request);

    // ─────────────────────────────────────────────────────────────
    // users / user_stats / audit_logs 스키마 보강
    //  - migrations/001_init.sql 의 users( UUID PK )를 기준으로
    //  - 여기서는 컬럼만 추가 (create table 하지 않음)
    // ─────────────────────────────────────────────────────────────

    // users: password_hash 및 회원정보 컬럼 보강
    await sql/* sql */`alter table users add column if not exists password_hash text`;
    await sql/* sql */`alter table users add column if not exists gender text`;
    await sql/* sql */`alter table users add column if not exists birth date`;
    await sql/* sql */`alter table users add column if not exists phone text`;
    await sql/* sql */`alter table users add column if not exists agree_at timestamptz`;
    // display_name 은 001_init.sql 에 이미 존재. username 과 별도로 사용 가능.

    // 인덱스 보강 (이미 migrations 에도 있지만 idempotent)
    await sql/* sql */`create index if not exists users_email_idx on users (email)`;
    await sql/* sql */`
      create unique index if not exists users_username_idx
      on users (username) where username is not null
    `;

    // user_stats: 가입 시점에 기본 row 를 넣기 위해, 테이블/컬럼 보강
    await sql/* sql */`
      create table if not exists user_stats (
        user_id     uuid primary key references users(id) on delete cascade,
        xp          bigint not null default 0,
        level       int generated always as (greatest(1, (xp/1000)::int + 1)) stored,
        coins       bigint not null default 0,
        exp         bigint not null default 0,
        tickets     bigint not null default 0,
        games_played bigint not null default 0,
        last_login_at timestamptz,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now()
      )
    `;

    await sql/* sql */`
      alter table user_stats
        add column if not exists coins        bigint not null default 0,
        add column if not exists exp          bigint not null default 0,
        add column if not exists tickets      bigint not null default 0,
        add column if not exists games_played bigint not null default 0,
        add column if not exists created_at   timestamptz not null default now(),
        add column if not exists updated_at   timestamptz not null default now()
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

    // user_stats.updated_at 트리거 (있는 경우 그대로 사용)
    await sql/* sql */`
      do $$
      begin
        if not exists (
          select 1 from pg_trigger
          where tgname = 'user_stats_set_updated_at'
        ) then
          create trigger user_stats_set_updated_at
          before update on user_stats
          for each row execute function set_updated_at();
        end if;
      end
      $$;
    `;

    // ── 가입 처리 ─────────────────────────────────────────────────────
    const passHash = await sha256(password);
    const nowIso = new Date().toISOString();

    try {
      // users.insert
      const rows = await sql/* sql */`
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
          ${agreed ? nowIso : null}
        )
        returning id
      `;

      const userId = String(rows[0].id);

      // user_stats 기본 row 생성 (coins/exp/tickets/games_played = 0)
      await sql/* sql */`
        insert into user_stats (user_id)
        values (${userId}::uuid)
        on conflict (user_id) do nothing
      `;

      // audit_logs 테이블이 있으면 가입 기록 남기기 (옵션)
      if (await hasAuditLogsTable(sql)) {
        const payload = {
          email,
          username,
          ip,
          ua,
          signup_source: "local_form",
        };
        await sql/* sql */`
          insert into audit_logs (user_id, action, payload)
          values (
            ${userId}::uuid,
            'signup_local',
            ${JSON.stringify(payload)}::jsonb
          )
        `;
      }

      // 응답: 기존 구조 유지 (ok + userId, 헤더 성능 정보)
      return withCORS(
        json(
          {
            ok: true,
            userId,
          },
          {
            headers: {
              "Cache-Control": "no-store",
              "X-Signup-Took-ms": String(
                Math.round(performance.now() - t0)
              ),
            },
          }
        ),
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
