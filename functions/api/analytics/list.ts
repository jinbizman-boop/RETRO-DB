// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\analytics\list.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/**
 * 문제 증상
 * - ts(2304): `PagesFunction` 타입을 찾지 못함
 * - ts(7031): 구조 분해 매개변수(request/env)가 암시적 any
 *
 * 해결 (계약/기능 100% 유지)
 * - 파일 내부에 Cloudflare Pages용 최소 ambient 타입 선언
 * - onRequest 인자 타입 명시
 * - 기존 응답 스키마/쿼리 파라미터/로직은 동일
 */

/* ────────────────── Minimal Cloudflare Pages ambient types ────────────────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ──────────────────────────────────────────────────────────────────────────── */

/* ───────────────────────────── Types & Helpers ───────────────────────────── */
type Row = {
  id: number | string | bigint;
  event: string;
  user_id: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: any;
  created_at: string;
};

function toNumberSafe(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isoOrNull(s: string | null): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function isMissingTable(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

function headerNoStore(extra: Record<string, string> = {}): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

/* ───────────────────────────────── Handler ───────────────────────────────── */
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

    // ---- 안전한 쿼리 파라미터 처리(기본값은 기존과 동일) ----
    const limitRaw   = url.searchParams.get("limit");
    const beforeIdRaw = url.searchParams.get("before_id");      // seek 기반 페이지네이션(이전 페이지)
    const eventFilter = url.searchParams.get("event")?.trim() || null;
    const userIdFilter = url.searchParams.get("userId")?.trim() || null;
    const sinceIso = isoOrNull(url.searchParams.get("since"));   // 시작 시점(이상)
    const toIso    = isoOrNull(url.searchParams.get("to"));      // 종료 시점(미만)

    const limit    = Math.max(1, Math.min(500, limitRaw ? Number(limitRaw) : 100));
    const beforeId = beforeIdRaw ? Number(beforeIdRaw) : null;

    const sql = getSql(env);

    // 존재하지 않는 테이블에서도 안전하게 동작하도록 try/catch
    let rows: Row[] = [];
    try {
      rows = await sql`
        select id::bigint as id, event, user_id, meta, created_at
        from analytics_events
        where 1=1
          ${eventFilter ? sql`and event = ${eventFilter}` : sql``}
          ${userIdFilter ? sql`and user_id = ${userIdFilter}` : sql``}
          ${sinceIso ? sql`and created_at >= ${sinceIso}` : sql``}
          ${toIso ? sql`and created_at < ${toIso}` : sql``}
          ${beforeId !== null ? sql`and id < ${beforeId}` : sql``}
        order by id desc
        limit ${limit}
      `;
    } catch (e) {
      if (isMissingTable(e)) {
        // 초기 상태(테이블 미생성)에서는 빈 리스트로 응답 — 계약 유지
        rows = [];
      } else {
        throw e;
      }
    }

    // bigint → number 변환 등 안전 정규화
    const safe = rows.map((r) => ({
      id: toNumberSafe(r.id),
      event: r.event,
      user_id: r.user_id,
      meta: r.meta, // JSONB 그대로 전달
      created_at: typeof r.created_at === "string" ? r.created_at : String(r.created_at),
    }));

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true, rows: safe },
        {
          headers: headerNoStore({
            "X-Analytics-Limit": String(limit),
            "X-Analytics-Before-Id": beforeId !== null ? String(beforeId) : "",
            "X-Analytics-Took-ms": String(took),
          }),
        }
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
