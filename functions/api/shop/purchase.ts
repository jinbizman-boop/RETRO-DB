// functions/api/shop/purchase.ts
// ───────────────────────────────────────────────────────────────
// RETRO-GAMES Cloudflare API: 상점 아이템 구매
//
// - 인증 필수 (JWT → _middleware → data.auth.userId)
// - shop_items 에 정의된 item_key 를 기반으로
//   • ticket_*   → user_wallet / user_stats.tickets 증가
//   • exp_boost* → 추후 부스트 로직 확장 가능 (지금은 analytics 에만 기록)
// - analytics_events 에 'shop_purchase' 이벤트 기록
// - DB 실제 컬럼( item_key / price_points / is_active … )에 맞게 매핑
// ───────────────────────────────────────────────────────────────

import { json, readJSON } from "../_utils/json";
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

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type PurchasePayload = {
  itemId?: number;
  name?: string;
};

function parsePurchaseBody(body: unknown): PurchasePayload {
  const b = body as any;
  const itemId = toNumber(b?.itemId);
  const name = toStringOrNull(b?.name);
  if (!itemId && !name) {
    throw new Error("item_required");
  }
  return {
    itemId: itemId ?? undefined,
    name: name ?? undefined,
  };
}

function getClientMeta(request: Request) {
  const headers = request.headers;
  const ip =
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    null;
  const ua = headers.get("user-agent") || null;
  return { ip, ua };
}

/* ───────── Handler ───────── */
export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
  data,
}) => {
  // Preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "POST") {
    return withCORS(
      json({ error: "method_not_allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

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
    // 인증 정보 (signup/login + _middleware 연동)
    const auth = (data?.auth || data?.user || {}) as
      | { userId?: string; id?: string }
      | undefined;
    const userId =
      toStringOrNull((auth as any)?.userId) ||
      toStringOrNull((auth as any)?.id);

    if (!userId) {
      return withCORS(
        json({ error: "unauthorized" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    const body = await readJSON(request);
    const { itemId, name } = parsePurchaseBody(body);
    const { ip, ua } = getClientMeta(request);

    const sql = getSql(env);

    // shop_items 테이블 존재 확인
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
        json({ error: "shop_not_ready" }, { status: 500 }),
        env.CORS_ORIGIN
      );
    }

    // 대상 아이템 조회 (DB 실제 컬럼 → 예상 컬럼으로 매핑)
    let rows: any[];
    if (itemId != null) {
      rows = await sql/* sql */`
        select
          id,
          item_key,
          name,
          description,
          price_points                                  as price_coins,
          price_tickets,
          duration_sec,
          max_stack,
          is_active                                     as active,
          -- 가상 컬럼들 (list.ts 와 동일한 규칙)
          case
            when item_key like 'ticket_%'    then 'ticket'
            when item_key like 'exp_boost_%' then 'booster'
            else 'other'
          end                                           as item_type,
          case
            when item_key like 'ticket_%'    then 'tickets'
            when item_key like 'exp_boost_%' then 'exp_multiplier'
            else null
          end                                           as effect_key,
          case
            when item_key = 'ticket_small'  then 5
            when item_key = 'ticket_medium' then 10
            when item_key = 'ticket_large'  then 20
            when item_key = 'exp_boost_10'  then 10
            when item_key = 'exp_boost_20'  then 20
            else null
          end::bigint                                   as effect_value
        from shop_items
        where id = ${itemId}
          and is_active = true
      `;
    } else {
      rows = await sql/* sql */`
        select
          id,
          item_key,
          name,
          description,
          price_points                                  as price_coins,
          price_tickets,
          duration_sec,
          max_stack,
          is_active                                     as active,
          case
            when item_key like 'ticket_%'    then 'ticket'
            when item_key like 'exp_boost_%' then 'booster'
            else 'other'
          end                                           as item_type,
          case
            when item_key like 'ticket_%'    then 'tickets'
            when item_key like 'exp_boost_%' then 'exp_multiplier'
            else null
          end                                           as effect_key,
          case
            when item_key = 'ticket_small'  then 5
            when item_key = 'ticket_medium' then 10
            when item_key = 'ticket_large'  then 20
            when item_key = 'exp_boost_10'  then 10
            when item_key = 'exp_boost_20'  then 20
            else null
          end::bigint                                   as effect_value
        from shop_items
        where name = ${name}
          and is_active = true
      `;
    }

    if (!rows?.length) {
      return withCORS(
        json({ error: "item_not_found" }, { status: 404 }),
        env.CORS_ORIGIN
      );
    }

    const item = rows[0];

    const priceCoins = toNumber(item.price_coins) ?? 0;
    const effectKey = toStringOrNull(item.effect_key);
    const effectValue = toNumber(item.effect_value) ?? 0;
    const itemType = toStringOrNull(item.item_type);

    // user_wallet / user_stats row 보정 (없으면 생성)
    await sql/* sql */`
      insert into user_wallet (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;
    await sql/* sql */`
      insert into user_stats (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;

    // 현재 지갑 상태 조회
    const [wallet] = await sql/* sql */`
      select points, tickets
      from user_wallet
      where user_id = ${userId}::uuid
      for update
    `;

    const currentPoints = toNumber(wallet?.points) ?? 0;
    const currentTickets = toNumber(wallet?.tickets) ?? 0;

    if (priceCoins > currentPoints) {
      return withCORS(
        json(
          {
            error: "insufficient_points",
            required: priceCoins,
            current: currentPoints,
          },
          { status: 400 }
        ),
        env.CORS_ORIGIN
      );
    }

    // ───── 포인트 차감 + 효과 적용 ─────

    // 1) 포인트 차감
    await sql/* sql */`
      update user_wallet
      set points = points - ${priceCoins}
      where user_id = ${userId}::uuid
    `;

    let ticketsGained = 0;

    // 2) 효과 적용
    if (itemType === "ticket" || effectKey === "tickets") {
      ticketsGained = effectValue;

      await sql/* sql */`
        update user_wallet
        set tickets = tickets + ${ticketsGained}
        where user_id = ${userId}::uuid
      `;

      await sql/* sql */`
        update user_stats
        set tickets = tickets + ${ticketsGained}
        where user_id = ${userId}::uuid
      `;
    } else if (itemType === "booster" && effectKey === "exp_multiplier") {
      // EXP 부스트 아이템은, 나중에 user_effects 같은 테이블 도입 시
      // 거기에 기간/배율로 기록하는 구조로 쉽게 확장 가능.
      // 여기서는 "구매했다"는 사실만 analytics 에 남긴다.
    }

    // analytics_events: shop_purchase 기록
    await sql/* sql */`
      insert into analytics_events (user_id, event_name, game_id, score, metadata)
      values (
        ${userId}::uuid,
        'shop_purchase',
        null,
        null,
        ${JSON.stringify({
          ip,
          ua,
          itemId: item.id,
          name: item.name,
          itemType,
          effectKey,
          effectValue,
          priceCoins,
          ticketsGained,
          before: {
            points: currentPoints,
            tickets: currentTickets,
          },
          after: {
            points: currentPoints - priceCoins,
            tickets: currentTickets + ticketsGained,
          },
        })}::jsonb
      )
    `;

    // 최종 스냅샷
    const [walletAfter] = await sql/* sql */`
      select points, tickets
      from user_wallet
      where user_id = ${userId}::uuid
    `;

    const tookMs = Math.round(performance.now() - started);

    return withCORS(
      json(
        {
          ok: true,
          item: {
            id: item.id,
            name: item.name,
            itemType,
            priceCoins,
            effectKey,
            effectValue,
          },
          delta: {
            points: -priceCoins,
            tickets: ticketsGained,
          },
          wallet: walletAfter || null,
          meta: {
            tookMs,
          },
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Shop-Purchase-Took-ms": String(tookMs),
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
