// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\inventory.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'       → tiny ambient type (editor-only) 유지
// - ts(7031) request/env implicitly any             → 핸들러 파라미터 타입 명시
// - ts(2558) Expected 0 type arguments, but got 1   → generic 제거
// - 기존 외부 계약 100% 유지:
//     • 메서드/라우트: OPTIONS / GET
//     • 입력: query.userId (그리고 선택적으로 ?item=&limit=)
//     • 응답: { ok: true, items: [{ item_id, qty }] }
//
// 🔥 내부 동작/스키마 정합 강화
// - canonical 인벤토리 소스: migrations/003_shop_effects.sql 의 user_inventory + shop_items
//     • user_inventory(user_id UUID, item_id UUID, qty INT)
//     • shop_items(id UUID, sku TEXT, ...)
//     → 클라이언트에는 item_id = shop_items.sku (없으면 id::text) 로 노출
// - 레거시 fallback: wallet_items(user_id TEXT, item_id TEXT, qty INT)
// - userId 소스 및 검증:
//     • 1순위: X-User-Id 헤더(미들웨어가 넣어준 users.id UUID)
//     • 2순위: query.userId
//     • UUID 형식이 아니면 400 (userId required 유지)


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

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/**
 * 계약 유지:
 * - 메서드/라우트 동일(OPTIONS/GET)
 * - 입력: query.userId
 * - 응답 스키마 동일: { ok: true, items: rows }  // rows = [{ item_id, qty }]
 *
 * 보강:
 * - userId: 헤더(X-User-Id) 우선 + UUID 형식 검증
 * - canonical 인벤토리: user_inventory + shop_items 기준
 * - 레거시 wallet_items 는 fallback 전용
 * - bigint/문자 qty → number 안전 변환, 음수 방지
 * - 초기 상태 내성(테이블 미존재 허용), 인덱스 보강
 * - 운영 헤더(Cache-Control: no-store, 처리시간, 제한, source 등)
 */

type RowRawInventory = {
  item_id: string; // shop_items.id::uuid::text
  sku: string | null;
  qty: number | string | bigint;
};

type RowRawLegacy = { item_id: string; qty: number | string | bigint };
type RowSafe = { item_id: string; qty: number };

/* ───────── helpers ───────── */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveUserId(req: Request, queryUserId: string | null): string | null {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";
  const candidate = (headerId || queryUserId || "").trim().normalize("NFKC");
  if (!candidate) return null;
  if (!UUID_V4_REGEX.test(candidate)) return null;
  return candidate;
}

function cleanItemId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().normalize("NFKC");
  // SKU 또는 UUID 텍스트 등, 비교적 느슨하게 허용
  if (/^[a-z0-9_\-.:]{1,64}$/.test(s)) return s;
  if (UUID_V4_REGEX.test(s)) return s;
  return null;
}

function toNonNegativeInt(v: any): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string") n = Number(v);
  else n = 0;

  if (!Number.isFinite(n)) n = 0;
  n = Math.floor(n);
  if (n < 0) n = 0;
  if (n > Number.MAX_SAFE_INTEGER) n = Number.MAX_SAFE_INTEGER;
  return n;
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
  if (request.method !== "GET") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);
    const queryUserId = url.searchParams.get("userId");
    const userId = resolveUserId(request, queryUserId);

    if (!userId) {
      return withCORS(
        json({ error: "userId required" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    // 선택: 특정 아이템만 조회 (?item=…), 응답 길이 제한 (?limit=…)
    const itemFilter = cleanItemId(url.searchParams.get("item"));
    const limitParam = url.searchParams.get("limit");
    const limit = Math.max(
      1,
      Math.min(500, limitParam ? Number(limitParam) || 500 : 500)
    );

    const sql = getSql(env);

    let safe: RowSafe[] = [];
    let source: "user_inventory" | "wallet_items" | "none" = "none";

    // ─────────────────────────────────────────────
    // 1) canonical: user_inventory + shop_items
    //    - user_inventory.user_id: uuid
    //    - user_inventory.item_id: uuid → shop_items.id
    //    - 반환 item_id: shop_items.sku (없으면 id::text)
    // ─────────────────────────────────────────────
    try {
      const rowsInventory = (await sql/* sql */ `
        select
          i.item_id::text as item_id,
          i.qty,
          s.sku
        from user_inventory as i
        join shop_items as s
          on s.id = i.item_id
        where i.user_id = ${userId}::uuid
          ${
            itemFilter
              ? sql/* sql */ `
                and (
                  lower(s.sku) = ${itemFilter}
                  or i.item_id::text = ${itemFilter}
                )
              `
              : sql``
          }
        order by i.updated_at desc, s.sku asc
        limit ${limit}
      `) as RowRawInventory[];

      safe = rowsInventory.map((r) => ({
        item_id: (r.sku && r.sku.trim()) || r.item_id,
        qty: toNonNegativeInt(r.qty),
      }));
      source = "user_inventory";
    } catch (e) {
      if (!isMissingTable(e)) {
        // user_inventory / shop_items 가 있는데 다른 오류면 그대로 던짐
        throw e;
      }
      // 테이블이 없으면 레거시 fallback 으로 진행
    }

    // ─────────────────────────────────────────────
    // 2) fallback: wallet_items (구 구조)
    //    - user_id TEXT, item_id TEXT, qty INT
    //    - 위에서 이미 source 가 user_inventory 로 세팅되었다면 스킵
    // ─────────────────────────────────────────────
    if (source === "none") {
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
      } catch (e) {
        if (!isMissingTable(e)) {
          // 초기 경쟁상태 등은 무시하고 계속 진행
        }
      }

      let rowsAny: any[] = [];
      try {
        rowsAny = await sql/* sql */ `
          select item_id, qty
          from wallet_items
          where user_id = ${userId}
            ${itemFilter ? sql/* sql */ `and item_id = ${itemFilter}` : sql``}
          order by updated_at desc, item_id asc
          limit ${limit}
        `;
        const rowsLegacy = rowsAny as RowRawLegacy[];
        safe = rowsLegacy.map((r) => ({
          item_id: r.item_id,
          qty: toNonNegativeInt(r.qty),
        }));
        source = "wallet_items";
      } catch (e) {
        if (!isMissingTable(e)) throw e;
        safe = [];
        source = "none";
      }
    }

    return withCORS(
      json(
        { ok: true, items: safe }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Inventory-User": userId,
            "X-Inventory-Count": String(safe.length),
            "X-Inventory-Limit": String(limit),
            "X-Inventory-Source": source,
            "X-Inventory-Took-ms": String(Math.round(performance.now() - t0)),
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
