// functions/api/shop/list.ts
// ------------------------------------------------------------
// GET /api/shop/list
// (호환) /specials/shop 에서도 이 핸들러를 re-export 해서 사용 가능
// ------------------------------------------------------------

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

// Minimal Cloudflare Pages ambient types (type-checker only)
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;

function toStringOrNull(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}
function toNum(v: any, fallback = 0) {
  if (v == null) return fallback;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toBool(v: any, fallback = false) {
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase().trim();
  if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "0" || s === "no" || s === "n") return false;
  return fallback;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  if (!(await Rate.allow(request))) {
    return withCORS(json({ error: "Too Many Requests" }, { status: 429 }), env.CORS_ORIGIN);
  }

  try {
    const url = new URL(request.url);
    const typeFilter = toStringOrNull(url.searchParams.get("type"));

    const sql = getSql(env);

    // shop_items 존재 여부 확인
    const exists = await sql/* sql */`
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'shop_items'
      ) as ok
    `;
    if (!exists?.[0]?.ok) {
      return withCORS(
        json({ ok: true, items: [] }, { status: 200, headers: { "Cache-Control": "no-store" } }),
        env.CORS_ORIGIN
      );
    }

    const rows = await sql/* sql */`
      select
        id,
        item_key,
        title,
        description,
        type,
        price_points,
        price_tickets,
        is_active,
        archived,
        effect_key,
        effect_value,
        effect_duration_minutes,
        effect_payload,
        wallet_coins_delta,
        wallet_tickets_delta,
        wallet_exp_delta,
        wallet_plays_delta,
        tags,
        sort_order,
        metadata,
        created_at
      from shop_items
      where (archived is null or archived = false)
        and (is_active is null or is_active = true)
        ${typeFilter ? sql`and type = ${typeFilter}` : sql``}
      order by sort_order asc nulls last, created_at desc
    `;

    const items = (rows || []).map((r: any) => ({
      id: r.id,
      itemKey: r.item_key,
      title: r.title ?? "",
      description: r.description ?? "",
      type: r.type ?? "",
      pricePoints: toNum(r.price_points, 0),
      priceTickets: toNum(r.price_tickets, 0),
      active: toBool(r.is_active, true),

      effect: {
        key: r.effect_key ?? null,
        value: r.effect_value ?? null,
        durationMinutes: toNum(r.effect_duration_minutes, 0),
        payload: r.effect_payload ?? null,
      },

      delta: {
        coins: toNum(r.wallet_coins_delta, 0),
        tickets: toNum(r.wallet_tickets_delta, 0),
        exp: toNum(r.wallet_exp_delta, 0),
        plays: toNum(r.wallet_plays_delta, 0),
      },

      tags: r.tags ?? null,
      sortOrder: r.sort_order ?? null,
      metadata: r.metadata ?? null,
      createdAt: r.created_at ?? null,
    }));

    return withCORS(
      json({ ok: true, items }, { status: 200, headers: { "Cache-Control": "no-store" } }),
      env.CORS_ORIGIN
    );
  } catch (err: any) {
    return withCORS(
      json({ ok: false, error: String(err?.message || err) }, { status: 500 }),
      env.CORS_ORIGIN
    );
  }
};
