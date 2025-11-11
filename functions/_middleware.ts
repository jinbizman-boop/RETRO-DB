// functions/_middleware.ts
// ───────────────────────────────────────────────────────────────
// Global CORS middleware for Cloudflare Pages Functions
// - 기존 동작/계약 100% 유지
// - VSCode 타입 에러 제거를 위한 로컬 타입 shim 포함
// - 전역 CORS/보안 헤더 부착
// - ?db=1 또는 ?check=db 시, Neon DB 헬스 체크 결과를 헤더(X-DB-*)에만 기록
//   (본문은 절대 변경하지 않음)
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
import { dbHealth } from "./api/_utils/db";

// Helpers (기존 방식 유지)
const ALLOW_ORIGIN = (env: any) => env.CORS_ORIGIN ?? "*";
const ALLOW_METHODS = (env: any) =>
  env.CORS_METHODS ?? "GET,POST,PUT,DELETE,OPTIONS";
const ALLOW_HEADERS = (env: any) =>
  env.CORS_HEADERS ?? "Content-Type,Authorization";

const truthy = (v: string | null) =>
  !!v && ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());

export const onRequest: PagesFunction<Partial<DbEnv>> = async ({ request, env, next }) => {
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
  if (!hdr.has("X-Content-Type-Options")) hdr.set("X-Content-Type-Options", "nosniff");
  if (!hdr.has("Referrer-Policy")) hdr.set("Referrer-Policy", "strict-origin-when-cross-origin");

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
  } catch {
    // 미들웨어는 절대로 본문/계약을 깨지 않게 조용히 무시
  }

  return new Response(res.body, { status: res.status, headers: hdr });
};
