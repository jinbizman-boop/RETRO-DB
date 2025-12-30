// functions/api/shop/purchase.ts
// ------------------------------------------------------------
// POST /api/shop/purchase
// - Canonical: transactions + user_stats (single source of truth)
// - Frontend contract 유지:
//   • request: { itemId, itemKey, name/title, payWith?("coins"|"tickets") }
//   • response: { ok:true, item, paid, wallet, stats, snapshot }
// ------------------------------------------------------------

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { requireUser } from "../_utils/auth";
import * as Rate from "../_utils/rate-limit";

// Minimal Pages ambient types (type-checker only)
type CfEventLike<E> = { request: Request; env: E; params?: Record<string, string> };
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
function toStr(v: unknown) {
  return (typeof v === "string" ? v : "").trim();
}
function toNum(v: any, fallback = 0) {
  if (v == null) return fallback;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function computeLevelFromExp(exp: number): number {
  const e = Math.max(0, Math.floor(exp || 0));
  return Math.floor(e / 1000) + 1;
}
function computeXpCap(level: number): number {
  const lv = Math.max(1, Math.floor(level || 1));
  return lv * 1000;
}
function pickIdemKey(req: Request) {
  const k = req.headers.get("Idempotency-Key") || req.headers.get("idempotency-key") || "";
  const kk = k.trim();
  if (kk) return kk;
  // fallback(권장: 프론트에서 반드시 넣기)
  return (globalThis.crypto && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "POST") {
    return withCORS(json({ ok: false, message: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  if (!(await Rate.allow(request))) {
    return withCORS(json({ ok: false, message: "Too Many Requests" }, { status: 429 }), env.CORS_ORIGIN);
  }

  const sql = getSql(env);

  try {
    const me = await requireUser(request, env);
    const userId = String((me as any)?.userId || (me as any)?.id || "");
    if (!isUuid(userId)) {
      return withCORS(json({ ok: false, message: "unauthorized" }, { status: 401 }), env.CORS_ORIGIN);
    }

    const body = await readJSON(request);
    const rawItemId = toStr((body as any)?.itemId || (body as any)?.id);
    const rawItemKey = toStr((body as any)?.itemKey || (body as any)?.item_key || (body as any)?.sku);
    const rawName = toStr((body as any)?.name || (body as any)?.title);

    const payWithReq = toStr((body as any)?.payWith).toLowerCase(); // "coins" | "tickets" | ""
    const idemKey = pickIdemKey(request);

    const itemId = isUuid(rawItemId) ? rawItemId : null;
    const itemKey = rawItemKey ? rawItemKey : null;
    const itemName = rawName ? rawName : null;

    // ✅ shop_items 스키마가 (new: price_points/title/item_key) 든 (legacy: price_coins/name/sku) 든 모두 흡수
    const [item] = await sql/*sql*/`
      select
        id,
        coalesce(item_key, sku, '') as item_key,
        coalesce(title, name, '') as title,
        coalesce(description, '') as description,

        coalesce(price_points, price_coins, 0)::bigint  as price_points,
        coalesce(price_tickets, 0)::bigint             as price_tickets,
        coalesce(price_type, '')                       as price_type,

        coalesce(wallet_coins_delta, 0)::bigint   as wallet_coins_delta,
        coalesce(wallet_tickets_delta, 0)::bigint as wallet_tickets_delta,
        coalesce(wallet_exp_delta, 0)::bigint     as wallet_exp_delta,
        coalesce(wallet_plays_delta, 0)::bigint   as wallet_plays_delta

      from shop_items
      where (archived is null or archived = false)
        and (is_active is null or is_active = true)
        and (
          (${itemId}::uuid is not null and id = ${itemId}::uuid)
          or (${itemKey} is not null and (item_key = ${itemKey} or sku = ${itemKey}))
          or (${itemName} is not null and (title = ${itemName} or name = ${itemName}))
        )
      limit 1
    `;

    if (!item?.id) {
      return withCORS(json({ ok: false, message: "존재하지 않는 상품입니다." }, { status: 404 }), env.CORS_ORIGIN);
    }

    const priceCoins = toNum(item.price_points, 0);
    const priceTickets = toNum(item.price_tickets, 0);

    // payWith 결정: 요청 > price_type > 가격값 기반 추론
    let payWith: "coins" | "tickets" = "coins";
    if (payWithReq === "tickets") payWith = "tickets";
    else if (payWithReq === "coins") payWith = "coins";
    else {
      const pt = String(item.price_type || "").toLowerCase();
      if (pt === "tickets") payWith = "tickets";
      else if (pt === "coins") payWith = "coins";
      else {
        // 추론: tickets 가격만 있으면 tickets, 아니면 coins
        payWith = priceTickets > 0 && priceCoins <= 0 ? "tickets" : "coins";
      }
    }

    const costCoins = payWith === "coins" ? priceCoins : 0;
    const costTickets = payWith === "tickets" ? priceTickets : 0;

    if (payWith === "coins" && costCoins <= 0) {
      return withCORS(json({ ok: false, message: "구매 금액(코인)이 올바르지 않습니다." }, { status: 400 }), env.CORS_ORIGIN);
    }
    if (payWith === "tickets" && costTickets <= 0) {
      return withCORS(json({ ok: false, message: "구매 금액(티켓)이 올바르지 않습니다." }, { status: 400 }), env.CORS_ORIGIN);
    }

    // ✅ 순수 단일소스 반영: transactions insert → 트리거가 user_stats 갱신
    const rewardCoins = toNum(item.wallet_coins_delta, 0);
    const rewardTickets = toNum(item.wallet_tickets_delta, 0);
    const rewardExp = toNum(item.wallet_exp_delta, 0);
    const rewardPlays = toNum(item.wallet_plays_delta, 0);

    const netAmount = (-costCoins) + rewardCoins; // coins 변화(지출+보상)
    const netTickets = (-costTickets) + rewardTickets;

    // txn_type 결정(실질적으로 감소가 있으면 spend, 아니면 earn)
    const txnType =
      (netAmount < 0 || netTickets < 0) ? "spend" : "earn";

    const meta = {
      kind: "shop_purchase",
      item: {
        id: String(item.id),
        itemKey: String(item.item_key || ""),
        title: String(item.title || ""),
      },
      paid: { payWith, coins: costCoins, tickets: costTickets },
      reward: { coins: rewardCoins, tickets: rewardTickets, exp: rewardExp, plays: rewardPlays },
    };

    try {
      // user_stats row 보장(없으면 생성)
      await sql/*sql*/`
        insert into user_stats (user_id, coins, tickets, exp, games_played)
        values (${userId}::uuid, 0, 0, 0, 0)
        on conflict (user_id) do nothing
      `;

      // transactions insert (idempotency)
      await sql/*sql*/`
        insert into transactions (
          user_id, type, amount,
          ref_table, ref_id,
          note, idempotency_key,
          reason, meta,
          game,
          exp_delta, tickets_delta, plays_delta
        )
        values (
          ${userId}::uuid,
          ${txnType}::txn_type,
          ${Math.trunc(netAmount)}::bigint,
          'shop_items', ${item.id}::uuid,
          ${`SHOP:${String(item.title || "")}`},
          ${idemKey},
          'SHOP_PURCHASE',
          ${JSON.stringify(meta)}::jsonb,
          null,
          ${Math.trunc(rewardExp)}::bigint,
          ${Math.trunc(netTickets)}::bigint,
          ${Math.trunc(rewardPlays)}::bigint
        )
        on conflict (idempotency_key) do nothing
      `;
    } catch (e: any) {
      const msg = String(e?.message || e);

      // 트리거/체크제약에서 나는 “잔액 부족”류를 사용자 메시지로 변환
      if (/insufficient|not enough|balance|coins|tickets|negative/i.test(msg)) {
        return withCORS(
          json({ ok: false, message: "보유 자원이 부족합니다." }, { status: 400 }),
          env.CORS_ORIGIN
        );
      }

      return withCORS(
        json({ ok: false, message: "구매 처리 중 오류가 발생했습니다.", detail: msg }, { status: 500 }),
        env.CORS_ORIGIN
      );
    }

    // 최신 스냅샷 반환 (user_stats 기준)
    const [s] = await sql/*sql*/`
      select coins, tickets, exp, games_played
      from user_stats
      where user_id = ${userId}::uuid
      limit 1
    `;

    const coins = toNum(s?.coins, 0);
    const tickets = toNum(s?.tickets, 0);
    const exp = toNum(s?.exp, 0);
    const plays = toNum(s?.games_played, 0);

    const level = computeLevelFromExp(exp);
    const xpCap = computeXpCap(level);

    const wallet = { points: coins, tickets, exp, plays, level, xpCap };
    const stats = { coins, tickets, exp, games_played: plays, level, xpCap };
    const snapshot = { wallet, stats };

    return withCORS(
      json(
        {
          ok: true,
          item: { id: String(item.id), itemKey: String(item.item_key || ""), name: String(item.title || "") },
          paid: { payWith, coins: costCoins, tickets: costTickets },
          wallet,
          stats,
          snapshot,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    const msg = String(e?.message || e);
    return withCORS(json({ ok: false, message: "Server Error", detail: msg }, { status: 500 }), env.CORS_ORIGIN);
  }
};
