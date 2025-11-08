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
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────── */

/* ───────── Crypto helpers ───────── */
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ───────── Neon/Postgres 오류 식별: 이메일 중복 ───────── */
function isUniqueEmailError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    msg.includes("duplicate key") ||
    (msg.includes("unique constraint") &&
      (msg.includes("users_email") || msg.includes("email")))
  );
}

export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // 과도한 가입 시도 제한
  if (!(await Rate.allow(request))) {
    return withCORS(
      json({ error: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "60" } }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);
    const { email, password } = validateSignup(body); // 이미 소문자/트림 정규화

    const sql = getSql(env);

    // ── users 테이블 및 보조 컬럼 보강(로그인 로직과 정합) ─────────────────
    await sql`
      create table if not exists users(
        id bigserial primary key,
        email text unique not null,
        password_hash text not null,
        username text,
        avatar text,
        created_at timestamptz not null default now()
      )
    `;
    // 로그인과 동일한 보조 컬럼(존재 시 유지)
    await sql`alter table users add column if not exists failed_attempts int not null default 0`;
    await sql`alter table users add column if not exists locked_until timestamptz`;
    await sql`alter table users add column if not exists last_login_at timestamptz`;
    // 조회 인덱스
    await sql`create index if not exists users_email_idx on users (email)`;

    // ── 가입 처리 ─────────────────────────────────────────────────────────
    const pass = await sha256(password);

    try {
      const rows = await sql`
        insert into users(email, password_hash)
        values (${email}, ${pass})
        returning id
      `;
      return withCORS(
        json(
          { ok: true, userId: String(rows[0].id) },
          {
            headers: {
              "Cache-Control": "no-store",
              "X-Signup-Took-ms": String(Math.round(performance.now() - t0)),
            },
          }
        ),
        env.CORS_ORIGIN
      );
    } catch (e: any) {
      if (isUniqueEmailError(e)) {
        return withCORS(
          json({ error: "Email already registered" }, { status: 409 }),
          env.CORS_ORIGIN
        );
      }
      throw e;
    }
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
