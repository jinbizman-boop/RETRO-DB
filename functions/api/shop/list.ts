// functions/api/shop/list.ts
// ───────────────────────────────────────────────────────────────
// RETRO-GAMES Cloudflare API: 상점 아이템 목록 조회
//
// - 활성화(active) & 비아카이브(archived=false) 상태의 shop_items 리스트 반환
// - 정렬: sort_order → price_coins → name
// - CORS / Rate-limit / 응답 포맷은 signup/login/game 과 동일 스타일
// ───────────────────────────────────────────────────────────────

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

/* ───────── Cloudflare Pages ambient types ───────── */
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

/* ───────── Helpers ───────── */
function toStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

/* ───────── Handler ───────── */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  // Preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "GET") {
    return withCORS(
      json({ error: "method_not_allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // Rate limit (상점 리스트도 기본 방어)
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
    const url = new URL(request.url);
    const typeFilter = toStringOrNull(url.searchParams.get("type")); // ?type=ticket | booster ...

    const sql = getSql(env);

    // shop_items 테이블이 없으면 빈 목록 리턴 (front 에서 graceful degrade)
    const [{ exists }] = await sql/* sql */`
      select exists (
        select 1
        from   information_schema.tables
        where  table_schema = 'public'
        and    table_name   = 'shop_items'
      ) as exists
    `;

    if (!exists) {
      return withCORS(
        json(
          { ok: true, items: [], meta: { tookMs: Math.round(performance.now() - started) } },
          { headers: { "Cache-Control": "no-store" } }
        ),
        env.CORS_ORIGIN
      );
    }

    // 기본 쿼리: active & !archived
    let rows: any[];

    if (typeFilter) {
      rows = await sql/* sql */`
        select
          id,
          name,
          item_type,
          effect_key,
          effect_value,
          effect_duration_minutes,
          price_coins,
          stock,
          metadata,
          active,
          sort_order,
          tags
        from shop_items
        where active = true
          and coalesce(archived, false) = false
          and item_type = ${typeFilter}
        order by
          sort_order nulls last,
          price_coins nulls last,
          name asc
      `;
    } else {
      rows = await sql/* sql */`
        select
          id,
          name,
          item_type,
          effect_key,
          effect_value,
          effect_duration_minutes,
          price_coins,
          stock,
          metadata,
          active,
          sort_order,
          tags
        from shop_items
        where active = true
          and coalesce(archived, false) = false
        order by
          sort_order nulls last,
          price_coins nulls last,
          name asc
      `;
    }

    const tookMs = Math.round(performance.now() - started);

    return withCORS(
      json(
        {
          ok: true,
          items: rows,
          meta: {
            count: rows.length,
            tookMs,
          },
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Shop-List-Took-ms": String(tookMs),
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
