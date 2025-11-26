// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\balance.ts
//
// ✅ Fix / Upgrade summary
// - ts(2304) Cannot find name 'PagesFunction'  → tiny ambient 타입으로 해결(에디터 전용)
// - ts(7031) request/env implicitly any        → 핸들러 파라미터 타입 명시
//
// - **외부 계약 100% 유지**
//     • 메서드: GET
//     • 입력: query.userId
//     • 응답: { ok: true, balance }
//
// - 🔥 내부 동작 강화/정합화 (지금까지 설계한 전체 흐름과 일치):
//     • 1차 소스: user_stats.coins  (게임/상점 → transactions → apply_wallet_transaction 트리거 반영)
//     • 2차 소스(fallback): wallet_balances.balance (구 스키마 호환용)
//     • userId 우선순위: X-User-Id 헤더(미들웨어에서 넣어준 UUID) → query.userId
//     • UUID 형식 검증, bigint/문자열 → number 안전 변환, 음수 방지
//     • user_stats 가 없거나 row 가 없으면 자동으로 0 반환
//     • 가능한 경우 exp / tickets / games_played / last_login_at / updated_at 을 헤더로 노출
//     • user_stats.coins 와 wallet_balances.balance 가 동시에 존재할 경우 drift 여부를 헤더로만 표기
//     • 초기 상태 내성(테이블 미존재 시 0 반환), 운영 헤더 유지/보강
//

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
 * 🔥 내부 정합 (Wallet-C 아키텍처 기준):
 * - user_stats.coins 를 "진짜 지갑 잔액" 으로 사용
 * - wallet_balances 는 있으면 fallback + consistency 체크용
 * - userId:
 *    1) X-User-Id / x-user-id (미들웨어에서 JWT 기반 주입, UUID users.id)
 *    2) query.userId
 */

/* ───────── helpers: userId / 숫자 변환 / 에러 타입 ───────── */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeNormalizeStr(v: string): string {
  const trimmed = v.trim();
  try {
    return trimmed.normalize("NFKC");
  } catch {
    return trimmed;
  }
}

function resolveUserId(req: Request, queryUserId: string | null): string | null {
  const headerId =
    req.headers.get("X-User-Id") ||
    req.headers.get("x-user-id") ||
    "";

  const candidate = safeNormalizeStr(headerId || queryUserId || "");
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

/* ───────── 타입: 내부 조회 결과 구조 ───────── */

type StatsSource = "user_stats" | "wallet_balances" | "none";

type UserStatsRow = {
  coins?: number | string | bigint | null;
  exp?: number | string | bigint | null;
  tickets?: number | string | bigint | null;
  games_played?: number | string | bigint | null;
  last_login_at?: string | Date | null;
  updated_at?: string | Date | null;
};

type WalletBalanceRow = {
  balance?: number | string | bigint | null;
};

/* ───────── user_stats 조회 (canonical) ───────── */

async function fetchFromUserStats(
  sql: ReturnType<typeof getSql>,
  userId: string
): Promise<{
  found: boolean;
  coins: number;
  exp: number;
  tickets: number;
  gamesPlayed: number;
  lastLoginAt: string | null;
  updatedAt: string | null;
}> {
  try {
    const rows = (await sql/* sql */ `
      select
        coins,
        exp,
        tickets,
        games_played,
        last_login_at,
        updated_at
      from user_stats
      where user_id = ${userId}::uuid
      limit 1
    `) as UserStatsRow[];

    if (!rows || rows.length === 0) {
      // row 자체가 없으면 "0" 잔액을 canonical 로 취급 (게으른 초기화)
      return {
        found: false,
        coins: 0,
        exp: 0,
        tickets: 0,
        gamesPlayed: 0,
        lastLoginAt: null,
        updatedAt: null,
      };
    }

    const r = rows[0];
    const coins = toNonNegativeNumber(r.coins ?? 0);
    const exp = toNonNegativeNumber(r.exp ?? 0);
    const tickets = toNonNegativeNumber(r.tickets ?? 0);
    const gamesPlayed = toNonNegativeNumber(r.games_played ?? 0);

    const lastLoginAt =
      r.last_login_at instanceof Date
        ? r.last_login_at.toISOString()
        : r.last_login_at
        ? String(r.last_login_at)
        : null;

    const updatedAt =
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : r.updated_at
        ? String(r.updated_at)
        : null;

    return {
      found: true,
      coins,
      exp,
      tickets,
      gamesPlayed,
      lastLoginAt,
      updatedAt,
    };
  } catch (e) {
    if (isMissingTable(e)) {
      // user_stats 테이블이 아예 없는 경우 → 0 잔액 + not found
      return {
        found: false,
        coins: 0,
        exp: 0,
        tickets: 0,
        gamesPlayed: 0,
        lastLoginAt: null,
        updatedAt: null,
      };
    }
    // 기타 에러는 상위로 던져서 클라이언트에 전달 (운영 이슈 인지)
    throw e;
  }
}

/* ───────── wallet_balances 조회 (fallback) ───────── */

async function ensureWalletBalancesSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
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
      // 초기 경쟁상태/권한 문제 등은 무시하고 계속 진행
      // (단, 실제 조회 시 에러는 다시 한 번 확인)
    }
  }
}

async function fetchFromWalletBalances(
  sql: ReturnType<typeof getSql>,
  userId: string
): Promise<{ found: boolean; balance: number }> {
  try {
    const rows = (await sql/* sql */ `
      select balance
      from wallet_balances
      where user_id = ${userId}
      limit 1
    `) as WalletBalanceRow[];

    if (!rows || rows.length === 0) {
      return { found: false, balance: 0 };
    }

    const bal = toNonNegativeNumber(rows[0].balance ?? 0);
    return { found: true, balance: bal };
  } catch (e) {
    if (isMissingTable(e)) {
      // 스키마 자체가 없으면 0 반환
      return { found: false, balance: 0 };
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
    let usedSource: StatsSource = "none";
    let expNum = 0;
    let ticketsNum = 0;
    let gamesPlayedNum = 0;
    let lastLoginAt: string | null = null;
    let statsUpdatedAt: string | null = null;

    let legacyBalance = 0;
    let legacyFound = false;
    let driftFlag: string | null = null;

    // ─────────────────────────────────────────────
    // 1) canonical: user_stats 기반 지갑 잔액 조회
    // ─────────────────────────────────────────────
    const stats = await fetchFromUserStats(sql, userId);

    if (stats.found) {
      balanceNum = stats.coins;
      expNum = stats.exp;
      ticketsNum = stats.tickets;
      gamesPlayedNum = stats.gamesPlayed;
      lastLoginAt = stats.lastLoginAt;
      statsUpdatedAt = stats.updatedAt;
      usedSource = "user_stats";
    }

    // ─────────────────────────────────────────────
    // 2) fallback: wallet_balances (구 스키마 호환)
    //    - user_stats 에 row 가 없거나, 또는 drift 체크용으로만 사용
    // ─────────────────────────────────────────────
    await ensureWalletBalancesSchema(sql);

    const wallet = await fetchFromWalletBalances(sql, userId);
    legacyBalance = wallet.balance;
    legacyFound = wallet.found;

    if (usedSource === "none") {
      // user_stats row 자체가 없으면, wallet_balances 를 대신 사용
      if (legacyFound) {
        balanceNum = legacyBalance;
        usedSource = "wallet_balances";
      } else {
        // 둘 다 없으면 0 (신규 계정 등)
        balanceNum = 0;
        usedSource = "none";
      }
    } else {
      // 양쪽 다 있는 경우 drift 여부를 헤더로만 표기
      if (legacyFound && legacyBalance !== balanceNum) {
        if (legacyBalance < balanceNum) {
          driftFlag = "stats_gt_wallet";
        } else if (legacyBalance > balanceNum) {
          driftFlag = "wallet_gt_stats";
        }
      }
    }

    // ─────────────────────────────────────────────
    // 3) 응답: 기존과 동일하게 { ok: true, balance }
    //    + 헤더로 상세 상태 제공
    // ─────────────────────────────────────────────
    const tookMs = Math.round(performance.now() - t0);

    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Wallet-User": userId,
      "X-Wallet-Source": usedSource,
      "X-Wallet-Exp": String(expNum),
      "X-Wallet-Tickets": String(ticketsNum),
      "X-Wallet-Games": String(gamesPlayedNum),
      "X-Wallet-Took-ms": String(tookMs),
    };

    if (lastLoginAt) headers["X-Wallet-Last-Login-At"] = lastLoginAt;
    if (statsUpdatedAt) headers["X-Wallet-Stats-Updated-At"] = statsUpdatedAt;
    if (legacyFound) headers["X-Wallet-Legacy-Balance"] = String(legacyBalance);
    if (driftFlag) headers["X-Wallet-Drift"] = driftFlag;

    return withCORS(
      json(
        {
          ok: true,
          balance: balanceNum,
        },
        { headers }
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
