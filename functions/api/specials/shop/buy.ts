// functions/api/specials/shop/buy.ts
// ------------------------------------------------------------
// POST /api/specials/shop/buy
// - app.js(프론트)에서 { sku }로 호출하는 엔드포인트
// - shop_items를 sku(item_key) 또는 name으로 조회
// - user_stats.coins 차감 + (티켓류면 tickets 증가)
// - wallet_balances.balance도 함께 동기화(레거시 호환)
// - 응답: { ok:true, item, wallet, stats }
// ------------------------------------------------------------

import { json, readJSON } from "../../_utils/json";
import { withCORS, preflight } from "../../_utils/cors";
import { getSql, type Env } from "../../_utils/db";
import * as Rate from "../../_utils/rate-limit";

type CfEventLike<E = unknown> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;

function toStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function toNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function resolveUserId(ctx: CfEventLike<Env>): string | null {
  const dataUserId = (ctx.data as any)?.auth?.userId;
  const headerId =
    ctx.request.headers.get("X-User-Id") ||
    ctx.request.headers.get("x-user-id") ||
    "";

  const id = toStr(dataUserId || headerId);
  return id || null;
}

function ticketRewardByKey(itemKey: string): number {
  // 프로젝트 purchase.ts와 동일 규칙
  if (itemKey === "ticket_small") return 5;
  if (itemKey === "ticket_medium") return 10;
  if (itemKey === "ticket_large") return 20;
  return 0;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;

  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // 간단 레이트리밋(프로젝트 유틸 사용)
  // - _utils/rate-limit.ts 공개 계약: export async function allow(req: Request): Promise<boolean>
  const allowed = await Rate.allow(request);
  if (!allowed) {
    return withCORS(
      json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": "60",
          },
        }
      ),
      env.CORS_ORIGIN
    );
  }

  const userId = resolveUserId(ctx);
  if (!userId) {
    return withCORS(json({ error: "unauthorized" }, { status: 401 }), env.CORS_ORIGIN);
  }

  const body = await readJSON(request);
  const sku = toStr((body as any)?.sku || (body as any)?.item_key || (body as any)?.name);
  const itemId = toNum((body as any)?.itemId);

  if (!sku && !itemId) {
    return withCORS(json({ error: "item_required" }, { status: 400 }), env.CORS_ORIGIN);
  }

  const sql = getSql(env);

  try {
    // 1) 아이템 조회 (id 우선, 아니면 sku로 item_key/name 둘 다 시도)
    let rows: any[] = [];
    if (itemId) {
      rows = await sql/* sql */`
        select id, item_key, name, description, price_coins, is_active
        from shop_items
        where id = ${itemId}
          and is_active = true
        limit 1
      `;
    } else {
      rows = await sql/* sql */`
        select id, item_key, name, description, price_coins, is_active
        from shop_items
        where (item_key = ${sku} or name = ${sku})
          and is_active = true
        limit 1
      `;
    }

    if (!rows?.length) {
      return withCORS(json({ error: "item_not_found" }, { status: 404 }), env.CORS_ORIGIN);
    }

    const item = rows[0];
    const priceCoins = Math.max(0, toNum(item.price_coins));

    // 2) user_stats row 보정(없으면 생성)
    await sql/* sql */`
      insert into user_stats (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;

    // 3) 효과 계산 (현재는 ticket_*만 즉시 반영)
    const itemKey = toStr(item.item_key);
    const addTickets = itemKey.startsWith("ticket_") ? ticketRewardByKey(itemKey) : 0;

    // 4) 원자 업데이트(동시성 안전): coins가 충분할 때만 차감/지급
    const updated = await sql/* sql */`
      update user_stats
      set coins = coins - ${priceCoins},
          tickets = tickets + ${addTickets},
          updated_at = now()
      where user_id = ${userId}::uuid
        and coins >= ${priceCoins}
      returning coins, exp, tickets, games_played, level
    `;

    if (!updated?.length) {
      // coins 부족(또는 user_id 문제)
      // 현재 코인 값도 한번 내려주면 UX가 좋아짐(있으면)
      const cur = await sql/* sql */`
        select coins
        from user_stats
        where user_id = ${userId}::uuid
        limit 1
      `;
      const curCoins = cur?.length ? Number(cur[0]?.coins ?? 0) : 0;
      return withCORS(
        json({ error: "insufficient_funds", coins: curCoins, price: priceCoins }, { status: 409 }),
        env.CORS_ORIGIN
      );
    }

    const st = updated[0];
    const nextCoins = Math.max(0, Number(st.coins ?? 0));
    const nextTickets = Math.max(0, Number(st.tickets ?? 0));
    const curExp = Math.max(0, Number(st.exp ?? 0));
    const curGames = Math.max(0, Number(st.games_played ?? 0));
    const curLevel = Math.max(1, Number(st.level ?? 1));

    // 5) 레거시/호환 지갑(balance)도 동기화 (실패해도 구매는 성공 처리)
    try {
      await sql/* sql */`
        insert into wallet_balances (user_id, balance, updated_at)
        values (${userId}::uuid, ${nextCoins}, now())
        on conflict (user_id)
        do update set balance = excluded.balance, updated_at = excluded.updated_at
      `;
    } catch (_) {}

    // 6) analytics_events 기록 (없어도 구매는 성공해야 함)
    try {
      await sql/* sql */`
        insert into analytics_events (user_id, event_type, meta, created_at)
        values (${userId}::uuid, 'shop_buy', ${JSON.stringify({ sku: itemKey, priceCoins, addTickets })}::jsonb, now())
      `;
    } catch (_) {}

    const wallet = {
      coins: nextCoins,
      balance: nextCoins,
      points: nextCoins,
      exp: curExp,
      xp: curExp,
      tickets: nextTickets,
      gamesPlayed: curGames,
      level: curLevel,
    };
    const stats = {
      coins: nextCoins,
      balance: nextCoins,
      points: nextCoins,
      exp: curExp,
      xp: curExp,
      tickets: nextTickets,
      gamesPlayed: curGames,
      level: curLevel,
    };

    return withCORS(
      json({ ok: true, item, wallet, stats }, { headers: { "Cache-Control": "no-store" } }),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
