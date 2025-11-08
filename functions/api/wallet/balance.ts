// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\balance.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → add tiny ambient type (editor-only)
// - ts(7031) request/env implicitly any        → annotate handler params
// - Keep contract/behavior identical

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
 * - 라우트/메서드: GET
 * - 입력: query.userId
 * - 응답 스키마: { ok: true, balance }
 *
 * 보강 사항:
 * - userId 정규화/검증(허용문자·길이)
 * - bigint → number 안전 변환, 음수 방지(지갑 일관성)
 * - 초기상태 내성(테이블 미존재 시 0 반환), 인덱스 보강
 * - 운영 헤더(Cache-Control: no-store, 처리시간)
 */

/* ───────── helpers ───────── */
function cleanUserId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().normalize("NFKC");
  return /^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s) ? s : null;
}

function toNonNegativeNumber(v: any): number {
  // bigint/문자열 모두 수용하여 안전 변환, 음수는 0으로 바운드
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string") n = Number(v);
  else n = 0;
  if (!Number.isFinite(n)) n = 0;
  return n < 0 ? 0 : Math.floor(n);
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

    const sql = getSql(env);

    // 스키마/인덱스 보강 (존재하면 무시)
    try {
      await sql`
        create table if not exists wallet_balances(
          user_id text primary key,
          balance bigint not null default 0
        )
      `;
      await sql`create index if not exists wallet_balances_user_idx on wallet_balances (user_id)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 초기 경쟁상태 등은 무시하고 계속 진행
      }
    }

    // 조회(미존재 시 0 반환)
    let balanceNum = 0;
    try {
      const rows = await sql`
        select balance
        from wallet_balances
        where user_id = ${userId}
        limit 1
      `;
      balanceNum = (rows as any[]).length ? toNonNegativeNumber((rows as any[])[0].balance) : 0;
    } catch (e) {
      if (!isMissingTable(e)) throw e; // 알 수 없는 오류는 전달
      balanceNum = 0;                  // 테이블이 아직 없으면 0으로 응답
    }

    return withCORS(
      json(
        { ok: true, balance: balanceNum },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Wallet-User": userId,
            "X-Wallet-Took-ms": String(Math.round(performance.now() - t0)),
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
