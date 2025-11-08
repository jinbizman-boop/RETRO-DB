// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\login.ts

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateLogin } from "../_utils/schema/auth";
import { jwtSign } from "../_utils/auth";
import * as Rate from "../_utils/rate-limit";

/**
 * 에디터 오류 해결 메모
 * - ts(2304) PagesFunction 미정의 → 최소 ambient 타입을 아래에 선언
 * - ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
 * - ts(2558) sql<T> 제너릭 사용 불가 → 질의 결과를 런타임에서 안전 캐스팅
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

/* ───────── 보안 유틸 ───────── */
async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // 상수시간 비교 전에 길이 일치
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ───────── 안전 캐스팅 헬퍼 ───────── */
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

/* ───────── 정책값 ───────── */
const MAX_FAILS = 5;     // 실패 허용치
const LOCK_MINUTES = 10; // 잠금 시간(분)

/**
 * 계약 유지:
 * - POST /api/auth/login
 * - 응답: { ok:true, token, userId } | 에러(JSON)
 * 강화:
 * - Rate limit / 실패 횟수 추적 / 임시 잠금
 * - 처리시간 및 캐시 차단 헤더
 */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // Rate limit (과도한 시도 차단)
  if (!(await Rate.allow(request))) {
    return withCORS(
      json({ error: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "60" } }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);
    const { email, password } = validateLogin(body);

    const sql = getSql(env);

    // ── users 테이블 및 보조 컬럼 보강 ───────────────────────────────
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
    await sql`alter table users add column if not exists failed_attempts int not null default 0`;
    await sql`alter table users add column if not exists locked_until timestamptz`;
    await sql`alter table users add column if not exists last_login_at timestamptz`;

    // ── 사용자 조회 ────────────────────────────────────────────────
    const rows = await sql`
      select id, password_hash, failed_attempts, locked_until
      from users
      where email = ${email}
    `;

    if (!rows || rows.length === 0) {
      // 기존 계약 유지: 미존재는 404
      return withCORS(json({ error: "Not found" }, { status: 404 }), env.CORS_ORIGIN);
    }

    const raw = rows[0] as {
      id: unknown;
      password_hash: unknown;
      failed_attempts: unknown;
      locked_until: unknown;
    };

    const uid = String(raw.id);
    const dbHash = toStringOrNull(raw.password_hash) || "";
    const now = new Date();

    // 잠금 상태 확인
    const lockedUntilStr = toStringOrNull(raw.locked_until);
    if (lockedUntilStr) {
      const until = new Date(lockedUntilStr);
      if (!Number.isNaN(until.getTime()) && now < until) {
        return withCORS(json({ error: "Account locked. Try later." }, { status: 423 }), env.CORS_ORIGIN);
      }
    }

    // 해시 비교(상수시간)
    const candidate = await sha256Hex(password);
    const ok = dbHash && timingSafeEqualHex(candidate, dbHash);

    if (!ok) {
      // 실패 카운트 증가 및 잠금 처리
      const fails = toNumber(raw.failed_attempts) + 1;
      if (fails >= MAX_FAILS) {
        const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000).toISOString();
        await sql`update users set failed_attempts = 0, locked_until = ${lockedUntil} where email = ${email}`;
      } else {
        await sql`update users set failed_attempts = ${fails}, locked_until = null where email = ${email}`;
      }
      return withCORS(json({ error: "Invalid credentials" }, { status: 401 }), env.CORS_ORIGIN);
    }

    // 성공: 실패 카운트 초기화, 마지막 로그인 갱신, 잠금 해제
    await sql`update users set failed_attempts = 0, locked_until = null, last_login_at = now() where email = ${email}`;

    const token = await jwtSign(
      {
        sub: uid,
        iss: env.JWT_ISSUER || "retro-games",
        aud: env.JWT_AUD || "retro-games-web",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12, // 12h
      },
      env.JWT_SECRET || "dev-only-secret"
    );

    const took = Math.round(performance.now() - t0);
    return withCORS(
      json(
        { ok: true, token, userId: uid },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Login-Took-ms": String(took),
          },
        }
      ),
      env.CORS_ORIGIN
    );
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
