// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\admin\stats.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/**
 * 문제 원인
 * - VS Code/tsserver에서 Cloudflare Pages의 ambient 타입 `PagesFunction`을 찾지 못해
 *   ts(2304)가 발생하고, 구조 분해 매개변수(request, env)가 암시적 any로 경고(ts7031)가 납니다.
 *
 * 해결 전략 (계약 100% 유지)
 * - 파일 상단에 **극소한 전용 ambient 타입**을 선언하여 `PagesFunction`을 제공하고,
 *   onRequest의 파라미터 타입도 명시합니다. 런타임 동작/응답 형식/라우팅/기능은 동일합니다.
 *
 * 추가 보강
 * - 날짜 필터(from/to) 안전 파싱
 * - bigint/string 카운트 안전 변환
 * - 한 번의 라운드트립으로 집계, 실패 시 폴백 쿼리
 * - 처리시간/캐시 차단 운영 헤더
 */

/* ─────────────────────── Minimal Cloudflare Pages ambient ───────────────────────
   프로젝트에 @cloudflare/workers-types가 없어도 빌드/에디터 오류가 없도록 최소 타입만 제공합니다.
   실제 런타임은 Cloudflare가 제공하는 표준 Fetch API 환경을 사용합니다.
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

/* ─────────────────────────── Helpers ─────────────────────────── */
type CountRow = { users: number; scores: number; analytics: number };

function toNumberSafe(v: unknown): number {
  // Neon/PG가 bigint를 문자열로 반환하는 상황을 보수적으로 처리
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseIsoDate(s: string | null): string | null {
  if (!s) return null;
  try {
    // YYYY-MM-DD 또는 ISO8601 허용
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString(); // UTC ISO 문자열로 정규화
  } catch {
    return null;
  }
}

function headerNoStore(extra: Record<string, string> = {}): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

/* ─────────────────────────── Handler ─────────────────────────── */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);
    const from = parseIsoDate(url.searchParams.get("from"));
    const to   = parseIsoDate(url.searchParams.get("to"));

    const sql = getSql(env);

    // 기간 필터가 있으면 각 테이블 타임스탬프 컬럼에 적용
    // users.created_at / game_scores.created_at / analytics_events.created_at
    let row: CountRow | null = null;

    /* ───────── 전체 집계 ───────── */
    if (!from && !to) {
      try {
        const [r] = await sql`
          select
            (select count(*)::bigint from users)            as users,
            (select count(*)::bigint from game_scores)      as scores,
            (select count(*)::bigint from analytics_events) as analytics
        `;
        row = {
          users: toNumberSafe(r?.users ?? 0),
          scores: toNumberSafe(r?.scores ?? 0),
          analytics: toNumberSafe(r?.analytics ?? 0),
        };
      } catch {
        // 폴백(각각 개별 쿼리)
        const u = await sql`select count(*)::bigint as c from users`;
        const g = await sql`select count(*)::bigint as c from game_scores`;
        const a = await sql`select count(*)::bigint as c from analytics_events`;
        row = {
          users: toNumberSafe(u?.[0]?.c ?? 0),
          scores: toNumberSafe(g?.[0]?.c ?? 0),
          analytics: toNumberSafe(a?.[0]?.c ?? 0),
        };
      }
    } else {
      /* ───────── 기간 필터 집계 ───────── */
      const condUsers =
        from && to ? sql`created_at >= ${from} and created_at < ${to}`
      : from       ? sql`created_at >= ${from}`
      :              sql`created_at < ${to}`;

      const condScores =
        from && to ? sql`created_at >= ${from} and created_at < ${to}`
      : from       ? sql`created_at >= ${from}`
      :              sql`created_at < ${to}`;

      const condAnalytics =
        from && to ? sql`created_at >= ${from} and created_at < ${to}`
      : from       ? sql`created_at >= ${from}`
      :              sql`created_at < ${to}`;

      try {
        const [r] = await sql`
          select
            (select count(*)::bigint from users where ${condUsers})                as users,
            (select count(*)::bigint from game_scores where ${condScores})         as scores,
            (select count(*)::bigint from analytics_events where ${condAnalytics}) as analytics
        `;
        row = {
          users: toNumberSafe(r?.users ?? 0),
          scores: toNumberSafe(r?.scores ?? 0),
          analytics: toNumberSafe(r?.analytics ?? 0),
        };
      } catch {
        // 폴백(각각 개별 쿼리)
        const u = await sql`select count(*)::bigint as c from users where ${condUsers}`;
        const g = await sql`select count(*)::bigint as c from game_scores where ${condScores}`;
        const a = await sql`select count(*)::bigint as c from analytics_events where ${condAnalytics}`;
        row = {
          users: toNumberSafe(u?.[0]?.c ?? 0),
          scores: toNumberSafe(g?.[0]?.c ?? 0),
          analytics: toNumberSafe(a?.[0]?.c ?? 0),
        };
      }
    }

    const took = Math.round(performance.now() - t0);

    // 기존 계약 유지: { ok: true, totals: { users, scores, analytics } }
    return withCORS(
      json(
        { ok: true, totals: row! },
        { headers: headerNoStore({ "X-Stats-Took-ms": String(took) }) }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: headerNoStore() }
      ),
      env.CORS_ORIGIN
    );
  }
};
