// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\redeem.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → tiny ambient types for CF Pages (editor-only)
// - ts(7031) request/env implicitly any        → handler params에 타입 명시
// - 외부 계약/동작 100% 유지:
//     • 메서드: POST
//     • 입력: { userId, itemId, qty }  // qty 미지정 시 1
//     • 응답: { ok: true }
//
// 🔥 내부 동작/지갑·인벤토리 정합 강화
// - Canonical 인벤토리: migrations/003_shop_effects.sql 기준 user_inventory + shop_items
//     • user_inventory(user_id UUID, item_id UUID, qty INT >= 0, …)
//     • shop_items(id UUID, sku TEXT, …)
//     → 클라이언트에는 item_id = shop_items.sku (없으면 id::text) 로 노출/연계
// - Legacy fallback: wallet_items(user_id TEXT, item_id TEXT, qty INT)
// - userId 우선순위:
//     1) 미들웨어가 넣어주는 X-User-Id 헤더 (users.id UUID)
//     2) body.userId
//   → 최종적으로 UUID 형식이 아니면 400("Invalid userId")
// - qty: int32 범위로 보정 후, 1 이상 필수 (0/음수는 에러)


// ───── Minimal Cloudflare Pages ambient types (type-checker only) ─────
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
/* ────────────────────────────────────────────────────────────────────── */

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

/**
 * 계약 유지:
 * - 라우트/메서드 동일(POST)
 * - 입력: { userId, itemId, qty }  // qty 미지정 시 기본 1
 * - 응답: { ok: true }
 *
 * 보강:
 * - Rate limit(429)
 * - userId: X-User-Id 헤더 + body.userId → UUID 형식 검증 (users.id와 정합)
 * - itemId: shop_items.sku 혹은 shop_items.id::text 와 매칭
 * - canonical 인벤토리: user_inventory(user_id, item_id, qty) upsert
 * - user_inventory/shops 미구성 환경에서는 기존 wallet_items 로 graceful fallback
 * - 운영 헤더: X-Redeem-*, 처리시간 등
 */

/* ───────── helpers ───────── */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveUserId(req: Request, bodyUserId: unknown): string {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";
  const candidate = (
    headerId ||
    (typeof bodyUserId === "string" ? bodyUserId : "")
  )
    .trim()
    .normalize("NFKC");

  if (!candidate) throw new Error("Invalid userId");
  if (!UUID_V4_REGEX.test(candidate)) throw new Error("Invalid userId");
  return candidate;
}

function cleanItemKey(v: unknown): string {
  const s = (typeof v === "string" ? v : "")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
  if (!s) throw new Error("Invalid itemId");
  // SKU-ish or UUID-ish 아무거나 허용 (실제 매칭은 DB에서 처리)
  if (
    /^[a-z0-9_\-.:]{1,64}$/.test(s) ||
    UUID_V4_REGEX.test(s)
  ) {
    return s;
  }
  throw new Error("Invalid itemId");
}

function toInt32(n: unknown, fallback = 1): number {
  const x = Number(n);
  const v = Number.isFinite(x) ? Math.trunc(x) : fallback;
  const MIN = -2147483648;
  const MAX = 2147483647;
  if (v < MIN) return MIN;
  if (v > MAX) return MAX;
  return v;
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

/* ───────── handler ───────── */
export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 남용 방지
  if (!(await Rate.allow(request))) {
    return withCORS(
      json(
        { error: "Too Many Requests" },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);

    const userId = resolveUserId(request, (body as any)?.userId);
    const itemKey = cleanItemKey((body as any)?.itemId);

    const qtyRaw = toInt32((body as any)?.qty, 1); // 원본 계약: 기본 1
    if (qtyRaw <= 0) {
      // 음수/0 수량은 인벤토리 일관성을 위해 허용하지 않음
      throw new Error("qty must be positive");
    }
    const qty = qtyRaw;

    const sql = getSql(env);

    let appliedQty = qty;
    let appliedItemKey = itemKey;
    let source: "user_inventory" | "wallet_items" = "user_inventory";

    // ─────────────────────────────────────────────
    // 1) canonical 인벤토리: user_inventory + shop_items
    //    - itemKey 를 shop_items.sku 또는 shop_items.id::text 로 매칭
    //    - user_inventory(user_id UUID, item_id UUID)에 upsert
    // ─────────────────────────────────────────────
    try {
      const rowsItem = (await sql/* sql */ `
        select
          id::text as id,
          sku
        from shop_items
        where
          lower(sku) = ${itemKey}
          or id::text = ${itemKey}
        limit 1
      `) as { id: string; sku: string | null }[];

      if (!rowsItem || rowsItem.length === 0) {
        // shop_items 은 있지만 해당 item 이 없다 → legacy wallet_items 로 fallback
        source = "wallet_items";
        throw new Error("NO_CANONICAL_ITEM_FALLBACK");
      }

      const itemRow = rowsItem[0];
      const itemIdUuid = itemRow.id; // UUID text
      appliedItemKey = (itemRow.sku && itemRow.sku.trim()) || itemIdUuid;

      // upsert into user_inventory
      await sql/* sql */ `
        insert into user_inventory(user_id, item_id, qty)
        values(${userId}::uuid, ${itemIdUuid}::uuid, ${qty})
        on conflict (user_id, item_id)
        do update set
          qty = GREATEST(0, user_inventory.qty + ${qty}),
          updated_at = now()
      `;
      source = "user_inventory";
    } catch (e: any) {
      // user_inventory/shop_items 스키마가 아직 없거나,
      // 위에서 NO_CANONICAL_ITEM_FALLBACK 를 던진 경우 → legacy wallet_items 로 graceful fallback
      const msg = String(e?.message ?? "");
      if (!isMissingTable(e) && !msg.includes("NO_CANONICAL_ITEM_FALLBACK")) {
        // 진짜 오류는 그대로 노출
        throw e;
      }

      // ─────────────────────────────────────────────
      // 2) legacy fallback: wallet_items (구 구조)
      //    - 기존 코드와 동일한 테이블/동작
      // ─────────────────────────────────────────────
      source = "wallet_items";

      try {
        await sql/* sql */ `
          create table if not exists wallet_items(
            user_id text not null,
            item_id text not null,
            qty int not null default 0,
            updated_at timestamptz not null default now(),
            primary key(user_id, item_id)
          )
        `;
        await sql/* sql */ `
          alter table wallet_items
          add column if not exists updated_at timestamptz not null default now()
        `;
        await sql/* sql */ `
          create index if not exists wallet_items_user_idx
          on wallet_items (user_id, updated_at desc)
        `;
        await sql/* sql */ `
          create index if not exists wallet_items_item_idx
          on wallet_items (item_id)
        `;
      } catch (schemaErr) {
        if (!isMissingTable(schemaErr)) {
          throw schemaErr;
        }
      }

      // upsert: 기존 계약 유지(단순 가산). updated_at 최신화
      await sql/* sql */ `
        insert into wallet_items(user_id, item_id, qty)
        values(${userId}, ${itemKey}, ${qty})
        on conflict (user_id, item_id)
        do update set
          qty = wallet_items.qty + excluded.qty,
          updated_at = now()
      `;
      appliedItemKey = itemKey;
    }

    return withCORS(
      json(
        { ok: true }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Redeem-User": userId,
            "X-Redeem-Item": appliedItemKey,
            "X-Redeem-Delta": String(appliedQty),
            "X-Redeem-Source": source,
            "X-Redeem-Took-ms": String(Math.round(performance.now() - t0)),
          },
        }
      ),
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
