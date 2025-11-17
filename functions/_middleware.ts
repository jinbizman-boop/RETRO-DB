// functions/_middleware.ts
// ───────────────────────────────────────────────────────────────
// Global CORS middleware for Cloudflare Pages Functions
// - 기존 동작/계약 100% 유지
// - VSCode 타입 에러 제거를 위한 로컬 타입 shim 포함
// - 전역 CORS/보안 헤더 부착
// - ?db=1 또는 ?check=db 시, Neon DB 헬스 체크 결과를 헤더(X-DB-*)에만 기록
//   (본문은 절대 변경하지 않음)
// - 추가: 인증된 계정일 경우, 해당 계정의 경험치/레벨/포인트/티켓 요약을
//   응답 헤더(X-User-*)에만 부가 (본문/JSON 구조는 일절 변경 없음)
// ───────────────────────────────────────────────────────────────

// Minimal local shims (safe to keep even without @cloudflare/workers-types)
type CfContext<E> = {
  request: Request;
  env: E;
  next: () => Promise<Response>;
  params?: Record<string, string>;
  data?: unknown;
};
type PagesFunction<E = unknown> = (ctx: CfContext<E>) => Response | Promise<Response>;

// Optional DB health (headers only)
import type { Env as DbEnv } from "./api/_utils/db";
import { dbHealth, getSql } from "./api/_utils/db";
import { requireUser } from "./api/_utils/auth";

// Helpers (기존 방식 유지)
const ALLOW_ORIGIN = (env: any) => env.CORS_ORIGIN ?? "*";
const ALLOW_METHODS = (env: any) =>
  env.CORS_METHODS ?? "GET,POST,PUT,DELETE,OPTIONS";
const ALLOW_HEADERS = (env: any) =>
  env.CORS_HEADERS ?? "Content-Type,Authorization";

const truthy = (v: string | null) =>
  !!v && ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());

// 숫자/에러 유틸 (auth/me.ts와 동일한 규칙 유지)
function toNumberSafe(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function toNonNegativeInt(v: unknown): number {
  const n = Math.trunc(toNumberSafe(v));
  return n < 0 ? 0 : n;
}
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table")
  );
}

/**
 * 인증된 유저에 대해 user_progress / wallet_balances를 조회하여
 * 경험치/레벨/포인트/티켓을 숫자 형태로 반환.
 * - 테이블이 없거나 에러가 나면 조용히 0/기본값으로 fallback
 * - 본문(JSON)은 일절 건드리지 않고, 상위에서 헤더에만 반영하도록 설계
 */
async function getUserStatsForHeaders(
  request: Request,
  env: Partial<DbEnv>
): Promise<{
  userIdText: string | null;
  points: number;
  exp: number;
  level: number;
  tickets: number;
}> {
  try {
    const payload = await requireUser(request, env as DbEnv);
    const userIdText = String(payload.sub ?? "").trim();
    if (!userIdText) {
      return { userIdText: null, points: 0, exp: 0, level: 1, tickets: 0 };
    }

    const sql = getSql(env as DbEnv);
    let points = 0;
    let exp = 0;
    let level = 1;
    let tickets = 0;

    // user_progress: 경험치/레벨/티켓
    try {
      const progRows = (await sql`
        select exp, level, tickets
        from user_progress
        where user_id = ${userIdText}
        limit 1
      `) as unknown as {
        exp: number | string | bigint | null;
        level: number | string | bigint | null;
        tickets: number | string | bigint | null;
      }[];

      if (progRows && progRows.length > 0) {
        const p = progRows[0];
        exp = toNonNegativeInt(p.exp);
        level = toNonNegativeInt(p.level) || 1;
        tickets = toNonNegativeInt(p.tickets);
      }
    } catch (e) {
      if (!isMissingTable(e)) {
        // 미들웨어는 계약을 깨지 않기 위해 에러를 다시 던지지 않고 무시
        // (본문/응답코드에 영향 X, 헤더만 비어 있게 됨)
      }
    }

    // wallet_balances: 포인트(지갑 잔액)
    try {
      const balRows = (await sql`
        select balance
        from wallet_balances
        where user_id = ${userIdText}
        limit 1
      `) as unknown as { balance: number | string | bigint | null }[];

      if (balRows && balRows.length > 0) {
        points = toNonNegativeInt(balRows[0].balance);
      }
    } catch (e) {
      if (!isMissingTable(e)) {
        // 동일하게 조용히 무시
      }
    }

    return { userIdText, points, exp, level, tickets };
  } catch {
    // 비인증 요청 또는 토큰 오류 등 — 전역 미들웨어에서는 강제 401로 바꾸지 않음
    return { userIdText: null, points: 0, exp: 0, level: 1, tickets: 0 };
  }
}

export const onRequest: PagesFunction<Partial<DbEnv>> = async ({
  request,
  env,
  next,
}) => {
  // Preflight (unchanged)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": ALLOW_ORIGIN(env),
        "Access-Control-Allow-Methods": ALLOW_METHODS(env),
        "Access-Control-Allow-Headers": ALLOW_HEADERS(env),
        "Access-Control-Max-Age": "86400",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
    });
  }

  // Downstream 실행
  const res = await next();

  // 응답 헤더 병합(CORS는 라우트에서 이미 넣었으면 덮어쓰지 않음)
  const hdr = new Headers(res.headers);
  if (!hdr.has("Access-Control-Allow-Origin")) {
    hdr.set("Access-Control-Allow-Origin", ALLOW_ORIGIN(env));
  }
  if (!hdr.has("Access-Control-Allow-Methods")) {
    hdr.set("Access-Control-Allow-Methods", ALLOW_METHODS(env));
  }
  if (!hdr.has("Access-Control-Allow-Headers")) {
    hdr.set("Access-Control-Allow-Headers", ALLOW_HEADERS(env));
  }
  hdr.set("Vary", "Origin");

  // 가벼운 보안 헤더
  if (!hdr.has("X-Content-Type-Options"))
    hdr.set("X-Content-Type-Options", "nosniff");
  if (!hdr.has("Referrer-Policy"))
    hdr.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // (옵션) Neon 헬스 프로브 — 쿼리로 명시적으로 요청된 경우에만
  try {
    const url = new URL(request.url);
    const wantsDb =
      truthy(url.searchParams.get("db")) ||
      (url.searchParams.get("check") || "").toLowerCase() === "db";

    if (wantsDb) {
      const h = await dbHealth(env as DbEnv);
      hdr.set("X-DB-Ok", String(h.ok));
      hdr.set("X-DB-Took-ms", String(h.took_ms));
      if (!h.ok) hdr.set("X-DB-Error", (h as any).error ?? "unknown");
    }

    // (추가) 인증된 계정의 경험치/포인트/티켓 요약을 헤더에만 부가
    // - /api/* 요청에 대해서만 동작 (정적 자산에는 부담 최소화)
    if (url.pathname.startsWith("/api/")) {
      const stats = await getUserStatsForHeaders(request, env);
      if (stats.userIdText) {
        hdr.set("X-User-Id", stats.userIdText);
        hdr.set("X-User-Points", String(stats.points));
        hdr.set("X-User-Exp", String(stats.exp));
        hdr.set("X-User-Level", String(stats.level));
        hdr.set("X-User-Tickets", String(stats.tickets));
      }
    }
  } catch {
    // 미들웨어는 절대로 본문/계약을 깨지 않게 조용히 무시
  }

  return new Response(res.body, { status: res.status, headers: hdr });
};
