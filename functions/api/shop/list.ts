// functions/api/shop/list.ts
// ───────────────────────────────────────────────────────────────
// RETRO-GAMES Cloudflare API: 상점 아이템 목록 조회
//
// - 활성화(active) 상태의 shop_items 리스트 반환
// - 정렬: id (seed 순서)
// - DB 실제 컬럼( item_key / price_points / is_active … )에 맞게 매핑
//   • item_type / effect_key / effect_value / effect_duration_minutes 등은
//     item_key 기준으로 계산해서 alias 로 제공
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
      const tookMs = Math.round(performance.now() - started);
      return withCORS(
        json(
          { ok: true, items: [], meta: { tookMs } },
          { headers: { "Cache-Control": "no-store" } }
        ),
        env.CORS_ORIGIN
      );
    }

    // item_type / effect_* 계산용 CASE 절
    const baseSelect = sql/* sql */`
      select
        id,
        name,
        -- item_type: item_key 기반 가상 컬럼
        case
          when item_key like 'ticket_%'    then 'ticket'
          when item_key like 'exp_boost_%' then 'booster'
          else 'other'
        end                                                   as item_type,
        -- effect_key: ticket → tickets, booster → exp_multiplier
        case
          when item_key like 'ticket_%'    then 'tickets'
          when item_key like 'exp_boost_%' then 'exp_multiplier'
          else null
        end                                                   as effect_key,
        -- effect_value: seed 에 맞춰 하드코딩(티켓 수 / %)
        case
          when item_key = 'ticket_small'  then 5
          when item_key = 'ticket_medium' then 10
          when item_key = 'ticket_large'  then 20
          when item_key = 'exp_boost_10'  then 10
          when item_key = 'exp_boost_20'  then 20
          else null
        end::bigint                                           as effect_value,
        -- duration: 부스트 계열만 분 단위로 환산 (없으면 null)
        case
          when item_key like 'exp_boost_%'
            then greatest(1, coalesce(duration_sec, 0) / 60)
          else null
        end::integer                                          as effect_duration_minutes,
        price_points                                          as price_coins,
        -- 기존 스키마 호환용 placeholder 컬럼들
        null::bigint                                          as stock,
        null::jsonb                                           as metadata,
        is_active                                             as active,
        id                                                    as sort_order,
        null::text[]                                          as tags
      from shop_items
      where is_active = true
    `;

    let rows: any[];

    if (typeFilter) {
      rows = await sql/* sql */`
        select *
        from (
          ${baseSelect}
        ) s
        where s.item_type = ${typeFilter}
        order by
          s.sort_order nulls last,
          s.price_coins nulls last,
          s.name asc
      `;
    } else {
      rows = await sql/* sql */`
        select *
        from (
          ${baseSelect}
        ) s
        order by
          s.sort_order nulls last,
          s.price_coins nulls last,
          s.name asc
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
