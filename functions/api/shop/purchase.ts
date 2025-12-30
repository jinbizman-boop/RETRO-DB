// functions/api/shop/purchase.ts
// ------------------------------------------------------------
// POST /api/shop/purchase
// - ✅ Canonical: transactions + user_stats (user_wallet 사용 금지)
// - shop_items의 price_points 기반으로 coins(=points) 차감
// - ticket_small/medium/large 구매 시 tickets_delta 지급
// - idempotency_key 지원(헤더: Idempotency-Key)
// - 응답: { ok:true, item, wallet, stats, userId, idempotent }
// ------------------------------------------------------------

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { requireUser } from "../_utils/auth";
import { ensureUserStatsRow } from "../_utils/progression";

type PagesFunction<E = unknown> = (ctx: {
  request: Request;
  env: E;
}) => Response | Promise<Response>;

function toInt(v: any, def = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.trunc(n);
}

function isInsufficientBalance(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  // 트리거 apply_wallet_transaction()에서 coins 부족 시 raise
  return msg.includes("insufficient balance") || msg.includes("23514");
}

function cleanText(v: any, max = 120): string {
  const s = (typeof v === "string" ? v : String(v ?? "")).trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function getIdemKey(req: Request): string | null {
  const k =
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key") ||
    req.headers.get("x-idempotency-key");
  const s = (k ?? "").trim();
  return s ? s.slice(0, 200) : null;
}

function ticketRewardByKey(itemKey: string): number {
  switch ((itemKey || "").toLowerCase()) {
    case "ticket_small":
      return 5;
    case "ticket_medium":
      return 10;
    case "ticket_large":
      return 20;
    default:
      return 0;
  }
}

async function findShopItem(sql: any, selector: { itemId?: string; itemKey?: string; name?: string }) {
  // 1) item_key 우선
  if (selector.itemKey) {
    try {
      const rows = (await sql/* sql */ `
        select *
        from shop_items
        where item_key = ${selector.itemKey}
          and (is_active is null or is_active = true)
        limit 1
      `) as any[];
      if (rows?.length) return rows[0];
    } catch (_) {}
  }

  // 2) id::text 매칭 (uuid/serial 모두 대응)
  if (selector.itemId) {
    try {
      const rows = (await sql/* sql */ `
        select *
        from shop_items
        where (id::text = ${selector.itemId})
          and (is_active is null or is_active = true)
        limit 1
      `) as any[];
      if (rows?.length) return rows[0];
    } catch (_) {}
  }

  // 3) name 매칭(최후 수단)
  if (selector.name) {
    try {
      const rows = (await sql/* sql */ `
        select *
        from shop_items
        where name = ${selector.name}
          and (is_active is null or is_active = true)
        limit 1
      `) as any[];
      if (rows?.length) return rows[0];
    } catch (_) {}
  }

  return null;
}

export const onRequestOptions: PagesFunction<Env> = async ({ env }) => {
  return preflight(env.CORS_ORIGIN);
};

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ ok: false, error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  try {
    // ✅ 로그인 사용자 식별(정본)
    // - Authorization Bearer 기반
    const me = await requireUser(request, env as any);
    const userId = String((me as any).sub || "");

    if (!userId) {
      return withCORS(json({ ok: false, error: "Unauthorized" }, { status: 401 }), env.CORS_ORIGIN);
    }

    const body = await readJSON(request);

    const itemId = cleanText(body?.itemId, 80);
    const itemKey = cleanText(body?.itemKey, 80);
    const name = cleanText(body?.name, 120);
    const payWith = cleanText(body?.payWith || "coins", 20).toLowerCase();

    const sql = getSql(env);

    // user_stats row 선 보장
    await ensureUserStatsRow(sql as any, userId);

    const item = await findShopItem(sql, { itemId, itemKey, name });

    if (!item) {
      return withCORS(
        json({ ok: false, error: "Item not found", message: "상점 아이템을 찾을 수 없습니다." }, { status: 404 }),
        env.CORS_ORIGIN
      );
    }

    // 스키마 호환: price_points 우선, 없으면 price_coins / price 등 fallback
    const priceCoins =
      toInt(item.price_points ?? item.price_coins ?? item.priceCoins ?? item.price ?? 0, 0);

    const priceTickets = toInt(item.price_tickets ?? item.priceTickets ?? 0, 0);

    if (payWith !== "coins" && payWith !== "tickets") {
      return withCORS(
        json({ ok: false, error: "Invalid payWith", message: "결제 수단이 올바르지 않습니다." }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    // 현재 프론트(UI)는 coins 구매만 제공하므로, tickets 결제는 막아둠(원하면 풀어드림)
    if (payWith === "tickets") {
      return withCORS(
        json({ ok: false, error: "Not supported", message: "현재는 코인 결제만 지원합니다." }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    if (priceCoins <= 0) {
      return withCORS(
        json({ ok: false, error: "Invalid price", message: "아이템 가격이 올바르지 않습니다." }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    // 티켓 지급(아이템 키 기반)
    const key = String(item.item_key ?? itemKey ?? "");
    const ticketsGain = ticketRewardByKey(key);

    const amount = BigInt(-priceCoins);
    const idem = getIdemKey(request);

    const refId = String(item.id ?? itemId ?? key);
    const reason = `shop:${key || refId}`;

    let idempotent = false;

    try {
      if (idem) {
        const rows = (await sql/* sql */ `
          insert into transactions (
            user_id,
            type,
            amount,
            reason,
            game,
            exp_delta,
            tickets_delta,
            plays_delta,
            ref_table,
            ref_id,
            idempotency_key,
            meta,
            note
          )
          values (
            ${userId}::uuid,
            'purchase'::txn_type,
            ${amount.toString()}::bigint,
            ${reason},
            'shop',
            0,
            ${ticketsGain},
            0,
            'shop_items',
            ${refId},
            ${idem},
            ${JSON.stringify({ payWith, itemKey: key, itemId: refId })}::jsonb,
            ${reason}
          )
          on conflict (idempotency_key) do nothing
          returning 1
        `) as any[];

        idempotent = true;
        // rows.length===0이면 이미 처리된 idem → 그대로 OK로 처리
      } else {
        await sql/* sql */ `
          insert into transactions (
            user_id,
            type,
            amount,
            reason,
            game,
            exp_delta,
            tickets_delta,
            plays_delta,
            ref_table,
            ref_id,
            meta,
            note
          )
          values (
            ${userId}::uuid,
            'purchase'::txn_type,
            ${amount.toString()}::bigint,
            ${reason},
            'shop',
            0,
            ${ticketsGain},
            0,
            'shop_items',
            ${refId},
            ${JSON.stringify({ payWith, itemKey: key, itemId: refId })}::jsonb,
            ${reason}
          )
        `;
      }
    } catch (e: any) {
      if (isInsufficientBalance(e)) {
        return withCORS(
          json({ ok: false, error: "Insufficient coins", message: "코인이 부족합니다." }, { status: 400 }),
          env.CORS_ORIGIN
        );
      }
      throw e;
    }

    // ✅ 반영된 user_stats 반환(정본)
    const statsRows = (await sql/* sql */ `
      select
        coins,
        tickets,
        exp,
        level,
        games_played
      from user_stats
      where user_id = ${userId}::uuid
      limit 1
    `) as any[];

    const s = statsRows?.[0] ?? {};
    const wallet = {
      coins: Number(s.coins ?? 0),
      points: Number(s.coins ?? 0), // 호환
      tickets: Number(s.tickets ?? 0),
      exp: Number(s.exp ?? 0),
      level: Number(s.level ?? 1),
      plays: Number(s.games_played ?? 0),
    };

    const safeItem = {
      id: item.id ?? null,
      itemKey: String(item.item_key ?? key ?? ""),
      name: String(item.name ?? ""),
      description: String(item.description ?? ""),
      priceCoins,
      ticketsGain,
    };

    return withCORS(
      json(
        {
          ok: true,
          userId,
          item: safeItem,
          wallet,
          stats: wallet, // 프론트 applyAccountApiResponseLocal 호환
          idempotent,
        },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { ok: false, error: "Purchase failed", message: String(e?.message ?? e ?? "unknown error") },
        { status: 500 }
      ),
      env.CORS_ORIGIN
    );
  }
};
