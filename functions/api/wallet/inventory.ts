// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\inventory.ts
//
// ✅ Fix / Upgrade summary
// - ts(2304) Cannot find name 'PagesFunction'       → tiny ambient type (editor-only) 유지
// - ts(7031) request/env implicitly any             → 핸들러 파라미터 타입 명시
// - ts(2558) Expected 0 type arguments, but got 1   → generic 제거
//
// 🔒 외부 **계약은 100% 유지**
//   • 메서드/라우트: OPTIONS / GET
//   • 입력: query.userId (선택적으로 ?item=&limit=)
//   • 응답: { ok: true, items: [{ item_id, qty }] }
//
// 🔥 내부 동작/스키마 정합 강화 (지금까지 만든 Wallet-C 아키텍처와 정합)
//   • canonical 소스: migrations/003_shop_effects.sql 의 user_inventory + shop_items
//       - user_inventory(user_id UUID, item_id UUID, qty INT, updated_at TIMESTAMPTZ)
//       - shop_items(id UUID, sku TEXT, category TEXT, kind TEXT, ...)
//       - 클라이언트 item_id: shop_items.sku (없으면 id::text)
//   • 레거시 fallback: wallet_items(user_id TEXT, item_id TEXT, qty INT)
//   • userId 우선순위: X-User-Id (JWT 미들웨어) → query.userId
//   • UUID 형식 검증, bigint/문자 qty → number 안전 변환, 음수 방지
//   • 초기 상태 내성(테이블 미존재 허용), 인덱스 자동 보강
//   • 운영 헤더: 처리시간, source, limit, 필터 정보, total-qty 등을 header 로 노출
//   • 응답 body 는 오직 { ok, items } 만 유지 → 프론트 수정 없이 교체 가능
//

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
  item_id: string; // user_inventory.item_id::uuid::text
  sku: string | null;
  qty: number | string | bigint;
  category?: string | null;
  kind?: string | null;
};

type RowRawLegacy = { item_id: string; qty: number | string | bigint };
type RowSafe = { item_id: string; qty: number };

type InventorySource = "user_inventory" | "wallet_items" | "none";

// ───────── helpers: 공통 유틸 ─────────

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeNormalizeStr(v: string | null): string {
  const raw = v ?? "";
  const trimmed = raw.trim();
  try {
    return trimmed.normalize("NFKC");
  } catch {
    return trimmed;
  }
}

/**
 * userId 해석
 * 1) X-User-Id / x-user-id 헤더 (JWT 미들웨어에서 넣어줌)
 * 2) query.userId
 * 둘 다 없거나 UUID 형식이 아니면 null
 */
function resolveUserId(req: Request, queryUserId: string | null): string | null {
  const headerId =
    req.headers.get("X-User-Id") ||
    req.headers.get("x-user-id") ||
    "";

  const candidate = safeNormalizeStr(headerId || queryUserId);
  if (!candidate) return null;
  if (!UUID_V4_REGEX.test(candidate)) return null;
  return candidate;
}

/**
 * itemId / sku 정규화
 * - 공통 필터에 사용할 값을 소문자 + NFKC 로 맞춘다
 * - SKU / UUID / 간단한 텍스트 모두 대응
 */
function cleanItemId(v: string | null): string | null {
  if (!v) return null;
  let s = safeNormalizeStr(v).toLowerCase();
  // SKU 또는 UUID 텍스트 등, 비교적 느슨하게 허용
  if (/^[a-z0-9_\-.:]{1,64}$/.test(s)) return s;
  if (UUID_V4_REGEX.test(s)) return s;
  return null;
}

/**
 * category/kind 필터용 문자열 정규화
 */
function cleanFilter(v: string | null): string | null {
  if (!v) return null;
  let s = safeNormalizeStr(v).toLowerCase();
  if (!s) return null;
  // 간단한 알파벳/숫자/언더스코어/하이픈/점 정도만 허용
  if (!/^[a-z0-9_\-.]{1,64}$/.test(s)) return null;
  return s;
}

/**
 * bigint/문자 → 음수 방지된 number 변환
 */
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

/**
 * relation 미존재/스키마 없음을 의미하는 에러 판별
 */
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

/* ───────── canonical: user_inventory + shop_items 조회 ───────── */

async function fetchFromUserInventory(
  sql: ReturnType<typeof getSql>,
  userId: string,
  itemFilter: string | null,
  categoryFilter: string | null,
  kindFilter: string | null,
  limit: number
): Promise<{ rows: RowSafe[]; source: InventorySource }> {
  try {
    // user_inventory와 shop_items 가 둘 다 있다고 가정하고 한 번에 조회
    const rows = (await sql/* sql */ `
      select
        i.item_id::text as item_id,
        i.qty,
        s.sku,
        s.category,
        s.kind
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
        ${
          categoryFilter
            ? sql/* sql */ `and lower(s.category) = ${categoryFilter}`
            : sql``
        }
        ${
          kindFilter
            ? sql/* sql */ `and lower(s.kind) = ${kindFilter}`
            : sql``
        }
      order by i.updated_at desc, s.sku asc
      limit ${limit}
    `) as RowRawInventory[];

    const safe: RowSafe[] = rows.map((r) => ({
      // sku 가 있으면 sku 를 우선적으로 노출, 없으면 item_id(uuid)
      item_id: (r.sku && r.sku.trim()) || r.item_id,
      qty: toNonNegativeInt(r.qty),
    }));

    return { rows: safe, source: "user_inventory" };
  } catch (e) {
    if (isMissingTable(e)) {
      // user_inventory 또는 shop_items 가 아직 없으면 fallback 로 위임
      return { rows: [], source: "none" };
    }
    // 다른 예외는 위로 던져서 400/500 으로 보이게 한다 (운영 이슈)
    throw e;
  }
}

/* ───────── fallback: wallet_items 조회 및 스키마 보강 ───────── */

async function ensureWalletItemsSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
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
      // 경쟁 상태/권한 문제 등은 여기서는 무시하고, 실제 select 시 다시 확인
    }
  }
}

async function fetchFromWalletItems(
  sql: ReturnType<typeof getSql>,
  userId: string,
  itemFilter: string | null,
  limit: number
): Promise<{ rows: RowSafe[]; source: InventorySource }> {
  await ensureWalletItemsSchema(sql);

  try {
    const rowsAny = await sql/* sql */ `
      select item_id, qty
      from wallet_items
      where user_id = ${userId}
        ${itemFilter ? sql/* sql */ `and item_id = ${itemFilter}` : sql``}
      order by updated_at desc, item_id asc
      limit ${limit}
    `;
    const rowsLegacy = rowsAny as RowRawLegacy[];

    const safe: RowSafe[] = rowsLegacy.map((r) => ({
      item_id: r.item_id,
      qty: toNonNegativeInt(r.qty),
    }));

    return { rows: safe, source: "wallet_items" };
  } catch (e) {
    if (isMissingTable(e)) {
      // 아예 테이블이 없으면 빈 인벤토리로 취급
      return { rows: [], source: "none" };
    }
    throw e;
  }
}

/* ───────── handler ───────── */
export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // CORS preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  // GET only
  if (request.method !== "GET") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);

    // userId 해석(헤더 → 쿼리 순서)
    const queryUserId = url.searchParams.get("userId");
    const userId = resolveUserId(request, queryUserId);

    if (!userId) {
      return withCORS(
        json({ error: "userId required" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    // 선택: 특정 아이템만 조회 (?item=…), 카테고리/타입 필터, 응답 길이 제한 (?limit=…)
    const itemFilter = cleanItemId(url.searchParams.get("item"));
    const categoryFilter = cleanFilter(url.searchParams.get("category"));
    const kindFilter = cleanFilter(url.searchParams.get("kind"));

    const limitParam = url.searchParams.get("limit");
    const limit = Math.max(
      1,
      Math.min(500, limitParam ? Number(limitParam) || 500 : 500)
    );

    const sql = getSql(env);

    let resultRows: RowSafe[] = [];
    let source: InventorySource = "none";

    // ─────────────────────────────────────────────
    // 1) canonical: user_inventory + shop_items 기준 조회
    // ─────────────────────────────────────────────
    const canonical = await fetchFromUserInventory(
      sql,
      userId,
      itemFilter,
      categoryFilter,
      kindFilter,
      limit
    );

    resultRows = canonical.rows;
    source = canonical.source;

    // ─────────────────────────────────────────────
    // 2) fallback: wallet_items (canonical 이 없을 때만)
    // ─────────────────────────────────────────────
    if (source === "none") {
      const legacy = await fetchFromWalletItems(sql, userId, itemFilter, limit);
      resultRows = legacy.rows;
      source = legacy.source;
    }

    // 총 quantity 합계 (헤더용)
    const totalQty = resultRows.reduce((acc, r) => acc + r.qty, 0);

    const tookMs = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true, items: resultRows }, // 🧩 기존 계약 그대로
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Inventory-User": userId,
            "X-Inventory-Count": String(resultRows.length),
            "X-Inventory-Limit": String(limit),
            "X-Inventory-Source": source,
            "X-Inventory-Total-Qty": String(totalQty),
            "X-Inventory-Item-Filter": itemFilter || "",
            "X-Inventory-Category-Filter": categoryFilter || "",
            "X-Inventory-Kind-Filter": kindFilter || "",
            "X-Inventory-Took-ms": String(tookMs),
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
