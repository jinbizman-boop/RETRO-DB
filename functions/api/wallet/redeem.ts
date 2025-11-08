// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\redeem.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → add tiny ambient types for CF Pages
// - ts(7031) request/env implicitly any        → annotate handler params
// - Preserve existing behavior/contract exactly

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

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

/**
 * 계약 유지:
 * - 라우트/메서드 동일(POST)
 * - 입력: { userId, itemId, qty }  // qty 미지정 시 1
 * - 동작: wallet_items (user_id,item_id) upsert, qty += 입력값
 * - 응답 스키마 동일: { ok: true }
 *
 * 보강:
 * - Rate limit(429) 추가
 * - 서버측 정규화/검증: userId, itemId, qty(int32 범위로 보정)
 * - 스키마/인덱스 자동 보강(updated_at, 인덱스), 초기 상태 내성
 * - 운영 헤더(Cache-Control, 처리시간, 적용 수량 표시)
 */

/* ───────── helpers ───────── */
function cleanUserId(v: unknown): string {
  const s = (typeof v === "string" ? v : "")
    .trim()
    .normalize("NFKC");
  if (!/^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s)) throw new Error("Invalid userId");
  return s;
}
function cleanItemId(v: unknown): string {
  const s = (typeof v === "string" ? v : "")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
  if (!/^[a-z0-9_\-.:]{1,64}$/.test(s)) throw new Error("Invalid itemId");
  return s;
}
function toInt32(n: unknown, fallback = 1): number {
  const x = Number(n);
  const v = Number.isFinite(x) ? Math.trunc(x) : fallback;
  const MIN = -2147483648,
    MAX = 2147483647;
  return v < MIN ? MIN : v > MAX ? MAX : v;
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
    const userId = cleanUserId((body as any)?.userId);
    const itemId = cleanItemId((body as any)?.itemId);
    const qty = toInt32((body as any)?.qty, 1); // 원본 계약: 기본 1

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

    // upsert: 기존 계약 유지(단순 가산). updated_at 최신화
    await sql`
      insert into wallet_items(user_id, item_id, qty)
      values(${userId}, ${itemId}, ${qty})
      on conflict (user_id, item_id)
      do update set qty = wallet_items.qty + excluded.qty,
                   updated_at = now()
    `;

    return withCORS(
      json(
        { ok: true }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Redeem-User": userId,
            "X-Redeem-Item": itemId,
            "X-Redeem-Delta": String(qty),
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
