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
//   - 내부적으로 타입/빌드 오류가 발생하지 않도록 모든 타입/유틸을
//     한 파일 안에서 일관되게 정의/사용한다.
// ──────────────────────────────────────────────────────────────────────────────

/* ── Local runtime/typing shims (no external type packages required) ───────── */
// These shims are intentionally minimal and align with Workers Runtime shape.
// If your project already includes `@cloudflare/workers-types`, you can remove
// this block safely and instead:
//
//   import type { PagesFunction } from "@cloudflare/workers-types";
//
type CfContext<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  data?: unknown;
};

// Handler signature used by Cloudflare Pages Functions.
type PagesFunction<E = unknown> = (
  ctx: CfContext<E>
) => Response | Promise<Response>;

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

/* Parse simple truthy flags from query (?db=1, ?db=true, ?db=yes, ?db=y) */
function truthyFlag(val: string | null): boolean {
  if (!val) return false;
  const s = val.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

/* ── Project utilities (existing) ──────────────────────────────────────────── */
// NOTE: 경로는 실제 레포 구조에 맞게 `functions/api/_utils/*` 기준으로 맞춰져 있음.
// health.ts 와 같은 디렉터리(`functions/api/`)에 있기 때문에 `./_utils/...` 사용.
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
 *
 * Cloudflare Pages 라우팅:
 *  - 이 파일 위치:  functions/api/health.ts
 *  - 실제 경로:    /api/health
 */
export const onRequest: PagesFunction<
  { CORS_ORIGIN: string } & Partial<DbEnv>
> = async ({ request, env }) => {
  // 0) OPTIONS: CORS preflight 는 기존 유틸로 그대로 처리
  if (request.method === "OPTIONS") {
    // env.CORS_ORIGIN 이 undefined 이어도 preflight() 내부에서 안전 처리
    return preflight((env as any).CORS_ORIGIN);
  }

  // 1) 공통 타이밍/진단 셋업
  const t0 = nowMs();
  const url = new URL(request.url);

  // 2) 플래그: DB 헬스체크 트리거 (헤더에만 반영)
  const shouldCheckDb =
    truthyFlag(url.searchParams.get("db")) ||
    (url.searchParams.get("check") || "").toLowerCase() === "db";

  // 3) 공통 헤더 기본값
  const headers: Record<string, string> = { ...baseHealthHeaders(t0) };

  try {
    // 4) (옵션) DB 헬스 수행 — 결과를 헤더에만 기록, body 스키마는 절대 변경 X
    if (shouldCheckDb) {
      try {
        const res = await dbHealth(env as unknown as DbEnv);

        if (res.ok) {
          headers["X-DB-Ok"] = "true";
          headers["X-DB-Took-ms"] = String(res.took_ms);
          if (res.dsn) headers["X-DB-DSN"] = res.dsn; // 선택적 추가정보
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

    // 5) HEAD: 상태/헤더만 반환(본문 없음) — 모니터링 툴에서 사용 용이
    if (request.method === "HEAD") {
      // withCORS: CORS_ORIGIN 이 없으면 기본 CORS 처리(프로젝트 유틸 기준)
      return withCORS(
        new Response(null, { status: 200, headers }),
        (env as any).CORS_ORIGIN
      );
    }

    // 6) 나머지 모든 메서드(GET/POST 등): 본문 스키마는 원본과 100% 동일
    return withCORS(
      json(
        { ok: true, ts: Date.now() },
        { headers } // json 유틸이 헤더 merge
      ),
      (env as any).CORS_ORIGIN
    );
  } catch (e) {
    // 7) 예외 상황에서도 CORS/캐시 정책 및 계약 유지(가능한 한 ok:true 응답)
    const note = `degraded: ${safeString((e as any)?.message ?? e)}`;
    headers["X-Health-Note"] = note;

    // HEAD/GET/POST 등 모든 비-OPTIONS 경로에서 스키마 유지
    if (request.method === "HEAD") {
      return withCORS(
        new Response(null, { status: 200, headers }),
        (env as any).CORS_ORIGIN
      );
    }

    return withCORS(
      json(
        { ok: true, ts: Date.now() },
        { headers }
      ),
      (env as any).CORS_ORIGIN
    );
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   Implementation notes (for maintainers; safe to keep or remove):

   1. 타입/빌드 관점
   -----------------
   - 이 파일은 로컬 tsc 빌드(tsconfig.json 의 "lib": ["ES2022","WebWorker"])
     와 Cloudflare Pages Functions 번들 모두에서 컴파일 가능하도록
     Request/Response/URL 등의 Web 표준 전역 타입만 사용합니다.
   - @cloudflare/workers-types 를 프로젝트에 추가했다면, 상단의 local
     PagesFunction 정의 부분을 제거하고 공식 타입을 import 해도 됩니다.
       예)
         import type { PagesFunction } from "@cloudflare/workers-types";
   - PagesFunction 제네릭 타입은 onRequest 선언부에서만 사용되며,
     런타임 코드로 번들되지 않습니다(타입 전용).

   2. CORS & 캐시
   ---------------
   - preflight(), withCORS() 는 functions/api/_utils/cors.ts 의 구현을 그대로
     사용하며, env.CORS_ORIGIN 이 설정되지 않은 경우에도 안전하게 동작하도록
     설계되어 있다고 가정합니다.
   - Cache-Control: no-store 로 응답이 항상 캐시되지 않도록 보장합니다.
     (헬스 체크 응답은 일반적으로 캐시되면 안 되기 때문에 기본 전략입니다.)
   - X-Content-Type-Options, Referrer-Policy 등은 보안 헤더 강화를 위해
     baseHealthHeaders() 에서 한 번에 설정합니다.

   3. DB 헬스체크 (옵션)
   ---------------------
   - ?db=1 또는 ?check=db 로 호출하면 dbHealth() 를 통해 Neon 연결 상태를
     확인하고, 결과를 X-DB-* 헤더에만 남깁니다.
   - 이 플래그를 쓰지 않는 한, DB 를 전혀 건드리지 않으므로 장애 상황에도
     /api/health 기본 동작은 최대한 보장됩니다.
   - dbHealth(env as DbEnv) 의 반환 타입 가정:
       { ok: boolean; took_ms: number; error?: string; dsn?: string }
     이런 형태로 동작한다고 가정하고 헤더를 세팅합니다.
   - DB 체크가 실패하더라도(타임아웃, 예외 등) /api/health 응답 자체는
     { ok:true, ts } 스키마를 유지하고, X-DB-Ok=false, X-DB-Error 헤더에만
     실패 정보를 담습니다.

   4. Cloudflare Pages 배포와의 관계
   ---------------------------------
   - 이 health.ts 는 ES Module + 타입 only 코드로 구성되어 있으며
     NodeJS 전용 API(require, fs 등)는 전혀 사용하지 않기 때문에
     Pages 빌드 실패의 직접적인 원인이 되지 않습니다.
   - 과거 빌드 실패 로그에서 나타난 문제는 health.ts 가 아니라
     wallet.ts 가 `_utils/json.ts` 에 존재하지 않는 badRequest 를
     import 하려다 실패했던 경우입니다.
       (지금은 wallet.ts 에서 로컬 badRequest 헬퍼를 사용하도록 수정됨)
   - GitHub 커밋 옆에 빨간 X 가 뜨는 경우는 health.ts 보다는
     전체 Functions 번들 중 다른 파일의 타입/빌드 문제일 가능성이 큽니다.
   - wrangler.toml 에서 pages_build_output_dir="public" 으로 설정되어
     있다면, Cloudflare Pages 대시보드에서도 Output directory 를
     "public" 으로 맞추고, 별도의 Build command 는 비워 두는 구성이
     이 레포 구조에 가장 안전합니다.

   5. 직접 점검 방법
   ------------------
   - 브라우저/포스트맨에서:
       GET  https://<your-domain>/api/health
     응답(body):
       { "ok": true, "ts": <number> }
     응답(headers):
       X-Health-Took-ms: <number>
       Cache-Control: no-store
       X-Content-Type-Options: nosniff
       Referrer-Policy: strict-origin-when-cross-origin
       (그 외 CORS 관련 헤더는 withCORS/preflight 에 따라 추가)
   - DB 포함 체크:
       GET  https://<your-domain>/api/health?db=1
     응답 body 는 동일하고, 헤더에 X-DB-Ok, X-DB-Took-ms, (필요 시 X-DB-Error)
     등이 추가됩니다.
   - HEAD 체크:
       HEAD https://<your-domain>/api/health
     응답 status: 200
     응답 body: 없음
     응답 headers: GET 과 동일한 X-Health-*/X-DB-* 기반의 진단 헤더만 반환.

   6. 향후 확장 시 주의사항
   ------------------------
   - /api/health 의 계약(Contract)을 깨면 안 되는 경우:
       * 모니터링/로드밸런서/업타임 체크 도구 등이 단순히
         { ok:true, ts:number } 형태만 기대하고 있을 수 있습니다.
       * body 필드를 추가하고 싶다면, 모니터링 도구에 영향이 없는지
         먼저 확인해야 합니다.
   - DB 헬스 체크 로직을 확장할 때:
       * 추가로 Redis, 외부 API 등 다른 의존성 상태를 체크하고 싶다면
         각각 X-REDIS-*, X-API-* 와 같이 헤더 네임스페이스를 분리하는 것이
         안전합니다.
       * body 스키마는 그대로 두고, 헤더만 확장하는 패턴을 유지하면
         기존 클라이언트와의 호환성이 유지됩니다.
   - CORS_ORIGIN 처리:
       * env.CORS_ORIGIN 이 설정되지 않았을 때의 기본 CORS 정책은
         _utils/cors.ts 에서 통제합니다.
       * 여러 도메인을 허용해야 한다면, 해당 유틸 구현을 수정하는 편이
         좋고, health.ts 에서는 그 유틸을 그대로 호출만 하도록 유지합니다.

   7. 로컬 개발 & 디버깅 팁
   ------------------------
   - 로컬에서 wrangler 를 이용해 Pages Functions 를 테스트할 때:
       wrangler pages dev public --local
     로 서버를 띄운 뒤, http://127.0.0.1:8788/api/health 같은 URL로
     직접 GET/HEAD 요청을 보내 확인할 수 있습니다.
   - 로그 확인:
       - try/catch 블록에서 던져진 예외는 이 파일에서는 직접 console.error
         로 찍지 않지만, 상위 런타임에서 잡힌 에러는 wrangler 로그나
         Cloudflare 대시보드의 Functions 로그에서 확인할 수 있습니다.
   - 만약 이 파일 때문에 빌드 오류가 발생하면, Cloudflare 로그 상단에
     `api/health.ts` 경로가 직접 찍히기 때문에 문제 위치를 빠르게
     특정할 수 있습니다.

   8. 기타
   -------
   - 이 파일은 health check 용도로만 사용되므로, 비즈니스 로직(게임/지갑 등)과
     완전히 분리되어 있습니다.
   - /api/wallet, /api/auth/* 등 다른 엔드포인트의 빌드/런타임 오류는
     이 파일과 무관하며, 각각의 파일에서 해결해야 합니다.
   - 현재 버전에서는 Known issue 였던 badRequest import 문제,
     타입 중복 정의, 잘못된 json() 인자 등의 버그를 모두 제거하고
     Cloudflare Pages 에서 안정적으로 빌드/배포될 수 있도록 정리된
     통합 버전입니다.
   ──────────────────────────────────────────────────────────────────────────── */
