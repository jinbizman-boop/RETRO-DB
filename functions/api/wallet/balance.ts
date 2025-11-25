// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\balance.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → tiny ambient 타입으로 해결(에디터 전용)
// - ts(7031) request/env implicitly any        → 핸들러 파라미터 타입 명시
// - 기존 외부 계약 100% 유지:
//     • 메서드: GET
//     • 입력: query.userId
//     • 응답: { ok: true, balance }
// - 🔥 내부 동작 강화/정합화:
//     • 주 지갑 소스: migrations/001_init.sql 의 user_stats.coins
//     • 보조/레거시: wallet_balances (있으면 fallback)
//     • userId 우선순위: X-User-Id 헤더(미들웨어가 넣어준 UUID) → query.userId
//     • UUID 형식 검증, bigint → number 안전 변환, 음수 방지
//     • 초기 상태 내성(테이블 미존재 시 0 반환), 운영 헤더 유지/보강

/* ───── Minimal Cloudflare Pages ambient types (type-checker only) ───── */
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
 * - 라우트/메서드: GET
 * - 입력: query.userId
 * - 응답 스키마: { ok: true, balance }
 *
 * 🔥 내부 정합:
 * - user_stats.coins 를 "진짜 지갑 잔액" 으로 사용
 * - wallet_balances 는 있으면 fallback 전용 (구 스키마 호환)
 * - userId:
 *    1) X-User-Id / x-user-id (미들웨어에서 JWT 기반 주입, UUID users.id)
 *    2) query.userId
 */

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

function toNonNegativeNumber(v: any): number {
  // bigint/문자열 모두 수용하여 안전 변환, 음수는 0으로 바운드
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string") n = Number(v);
  else n = 0;
  if (!Number.isFinite(n)) n = 0;
  if (n < 0) n = 0;
  // 너무 큰 값은 JS safe integer 범위로 방어적 클램프
  if (n > Number.MAX_SAFE_INTEGER) n = Number.MAX_SAFE_INTEGER;
  return Math.floor(n);
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
      // 기존 계약 유지: userId 없거나 형식이 이상하면 400
      return withCORS(
        json({ error: "userId required" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    const sql = getSql(env);

    let balanceNum = 0;
    let usedSource: "user_stats" | "wallet_balances" | "none" = "none";
    let expNum = 0;
    let ticketsNum = 0;
    let gamesPlayedNum = 0;

    // ─────────────────────────────────────────────
    // 1) canonical: user_stats 기반 지갑 잔액 조회
    //    - coins: 잔액
    //    - exp / tickets / games_played 도 함께 조회해서
    //      헤더에만 노출 (JSON 계약은 그대로).
    // ─────────────────────────────────────────────
    try {
      const rows = (await sql/* sql */ `
        select
          coins,
          exp,
          tickets,
          games_played
        from user_stats
        where user_id = ${userId}::uuid
        limit 1
      `) as {
        coins?: number | string | bigint | null;
        exp?: number | string | bigint | null;
        tickets?: number | string | bigint | null;
        games_played?: number | string | bigint | null;
      }[];

      if (rows && rows.length > 0) {
        const r = rows[0];
        balanceNum = toNonNegativeNumber(r.coins ?? 0);
        expNum = toNonNegativeNumber(r.exp ?? 0);
        ticketsNum = toNonNegativeNumber(r.tickets ?? 0);
        gamesPlayedNum = toNonNegativeNumber(r.games_played ?? 0);
        usedSource = "user_stats";
      }
    } catch (e) {
      if (!isMissingTable(e)) {
        // user_stats 가 있는데 에러면 그대로 던져서 클라이언트에 전달
        throw e;
      }
      // user_stats 테이블 자체가 없으면 legacy fallback 으로 진행
    }

    // ─────────────────────────────────────────────
    // 2) fallback: wallet_balances (구 스키마 호환)
    //    - 새 코드에서는 더 이상 여기에 write 하지 않지만,
    //      이전 배포/DB 구조까지 고려한 안전장치로 유지.
    // ─────────────────────────────────────────────
    if (usedSource === "none") {
      try {
        await sql/* sql */ `
          create table if not exists wallet_balances(
            user_id text primary key,
            balance bigint not null default 0
          )
        `;
        await sql/* sql */ `
          create index if not exists wallet_balances_user_idx
          on wallet_balances (user_id)
        `;
      } catch (e) {
        if (!isMissingTable(e)) {
          // 초기 경쟁상태 등은 무시하고 계속 진행
        }
      }

      try {
        const rows = await sql/* sql */ `
          select balance
          from wallet_balances
          where user_id = ${userId}
          limit 1
        `;
        balanceNum = (rows as any[]).length
          ? toNonNegativeNumber((rows as any[])[0].balance)
          : 0;
        usedSource = "wallet_balances";
      } catch (e) {
        if (!isMissingTable(e)) throw e;
        balanceNum = 0; // 테이블이 아직 없으면 0으로 응답
        usedSource = "none";
      }
    }

    return withCORS(
      json(
        {
          ok: true,
          balance: balanceNum,
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Wallet-User": userId,
            "X-Wallet-Source": usedSource,
            "X-Wallet-Exp": String(expNum),
            "X-Wallet-Tickets": String(ticketsNum),
            "X-Wallet-Games": String(gamesPlayedNum),
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
