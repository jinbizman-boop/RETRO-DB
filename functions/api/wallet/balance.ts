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
//     • 캐논 소스: user_stats.coins
//         - 게임 보상: /api/games/score → transactions → apply_wallet_transaction 트리거
//         - 상점 결제: /api/wallet/transaction, 향후 /api/shop/* → transactions 경로
//     • 2차 소스(fallback): wallet_balances.balance (구 스키마 호환용)
//     • userId 우선순위: X-User-Id 헤더(미들웨어에서 넣어준 UUID) → query.userId
//     • UUID 형식 검증, bigint/문자열 → number 안전 변환, 음수 방지
//     • user_stats 가 없거나 row 가 없으면 자동으로 0 반환
//     • 가능한 경우 exp / tickets / games_played / last_login_at / updated_at 을 헤더로 노출
//     • user_stats.coins 와 wallet_balances.balance 가 동시에 존재할 경우 drift 여부를 헤더로만 표기
//     • 초기 상태 내성(테이블 미존재 시 0 반환), 운영 헤더 유지/보강
//
// - 🌐 미들웨어 연동(B안)
//     • functions/_middleware.ts 가 인증 성공 시 Request 헤더에 X-User-Id 를 주입
//     • 이 엔드포인트는 해당 헤더를 최우선으로 사용 → 프론트가 userId 를 굳이 query 에 넣지 않아도 됨
//
// - 📊 헤더 요약 (프론트가 계정 상태를 바로 그릴 수 있도록):
//     • X-Wallet-User           : UUID (user_stats.user_id)
//     • X-Wallet-Source         : 'user_stats' | 'wallet_balances' | 'none'
//     • X-Wallet-Balance        : 최종 잔액(캐논 기준)
//     • X-Wallet-Legacy-Balance : wallet_balances 기준 잔액(있는 경우)
//     • X-Wallet-Exp            : user_stats.exp (없으면 0)
//     • X-Wallet-Tickets        : user_stats.tickets (없으면 0)
//     • X-Wallet-Games          : user_stats.games_played (없으면 0)
//     • X-Wallet-Last-Login-At  : user_stats.last_login_at
//     • X-Wallet-Stats-Updated-At : user_stats.updated_at
//     • X-Wallet-Drift          : 'stats_gt_wallet' | 'wallet_gt_stats' (둘 다 존재하고 값 다를 때)
//     • X-Wallet-Stats-Json     : { balance, exp, tickets, games } JSON 문자열
//     • X-Wallet-Took-ms        : 처리 시간(ms)
//
//  ※ 본문(JSON)은 { ok: true, balance } 그대로 유지. 프론트/게임 로직은 기존 코드 그대로 사용 가능.

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

/* ───────── helpers: userId / 숫자 변환 / 에러 타입 ───────── */

// users.id = UUID (001_init.sql 기준)
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 문자열 안전 정규화
 * - trim + NFKC
 */
function safeNormalizeStr(v: string): string {
  const trimmed = v.trim();
  try {
    return trimmed.normalize("NFKC");
  } catch {
    return trimmed;
  }
}

/**
 * userId 결정 로직
 *  1) X-User-Id / x-user-id 헤더 (미들웨어가 JWT 기반으로 주입)
 *  2) query.userId
 * 둘 중 하나도 없으면 null, 형식 오류(UUID 미일치)여도 null.
 */
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

/**
 * 모든 숫자 입력을 JS number 로 안전 변환
 * - bigint, string 모두 처리
 * - NaN/Infinity → 0
 * - 음수 → 0
 * - 너무 큰 값 → Number.MAX_SAFE_INTEGER 로 클램프
 */
function toNonNegativeNumber(v: any): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string") n = Number(v);
  else n = 0;

  if (!Number.isFinite(n)) n = 0;
  if (n < 0) n = 0;
  if (n > Number.MAX_SAFE_INTEGER) n = Number.MAX_SAFE_INTEGER;
  return Math.floor(n);
}

/**
 * Date/타임스탬프 컬럼을 ISO 문자열 또는 null 로 변환
 */
function toIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  try {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * relation / table 미존재 여부
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

/* ───────── 타입: 내부 조회 결과 구조 ───────── */

type StatsSource = "user_stats" | "wallet_balances" | "none";

type UserStatsRow = {
  coins?: number | string | bigint | null;
  exp?: number | string | bigint | null;
  xp?: number | string | bigint | null;
  tickets?: number | string | bigint | null;
  games_played?: number | string | bigint | null;
  last_login_at?: string | Date | null;
  updated_at?: string | Date | null;
};

type WalletBalanceRow = {
  balance?: number | string | bigint | null;
};

/* ───────── user_stats 조회 (canonical) ─────────
 * 001_init.sql + 003_shop_effects.sql + wallet C안 설계에서 정의한
 * user_stats 를 단일 소스 오브 트루스로 사용:
 *   coins, exp/xp, tickets, games_played, last_login_at, updated_at
 */
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
        xp,
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

    // coins: 실제 지갑 잔액
    const coins = toNonNegativeNumber(r.coins ?? 0);

    // exp: exp 컬럼 우선, 없으면 xp 컬럼 fallback
    const expCandidate = r.exp ?? r.xp ?? 0;
    const exp = toNonNegativeNumber(expCandidate);

    const tickets = toNonNegativeNumber(r.tickets ?? 0);
    const gamesPlayed = toNonNegativeNumber(r.games_played ?? 0);

    const lastLoginAt = toIsoOrNull(r.last_login_at ?? null);
    const updatedAt = toIsoOrNull(r.updated_at ?? null);

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

/* ───────── wallet_balances 조회 (fallback) ─────────
 * 과거 버전 및 일부 도구에서 사용하던 간단한 지갑 테이블.
 * 지금은 user_stats 가 캐논이지만:
 *   - user_stats row 가 아직 없는 계정
 *   - 마이그레이션 전 데이터
 * 에 대해서 안전하게 fallback 용도로만 사용한다.
 */

/**
 * wallet_balances 최소 스키마 보강
 */
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
      // (실제 조회 시 에러는 다시 한 번 확인)
    }
  }
}

/**
 * wallet_balances 로부터 잔액 조회
 */
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

/* ───────── handler ─────────
 *
 * 1) CORS preflight 처리
 * 2) GET 메서드만 허용
 * 3) userId 결정(X-User-Id 헤더 → query.userId)
 * 4) user_stats 기반 잔액/스탯 조회
 * 5) wallet_balances fallback 및 drift 체크
 * 6) { ok: true, balance } + 부가 헤더 반환
 */

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
    //    - user_stats 에 row 가 없거나, 또는 drift 체크용
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
      // 양쪽 다 있는 경우 drift 여부를 헤더로만 표기 (본문/계약은 변경 없음)
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
      // 캐논 유저/소스
      "X-Wallet-User": userId,
      "X-Wallet-Source": usedSource,
      // 캐논 잔액/스탯
      "X-Wallet-Balance": String(balanceNum),
      "X-Wallet-Exp": String(expNum),
      "X-Wallet-Tickets": String(ticketsNum),
      "X-Wallet-Games": String(gamesPlayedNum),
      "X-Wallet-Took-ms": String(tookMs),
    };

    if (lastLoginAt) headers["X-Wallet-Last-Login-At"] = lastLoginAt;
    if (statsUpdatedAt) headers["X-Wallet-Stats-Updated-At"] = statsUpdatedAt;
    if (legacyFound) headers["X-Wallet-Legacy-Balance"] = String(legacyBalance);
    if (driftFlag) headers["X-Wallet-Drift"] = driftFlag;

    // 프론트에서 한 번에 파싱하기 좋은 JSON 요약(선택적 사용)
    try {
      const summary = {
        balance: balanceNum,
        exp: expNum,
        tickets: ticketsNum,
        gamesPlayed: gamesPlayedNum,
        source: usedSource,
      };
      headers["X-Wallet-Stats-Json"] = JSON.stringify(summary);
    } catch {
      // JSON stringify 실패는 무시
    }

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
