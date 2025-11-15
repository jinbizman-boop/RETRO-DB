// functions/api/auth/login.ts
// ------------------------------------------------------------
// RETRO-GAMES Cloudflare 로그인 API (강화 버전)
// 로그인.html과 완전 호환 + signup.ts와 정합성 강화
// email 또는 username 모두 지원
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
    Policy Values
─────────────────────────────────────────────────────────────── */
const MAX_FAILS = 5;
const LOCK_MINUTES = 10;

/* ────────────────────────────────────────────────────────────
    (Core) identifier(email or username) + password 파싱
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

  // Email 로그인
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
    return { email: null, username, password: pw };
  }

  // identifier 없음
  throw new Error("identifier_required");
}

/* ────────────────────────────────────────────────────────────
    Main Handler
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

    /* ────────────────────────────────────────────────────────
        users TABLE SCHEMA (signup.ts와 완전 정합)
    ───────────────────────────────────────────────────────── */
    await sql`
      create table if not exists users(
        id             bigserial primary key,
        email          text unique not null,
        password_hash  text not null,
        username       text,
        gender         text,
        birth          date,
        phone          text,
        agree_at       timestamptz,
        avatar         text,
        failed_attempts int not null default 0,
        locked_until   timestamptz,
        last_login_at  timestamptz,
        created_at     timestamptz not null default now()
      )
    `;

    // column 보강 (이미 있으면 skip)
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

    await sql`create index if not exists users_email_idx on users(email)`;
    await sql`create unique index if not exists users_username_idx on users(username) where username is not null`;

    /* ────────────────────────────────────────────────────────
        사용자 조회
    ───────────────────────────────────────────────────────── */
    let rows: any[] = [];

    if (email) {
      rows = await sql`
        select id, password_hash, failed_attempts, locked_until
        from users where email = ${email}
      `;
    } else if (username) {
      rows = await sql`
        select id, password_hash, failed_attempts, locked_until
        from users where username = ${username}
      `;
    }

    if (!rows?.length) {
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
        return withCORS(
          json({ error: "account_locked" }, { status: 423 }),
          env.CORS_ORIGIN
        );
      }
    }

    /* ────────────────────────────────────────────────────────
        Password Hash Validate
    ───────────────────────────────────────────────────────── */
    const candidate = await sha256Hex(password);
    const ok = dbHash && timingSafeEqualHex(candidate, dbHash);
    if (!ok) {
      const fails = toNumber(raw.failed_attempts) + 1;

      if (fails >= MAX_FAILS) {
        const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString();
        await sql`
          update users
          set failed_attempts = 0,
              locked_until   = ${lockedUntil}
          where id = ${uid}
        `;
      } else {
        await sql`
          update users
          set failed_attempts = ${fails},
              locked_until   = null
          where id = ${uid}
        `;
      }

      return withCORS(
        json({ error: "invalid_credentials" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    /* ────────────────────────────────────────────────────────
        로그인 성공 처리
    ───────────────────────────────────────────────────────── */
    await sql`
      update users
      set failed_attempts = 0,
          locked_until    = null,
          last_login_at   = now()
      where id = ${uid}
    `;

    const token = await jwtSign(
      {
        sub: uid,
        iss: env.JWT_ISSUER || "retro-games",
        aud: env.JWT_AUD || "retro-games-web",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12, // 12h
      },
      env.JWT_SECRET || "dev-only-secret"
    );

    const took = Math.round(performance.now() - started);

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
  } catch (err: any) {
    return withCORS(
      json(
        { error: String(err?.message || err) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
