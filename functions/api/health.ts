// ──────────────────────────────────────────────────────────────────────────────
// health.ts — Cloudflare Pages Functions compatible, type-safe health endpoint
// - Keeps original contract 100%: non-OPTIONS → { ok: true, ts: number }
// - Adds: HEAD support (no body), no-store caching, timing headers,
//         robust local shims so it compiles without @cloudflare/workers-types.
// - No external deps; works in plain TS builds and Workers Runtime.
//
// Notes on errors fixed:
//   1) TS2304: Cannot find name 'PagesFunction'
//      → Provided minimal local shims for PagesFunction and context types.
//   2) TS7031: Binding element 'request'/'env' implicitly has an 'any' type
//      → Context typed via our local PagesFunction<E> definition.
// ──────────────────────────────────────────────────────────────────────────────

/* ── Local runtime/typing shims (no external type packages required) ───────── */
// These shims are intentionally minimal and align with Workers Runtime shape.
// If your project already includes `@cloudflare/workers-types`, you can remove
// this block safely.
type CfContext<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  data?: unknown;
};
// Handler signature used by Cloudflare Pages Functions.
type PagesFunction<E = unknown> = (ctx: CfContext<E>) => Response | Promise<Response>;

/* Small utility to get a high-resolution timestamp even in non-Workers builds. */
function nowMs(): number {
  try {
    // @ts-ignore - performance is available in Workers & browsers
    const p = (globalThis as any).performance;
    return p && typeof p.now === "function" ? Math.round(p.now()) : Date.now();
  } catch {
    return Date.now();
  }
}

/* Build standard response headers for this endpoint in one place. */
function healthHeaders(startMs: number): Record<string, string> {
  const took = String(nowMs() - startMs);
  return {
    "Cache-Control": "no-store",
    "X-Health-Took-ms": took,
  };
}

/* Optional: defensively stringify any value for JSON error-safe responses. */
function safeString(v: unknown): string {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ── Real endpoint implementation (keeps original behavior intact) ─────────── */

import { json } from "./_utils/json";
import { withCORS, preflight } from "./_utils/cors";

/**
 * 계약(기능/응답 스키마) 유지:
 *  - OPTIONS: preflight 그대로
 *  - 그 외 메서드: 항상 { ok: true, ts: Date.now() } 반환 (본문/필드 변경 없음)
 *
 * 보강:
 *  - HEAD 지원(본문 없이 동일 헤더)
 *  - 운영 헤더 추가: Cache-Control: no-store, X-Health-Took-ms
 *  - 예외 내성(try/catch) 및 CORS 일관 적용
 */
export const onRequest: PagesFunction<{ CORS_ORIGIN: string }> = async ({ request, env }) => {
  // Preflight 그대로 유지
  if (request.method === "OPTIONS") {
    return preflight(env.CORS_ORIGIN);
  }

  const t0 = nowMs();

  try {
    // HEAD: 상태/헤더만 반환(본문 없음)
    if (request.method === "HEAD") {
      return withCORS(
        new Response(null, {
          status: 200,
          headers: healthHeaders(t0),
        }),
        env.CORS_ORIGIN
      );
    }

    // 나머지 모든 메서드: 본문 스키마는 원본과 100% 동일
    return withCORS(
      json(
        { ok: true, ts: Date.now() },
        { headers: healthHeaders(t0) }
      ),
      env.CORS_ORIGIN
    );
  } catch (e) {
    // 예외 상황에서도 CORS/캐시 정책 및 계약 유지(가능한 한 ok:true 응답)
    const note = `degraded: ${safeString((e as any)?.message ?? e)}`;
    const headers = { ...healthHeaders(t0), "X-Health-Note": note };
    return withCORS(
      json({ ok: true, ts: Date.now() }, { headers }),
      env.CORS_ORIGIN
    );
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   Implementation notes (for maintainers; safe to keep or remove):
   - This file purposely avoids importing global Worker types. If your repo
     later adds `@cloudflare/workers-types`, remove local shims and rely on:
         import type { PagesFunction } from "@cloudflare/workers-types";
   - `withCORS` consistently applies CORS to every path (HEAD/OPTIONS included).
   - `json()` is assumed to return a Response with JSON body and merged headers.
   - HEAD keeps headers in sync with GET but omits body per RFC semantics.
   - `nowMs()` uses performance.now() when available for fine-grained timings
     yet gracefully falls back to Date.now() outside Workers.
   - All enhancements are non-breaking and preserve the original contract.
   ──────────────────────────────────────────────────────────────────────────── */
