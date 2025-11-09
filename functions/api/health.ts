// ──────────────────────────────────────────────────────────────────────────────
// health.ts — Cloudflare Pages Functions compatible, type-safe health endpoint
// - Keeps original contract 100%: non-OPTIONS → { ok: true, ts: number }
// - Adds: HEAD support (no body), no-store caching, timing/diagnostic headers,
//         optional Neon(DB) health probe (headers only),
//         robust local shims so it compiles without @cloudflare/workers-types.
// - No external deps; works in plain TS builds and Workers Runtime.
//
// Error notes (original):
//   1) TS2304: Cannot find name 'PagesFunction'
//      → Provide minimal local shims for PagesFunction and context types.
//   2) TS7031: Binding element 'request'/'env' implicitly has an 'any' type
//      → Context typed via our local PagesFunction<E> definition.
//
// Enhancement notes (this version):
//   - CORS behavior keeps using project utilities: preflight(), withCORS().
//   - DB health is OPTIONAL and triggered by query flags to preserve contract:
//       * ?db=1  or  ?check=db           → probe DB
//     Results surface ONLY in headers (X-DB-*) to avoid body schema changes.
//   - Extra safety headers + diagnostics for SRE-friendly observability.
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
    // @ts-ignore - performance exists in Workers & browsers
    const p = (globalThis as any).performance;
    return p && typeof p.now === "function" ? Math.round(p.now()) : Date.now();
  } catch {
    return Date.now();
  }
}

/* Build standard response headers for this endpoint in one place. */
function baseHealthHeaders(startMs: number): Record<string, string> {
  const took = String(nowMs() - startMs);
  return {
    "Cache-Control": "no-store",
    "X-Health-Took-ms": took,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
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

/* Parse simple truthy flags from query (?db=1, ?db=true) */
function truthyFlag(val: string | null): boolean {
  if (!val) return false;
  const s = val.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

/* ── Project utilities (existing) ──────────────────────────────────────────── */
import { json } from "./_utils/json";
import { withCORS, preflight } from "./_utils/cors";

// Neon health utility (optional probe). We keep it isolated to preserve startup cost.
import type { Env as DbEnv } from "./_utils/db";
import { dbHealth } from "./_utils/db";

/**
 * 계약(기능/응답 스키마) 유지:
 *  - OPTIONS: preflight 그대로
 *  - 그 외 메서드: 항상 { ok: true, ts: Date.now() } 반환 (본문/필드 변경 없음)
 *
 * 보강:
 *  - HEAD 지원(본문 없이 동일 헤더)
 *  - 운영 헤더 추가: Cache-Control: no-store, X-Health-Took-ms (+ 보안 헤더 일부)
 *  - Neon(DB) 헬스는 쿼리 플래그로만 수행하고, 결과는 헤더(X-DB-*)로만 노출
 *  - 예외 내성(try/catch) 및 CORS 일관 적용
 */
export const onRequest: PagesFunction<
  { CORS_ORIGIN: string } & Partial<DbEnv>
> = async ({ request, env }) => {
  // Preflight 그대로 유지
  if (request.method === "OPTIONS") {
    return preflight(env.CORS_ORIGIN);
  }

  const t0 = nowMs();
  const url = new URL(request.url);

  // 플래그: DB 헬스체크 트리거 (헤더에만 반영)
  const shouldCheckDb =
    truthyFlag(url.searchParams.get("db")) ||
    (url.searchParams.get("check") || "").toLowerCase() === "db";

  // 공통 헤더 기본값
  const headers: Record<string, string> = { ...baseHealthHeaders(t0) };

  try {
    // (옵션) DB 헬스 수행 — 결과를 헤더에만 기록
    if (shouldCheckDb) {
      try {
        const res = await dbHealth(env as unknown as DbEnv);
        if (res.ok) {
          headers["X-DB-Ok"] = "true";
          headers["X-DB-Took-ms"] = String(res.took_ms);
        } else {
          headers["X-DB-Ok"] = "false";
          headers["X-DB-Error"] = String(res.error || "unknown");
          headers["X-DB-Took-ms"] = String(res.took_ms);
        }
      } catch (dbErr: any) {
        headers["X-DB-Ok"] = "false";
        headers["X-DB-Error"] = safeString(dbErr?.message ?? dbErr);
      }
    }

    // HEAD: 상태/헤더만 반환(본문 없음)
    if (request.method === "HEAD") {
      return withCORS(new Response(null, { status: 200, headers }), env.CORS_ORIGIN);
    }

    // 나머지 모든 메서드: 본문 스키마는 원본과 100% 동일
    return withCORS(
      json(
        { ok: true, ts: Date.now() },
        { headers }
      ),
      env.CORS_ORIGIN
    );
  } catch (e) {
    // 예외 상황에서도 CORS/캐시 정책 및 계약 유지(가능한 한 ok:true 응답)
    const note = `degraded: ${safeString((e as any)?.message ?? e)}`;
    headers["X-Health-Note"] = note;

    // HEAD/GET/POST 등 모든 비-OPTIONS 경로에서 스키마 유지
    if (request.method === "HEAD") {
      return withCORS(new Response(null, { status: 200, headers }), env.CORS_ORIGIN);
    }
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
   - `nowMs()` uses performance.now() when available for fine-grained timings,
     yet gracefully falls back to Date.now() outside Workers.
   - DB health probe is purely optional (query opt-in) and affects headers only,
     ensuring the body contract remains unchanged for all clients.
   - Extra headers (X-Content-Type-Options, Referrer-Policy) are lightweight
     security wins without breaking caches or CORS behavior.
   ──────────────────────────────────────────────────────────────────────────── */
