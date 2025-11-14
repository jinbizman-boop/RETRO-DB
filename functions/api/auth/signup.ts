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
    msg.includes("duplicate key") &&
      (msg.includes("users_email") || msg.includes("users_email_key")) ||
    (msg.includes("unique constraint") &&
      (msg.includes("users_email") || msg.includes("email")))
  );
}

function isUniqueUsernameError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    msg.includes("duplicate key") &&
      (msg.includes("users_username") || msg.includes("users_username_key")) ||
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
  // 매우 간단한 패턴 체크만 수행, 실패해도 저장은 하지 않음
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

    // ── users 테이블 및 보조 컬럼 보강(로그인 로직과 정합) ─────────────────
    await sql`
      create table if not exists users(
        id bigserial primary key,
        email text unique not null,
        password_hash text not null,
        username text,
        gender text,
        birth date,
        phone text,
        agree_at timestamptz,
        avatar text,
        failed_attempts int not null default 0,
        locked_until timestamptz,
        last_login_at timestamptz,
        created_at timestamptz not null default now()
      )
    `;

    // 기존 테이블이 있을 수 있으니 보강형 alter 진행 (idempotent)
    await sql`alter table users add column if not exists username text`;
    await sql`alter table users add column if not exists gender text`;
    await sql`alter table users add column if not exists birth date`;
    await sql`alter table users add column if not exists phone text`;
    await sql`alter table users add column if not exists agree_at timestamptz`;
    await sql`alter table users add column if not exists avatar text`;
    await sql`alter table users add column if not exists failed_attempts int not null default 0`;
    await sql`alter table users add column if not exists locked_until timestamptz`;
    await sql`alter table users add column if not exists last_login_at timestamptz`;
    await sql`alter table users add column if not exists created_at timestamptz not null default now()`;

    // 조회 인덱스 및 username unique index (NULL 은 허용)
    await sql`create index if not exists users_email_idx on users (email)`;
    await sql`create unique index if not exists users_username_idx on users (username) where username is not null`;

    // ── 가입 처리 ─────────────────────────────────────────────────────────
    const passHash = await sha256(password);
    const now = new Date().toISOString();

    try {
      const rows = await sql`
        insert into users(
          email,
          password_hash,
          username,
          gender,
          birth,
          phone,
          agree_at
        )
        values (
          ${email},
          ${passHash},
          ${username},
          ${gender},
          ${birth},
          ${phone},
          ${agreed ? now : null}
        )
        returning id
      `;

      return withCORS(
        json(
          {
            ok: true,
            userId: String(rows[0].id),
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
      throw e;
    }
  } catch (e: any) {
    // validateSignup 에러 포함 모든 유효성/파싱 실패 → 400
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
