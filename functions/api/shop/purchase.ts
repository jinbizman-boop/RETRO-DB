// functions/api/shop/purchase.ts
// ------------------------------------------------------------------
// POST /api/shop/purchase
// - ✅ canonical: transactions + user_stats(trigger) 기반
// - ✅ shop_orders 기록 + idempotency 로 중복구매 방지
// - ✅ user_wallet 테이블 의존 제거
// ------------------------------------------------------------------

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

// tiny ambient types (에디터/빌드 타입 보호)
type PagesFunctionContext<E = unknown> = {
  request: Request;
  env: E;
  params: Record<string, string>;
  data?: Record<string, unknown>;
  waitUntil(promise: Promise<any>): void;
  next(): Promise<Response>;
};
type PagesFunction<E = unknown> = (
  ctx: PagesFunctionContext<E>
) => Promise<Response> | Response;

function str(v: any) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function num(v: any, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function clampInt(v: any, min: number, max: number, def: number) {
  const n = Math.trunc(num(v, def));
  return Math.max(min, Math.min(max, n));
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;

  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ ok: false, error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // rate-limit
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await Rate.allow(request))) {
    return withCORS(json({ ok: false, error: "Too Many Requests" }, { status: 429 }), env.CORS_ORIGIN);
  }

  const sql = getSql(env);

  try {
    // auth: middleware 주입 우선, 없으면 body.userId fallback
    const body = await readJSON(request);

    const authUserId =
      str((ctx as any)?.data?.auth?.userId) ||
      str((ctx as any)?.data?.user?.id) ||
      "";

    const userId = authUserId || str((body as any)?.userId);
    if (!userId) return withCORS(json({ ok: false, error: "unauthorized" }, { status: 401 }), env.CORS_ORIGIN);

    const itemId = str((body as any)?.itemId);
    const sku = str((body as any)?.sku);
    const name = str((body as any)?.name);
    const qty = clampInt((body as any)?.qty, 1, 99, 1);

    const payWithRaw = str((body as any)?.payWith).toLowerCase(); // "coins" | "tickets"
    // header idempotency 우선
    const idemHeader = request.headers.get("Idempotency-Key") || request.headers.get("X-Idempotency-Key") || "";
    const idemKey = idemHeader || `shop:${userId}:${itemId || sku || name}:${qty}:${payWithRaw || "auto"}`;

    // 아이템 조회 (id > sku > name)
    const [item] = await sql/*sql*/`
      select
        id,
        sku,
        name,
        description,
        category,
        is_active,
        price_coins,
        price_tickets,
        wallet_coins_delta,
        wallet_tickets_delta,
        wallet_exp_delta,
        effect_key,
        effect_value,
        effect_duration_minutes,
        inventory_grant_sku,
        inventory_grant_amount
      from shop_items
      where
        (
          (${itemId} <> '' and id = ${itemId}::uuid)
          or
          (${itemId} = '' and ${sku} <> '' and sku = ${sku})
          or
          (${itemId} = '' and ${sku} = '' and ${name} <> '' and name = ${name})
        )
      limit 1
    `;

    if (!item) return withCORS(json({ ok: false, error: "item_not_found" }, { status: 404 }), env.CORS_ORIGIN);
    if (!(item as any).is_active) return withCORS(json({ ok: false, error: "item_inactive" }, { status: 400 }), env.CORS_ORIGIN);

    const priceCoins = Math.trunc(num((item as any).price_coins, 0)) * qty;
    const priceTickets = Math.trunc(num((item as any).price_tickets, 0)) * qty;

    const grantCoins = Math.trunc(num((item as any).wallet_coins_delta, 0)) * qty;
    const grantTickets = Math.trunc(num((item as any).wallet_tickets_delta, 0)) * qty;
    const grantExp = Math.trunc(num((item as any).wallet_exp_delta, 0)) * qty;

    // payWith 결정
    const payWith =
      payWithRaw === "tickets" ? "tickets" :
      payWithRaw === "coins" ? "coins" :
      (priceCoins > 0 ? "coins" : (priceTickets > 0 ? "tickets" : "coins"));

    const costCoins = payWith === "coins" ? priceCoins : 0;
    const costTickets = payWith === "tickets" ? priceTickets : 0;

    // ✅ net delta (trigger가 user_stats 갱신)
    const coinsDelta = grantCoins - costCoins;                 // transactions.amount
    const ticketsDelta = grantTickets - costTickets;           // transactions.tickets_delta
    const expDelta = grantExp;                                 // transactions.exp_delta

    const ua = request.headers.get("User-Agent") || "";
    const meta = {
      itemId: (item as any).id,
      sku: (item as any).sku,
      name: (item as any).name,
      qty,
      payWith,
      costCoins,
      costTickets,
      grantCoins,
      grantTickets,
      grantExp,
      ip,
      ua,
    };

    // ✅ 단일 호출로 “주문+거래+부가효과(인벤/효과)”까지 최대한 일관되게 처리
    const [row] = await sql/*sql*/`
      with
      o as (
        insert into shop_orders (user_id, item_id, item_key, item_name, amount_coins, amount_tickets, metadata, idempotency_key)
        values (
          ${userId}::uuid,
          ${(item as any).id}::uuid,
          coalesce(${(item as any).sku}, ${(item as any).id}::text),
          ${(item as any).name},
          ${costCoins},
          ${costTickets},
          ${JSON.stringify(meta)}::jsonb,
          ${idemKey}
        )
        on conflict (user_id, idempotency_key) do update
          set metadata = excluded.metadata
        returning id
      ),
      tx_ins as (
        insert into transactions (user_id, type, amount, tickets_delta, exp_delta, reason, meta, ref_table, ref_id, idempotency_key)
        values (
          ${userId}::uuid,
          case when ${coinsDelta} < 0 then 'spend' else 'earn' end,
          ${coinsDelta},
          ${ticketsDelta},
          ${expDelta},
          'shop_purchase',
          ${JSON.stringify(meta)}::jsonb,
          'shop_orders',
          (select id from o),
          ${idemKey}
        )
        on conflict (user_id, idempotency_key) do nothing
        returning id, balance_after
      ),
      tx as (
        select * from tx_ins
        union all
        select id, balance_after
        from transactions
        where user_id = ${userId}::uuid and idempotency_key = ${idemKey}
        limit 1
      ),
      inv as (
        insert into user_inventory (user_id, sku, quantity, updated_at)
        select
          ${userId}::uuid,
          ${(item as any).inventory_grant_sku},
          greatest(1, coalesce(${num((item as any).inventory_grant_amount, 1)}, 1) * ${qty}),
          now()
        where ${(item as any).inventory_grant_sku} is not null
          and exists (select 1 from tx_ins) -- ✅ “새 거래 발생”시에만 지급
        on conflict (user_id, sku) do update
          set quantity = user_inventory.quantity + excluded.quantity,
              updated_at = now()
        returning 1
      ),
      eff as (
        insert into user_effects (user_id, effect_key, effect_value, expires_at, source, metadata)
        select
          ${userId}::uuid,
          ${(item as any).effect_key},
          ${(item as any).effect_value},
          case
            when ${(item as any).effect_duration_minutes} is null then null
            else now() + ((${(item as any).effect_duration_minutes}::text || ' minutes')::interval)
          end,
          'shop',
          jsonb_build_object('idempotency_key', ${idemKey})
        where ${(item as any).effect_key} is not null
          and exists (select 1 from tx_ins) -- ✅ “새 거래 발생”시에만 적용
        returning 1
      )
      select
        (select id from tx) as tx_id,
        (select balance_after from tx) as balance_after
    `;

    const [stats] = await sql/*sql*/`
      select coins, exp, tickets, games_played, level
      from user_stats
      where user_id = ${userId}::uuid
      limit 1
    `;

    const wallet = {
      points: Number((stats as any)?.coins ?? 0),
      tickets: Number((stats as any)?.tickets ?? 0),
      exp: Number((stats as any)?.exp ?? 0),
      plays: Number((stats as any)?.games_played ?? 0),
      level: Number((stats as any)?.level ?? 1),
    };

    return withCORS(
      json({
        ok: true,
        item: {
          id: (item as any).id,
          sku: (item as any).sku,
          name: (item as any).name,
          category: (item as any).category,
        },
        order: { idempotencyKey: idemKey },
        tx: row,
        delta: { coinsDelta, ticketsDelta, expDelta },
        wallet,
        stats,
        snapshot: { wallet, stats },
      }),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json({ ok: false, error: String(e?.message || e) }, { status: 400 }),
      env.CORS_ORIGIN
    );
  }
};
