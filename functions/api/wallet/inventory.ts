// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\inventory.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'       → add tiny ambient type (editor-only)
// - ts(7031) request/env implicitly any             → annotate handler params
// - ts(2558) Expected 0 type arguments, but got 1   → remove sql<Tag> generic usage
// - Keep route/contract/behavior intact

/* ───── Minimal Cloudflare Pages ambient types (type-checker only) ───── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
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
 * - userId 정규화/검증(허용문자·길이), item_id/limit 필터 옵션 추가
 * - 초기 상태 내성(테이블 미존재 허용), 인덱스 보강
 * - bigint/문자열 qty → number 안전 변환, 음수 방지
 * - 운영 헤더(Cache-Control: no-store, 처리시간, 제한 등)
 */

type RowRaw = { item_id: string; qty: number | string | bigint };
type RowSafe = { item_id: string; qty: number };

/* ───────── helpers ───────── */
function cleanUserId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().normalize("NFKC");
  return /^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s) ? s : null;
}

function cleanItemId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().normalize("NFKC");
  return /^[a-z0-9_\-.:]{1,64}$/.test(s) ? s : null;
}

function toNonNegativeInt(v: any): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string") n = Number(v);
  else n = 0;
  if (!Number.isFinite(n)) n = 0;
  n = Math.floor(n);
  return n < 0 ? 0 : n;
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

/* ───────── handler ───────── */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
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
    const userId = cleanUserId(url.searchParams.get("userId"));
    if (!userId) {
      return withCORS(
        json({ error: "userId required" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    // 선택: 특정 아이템만 조회 (?item=…), 응답 길이 제한 (?limit=…)
    const itemFilter = cleanItemId(url.searchParams.get("item"));
    const limitParam = url.searchParams.get("limit");
    const limit = Math.max(1, Math.min(500, limitParam ? Number(limitParam) : 500));

    const sql = getSql(env);

    // 스키마/인덱스 보강(존재하면 무시)
    try {
      await sql`
        create table if not exists wallet_items(
          user_id text not null,
          item_id text not null,
          qty int not null default 0,
          updated_at timestamptz not null default now(),
          primary key(user_id, item_id)
        )
      `;
      await sql`
        alter table wallet_items
        add column if not exists updated_at timestamptz not null default now()
      `;
      await sql`create index if not exists wallet_items_user_idx on wallet_items (user_id, updated_at desc)`;
      await sql`create index if not exists wallet_items_item_idx on wallet_items (item_id)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 초기 경쟁상태 등은 무시하고 계속 진행
      }
    }

    // 조회(미존재 시 빈 배열)
    let rowsAny: any[] = [];
    try {
      rowsAny = await sql`
        select item_id, qty
        from wallet_items
        where user_id = ${userId}
          ${itemFilter ? sql`and item_id = ${itemFilter}` : sql``}
        order by updated_at desc, item_id asc
        limit ${limit}
      `;
    } catch (e) {
      if (!isMissingTable(e)) throw e;
      rowsAny = [];
    }

    const rows = rowsAny as RowRaw[];

    // 타입 정규화: qty는 음수 방지 및 number로 통일
    const safe: RowSafe[] = rows.map((r) => ({
      item_id: r.item_id,
      qty: toNonNegativeInt(r.qty),
    }));

    return withCORS(
      json(
        { ok: true, items: safe }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Inventory-User": userId,
            "X-Inventory-Count": String(safe.length),
            "X-Inventory-Limit": String(limit),
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
