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
type PagesFunction<E = unknown> = (
  ctx: CfEventLike<E>
) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────── */

/* ───────── 보안 유틸 ───────── */
async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
const MAX_FAILS = 5; // 실패 허용치
const LOCK_MINUTES = 10; // 잠금 시간(분)

/* ───────── Login payload 정규화 ───────── */
/**
 * - identifier: email 또는 username (둘 다 허용)
 * - password: 평문 비밀번호
 *
 * 우선순위:
 * 1) body.email 이 있으면 email 로그인 (validateLogin 사용)
 * 2) 아니면 username / id / identifier 중 하나를 username 으로 사용
 */
function extractLoginPayload(body: unknown): {
  email: string | null;
  username: string | null;
  password: string;
} {
  const b = body as any;

  const pw = toStringOrNull(b?.password);
  if (!pw) {
    throw new Error("password_required");
  }

  const rawEmail = toStringOrNull(b?.email);
  const rawUsername =
    toStringOrNull(b?.username) ||
    toStringOrNull(b?.id) ||
    toStringOrNull(b?.identifier);

  // 1) email 기반 로그인 (validateLogin 스키마 활용)
  if (rawEmail && rawEmail.includes("@")) {
    const { email, password } = validateLogin({
      email: rawEmail,
      password: pw,
    });
    return { email, username: null, password };
  }

  // 2) username 기반 로그인
  if (rawUsername) {
    const username = rawUsername.trim();
    if (!username) {
      throw new Error("username_required");
    }
    return { email: null, username, password: pw };
  }

  // 어떤 identifier 도 없는 경우
  throw new Error("identifier_required");
}

/**
 * 계약 유지:
 * - POST /api/auth/login
 * - 응답: { ok:true, token, userId } | 에러(JSON)
 * 강화:
 * - Rate limit / 실패 횟수 추적 / 임시 잠금
 * - email 또는 username 둘 다 로그인 허용
 * - 처리시간 및 캐시 차단 헤더
 */
export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // CORS / method 제한
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "method_not_allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // Rate limit (과도한 시도 차단)
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
    const { email, username, password } = extractLoginPayload(body);

    const sql = getSql(env);

    // ── users 테이블 및 보조 컬럼 보강 (signup.ts와 정합성 유지) ───────────────
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
    // 기존 테이블 대비 보강
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

    // 인덱스 (signup.ts 와 동일)
    await sql`create index if not exists users_email_idx on users (email)`;
    await sql`create unique index if not exists users_username_idx on users (username) where username is not null`;

    // ── 사용자 조회 (email 우선, 없으면 username) ─────────────────────────────
    let rows: any[] = [];

    if (email) {
      rows = await sql`
        select id, password_hash, failed_attempts, locked_until
        from users
        where email = ${email}
      `;
    } else if (username) {
      rows = await sql`
        select id, password_hash, failed_attempts, locked_until
        from users
        where username = ${username}
      `;
    }

    // 존재하지 않는 계정 → 보안상 404 대신 동일한 에러 코드 사용
    if (!rows || rows.length === 0) {
      return withCORS(
        json({ error: "invalid_credentials" }, { status: 401 }),
        env.CORS_ORIGIN
      );
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
        return withCORS(
          json({ error: "account_locked" }, { status: 423 }),
          env.CORS_ORIGIN
        );
      }
    }

    // 해시 비교(상수시간)
    const candidate = await sha256Hex(password);
    const ok = dbHash && timingSafeEqualHex(candidate, dbHash);

    if (!ok) {
      // 실패 카운트 증가 및 잠금 처리
      const fails = toNumber(raw.failed_attempts) + 1;
      if (fails >= MAX_FAILS) {
        const lockedUntil = new Date(
          now.getTime() + LOCK_MINUTES * 60 * 1000
        ).toISOString();
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
              locked_until    = null
          where id = ${uid}
        `;
      }
      return withCORS(
        json({ error: "invalid_credentials" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    // 성공: 실패 카운트 초기화, 마지막 로그인 갱신, 잠금 해제
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
    // validateLogin / extractLoginPayload / 기타 오류 → 400
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
