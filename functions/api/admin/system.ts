// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\admin\system.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";

/**
 * 문제 증상
 * - ts(2304) `Cannot find name 'PagesFunction'`
 * - ts(7031) 구조 분해 매개변수(request/env) 암시적 any
 *
 * 해결 방법 (계약/기능 100% 유지)
 * - 파일 내부에 Cloudflare Pages에서 필요한 최소 타입만 선언(ambient minimal type)
 * - onRequest의 매개변수 타입 명시
 *
 * 런타임 동작/응답 스키마/라우팅은 기존과 동일:
 *   GET /api/admin/system  →  { ok:true, version, runtime, now, uptime_* , request:{...} }
 */

/* ─────────────────────── Minimal Cloudflare Pages ambient ───────────────────────
   프로젝트에 @cloudflare/workers-types가 없어도 에디터/빌드 오류 없이 타입만 제공합니다.
   실제 런타임은 Cloudflare Fetch 환경입니다.
*/
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────────────── */

/* ───────────────────────────── 상수 & 유틸 ───────────────────────────── */
// 워커 인스턴스 기동 시각(업타임 계산용)
const STARTED_AT = Date.now();

function msToHuman(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

/* ───────────────────────────── 핸들러 ───────────────────────────── */
export const onRequest: PagesFunction<{ CORS_ORIGIN: string; APP_VERSION?: string }> = async (
  { request, env }: { request: Request; env: { CORS_ORIGIN: string; APP_VERSION?: string } }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  // 요청/엣지 메타 (가능한 값만 안전하게 추출)
  const h = request.headers;
  const now = Date.now();
  const uptimeMs = now - STARTED_AT;

  const info = {
    ok: true as const,
    version: env.APP_VERSION || "functions/1.0.0",
    runtime: "cloudflare-pages-functions",
    now,
    uptime_ms: uptimeMs,
    uptime_human: msToHuman(uptimeMs),

    // 요청 메타(운영 디버깅에 유용)
    request: {
      method: request.method,
      url: (() => {
        try {
          const u = new URL(request.url);
          return { pathname: u.pathname, search: u.search || "" };
        } catch {
          return { pathname: "/", search: "" };
        }
      })(),
      id: h.get("cf-ray") || null,
      ip: h.get("cf-connecting-ip") || null,
      country: h.get("cf-ipcountry") || null,
      user_agent: h.get("user-agent") || null,
      colo: (request as any)?.cf?.colo ?? null,           // 데이터센터 코드(예: ICN, NRT)
      tls: (request as any)?.cf?.tlsVersion ?? null,      // TLS 버전
    },
  };

  const took = Math.round(performance.now() - t0);

  return withCORS(
    json(info, {
      headers: {
        // 운영 친화 헤더
        "Cache-Control": "no-store",
        "X-System-Took-ms": String(took),
      },
    }),
    env.CORS_ORIGIN
  );
};
