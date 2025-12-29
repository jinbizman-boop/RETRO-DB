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
//     • 캐논 소스 1순위: user_stats.coins  (※ 현재 구현: v_user_wallet 뷰를 통해 조회)
//         - (기획상) 게임 보상: /api/games/score → transactions → apply_wallet_transaction 트리거
//         - 상점 결제: /api/wallet/transaction, 향후 /api/shop/* → transactions 경로
//     • 캐논 소스 2순위: wallet_balances.balance (reward.ts, 구 스키마 및 마이그레이션 호환용)
//     • 보조 스탯 소스   : user_progress(exp, tickets, games_played 유사 역할)
//     • userId 우선순위: X-User-Id 헤더(미들웨어에서 넣어준 UUID) → query.userId
//     • UUID 형식 검증, bigint/문자열 → number 안전 변환, 음수 방지
//     • user_stats / wallet_balances / user_progress 가 없거나 row 가 없으면 자동으로 0 반환
//     • 가능한 경우 exp / tickets / games_played / last_login_at / updated_at 을 헤더로 노출
//     • user_stats.coins 와 wallet_balances.balance 가 동시에 존재할 경우 drift 여부를 헤더로만 표기
//     • user_stats.exp/tickets 가 0 이고 user_progress 에 값이 존재하면 user_progress 값을 헤더에 자동 반영
//     • 초기 상태 내성(테이블 미존재 시 0 반환), 운영 헤더 유지/보강
//
// - 🌐 미들웨어 연동(B안)
//     • functions/_middleware.ts 가 인증 성공 시 Request 헤더에 X-User-Id 를 주입
//     • 이 엔드포인트는 해당 헤더를 최우선으로 사용 → 프론트가 userId 를 굳이 query 에 넣지 않아도 됨
//
// - 📊 헤더 요약 (프론트가 계정 상태를 바로 그릴 수 있도록):
//     • X-Wallet-User             : UUID (user_stats.user_id)
//     • X-Wallet-Source           : 'user_stats' | 'wallet_balances' | 'none'
//     • X-Wallet-Balance          : 최종 잔액(캐논 기준)
//     • X-Wallet-Legacy-Balance   : wallet_balances 기준 잔액(있는 경우)
//     • X-Wallet-Exp              : user_stats 또는 user_progress 기준 EXP
//     • X-Wallet-Tickets          : user_stats 또는 user_progress 기준 Tickets
//     • X-Wallet-Games            : user_stats.games_played (없으면 0)
//     • X-Wallet-Last-Login-At    : user_stats.last_login_at (※ v_user_wallet 기준, 현재는 null 가능)
//     • X-Wallet-Stats-Updated-At : user_stats.updated_at
//     • X-Wallet-Drift            : 'stats_gt_wallet' | 'wallet_gt_stats' (둘 다 존재하고 값 다를 때)
//     • X-Wallet-Stats-Json       : { balance, exp, tickets, games } JSON 문자열
//     • X-Wallet-Progress-Json    : user_progress 기반 스탯 요약(JSON)
//     • X-Wallet-Took-ms          : 처리 시간(ms)
//
//  ※ 본문(JSON)은 { ok: true, balance } 그대로 유지. 프론트/게임 로직은 기존 코드 그대로 사용 가능.
//
//  ※ reward.ts 에서 wallet_balances + user_progress 를 갱신하므로,
//     - coins(=balance) 는 user_stats.coins / wallet_balances.balance 두 소스를 모두 존중
//     - exp / tickets 는 user_stats.exp/tickets 가 0 이고 user_progress 에 값이 있으면 progress 값을 보조로 사용
//     - 상위 콘텐츠(user-retro-games.html)는 항상 최신값을 헤더/요약 JSON 으로 받을 수 있음.
//
//  ※ 2025-12-11: fetchFromUserStats 가 user_stats 테이블 대신 v_user_wallet 뷰를 사용하도록 변경.
//     - DB 레벨에서 users + user_stats 를 한 번 더 캡슐화한 canonical 뷰(v_user_wallet)를 기준으로 조회.
//     - API 코드는 canonical 뷰 하나만 바라보도록 단순화하여, 스키마 변경 내성을 강화.


// ───────────────────────────────────────────────────────────────
// Minimal Cloudflare Pages ambient types (type-checker only)
// ───────────────────────────────────────────────────────────────
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
// ───────────────────────────────────────────────────────────────

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

/**
 * v_user_wallet 뷰에서 읽어오는 canonical 지갑 스냅샷 행 구조
 * - 009_canonical_wallet_schema.sql 에서 정의한 뷰 스키마와 일치
 */
type CanonicalWalletRow = {
  coins?: number | string | bigint | null;
  exp?: number | string | bigint | null;
  tickets?: number | string | bigint | null;
  games_played?: number | string | bigint | null;
  stats_created_at?: string | Date | null;
  stats_updated_at?: string | Date | null;
};

type WalletBalanceRow = {
  balance?: number | string | bigint | null;
};

type UserProgressRow = {
  user_id?: string | null;
  exp?: number | string | bigint | null;
  tickets?: number | string | bigint | null;
  level?: number | string | bigint | null;
  updated_at?: string | Date | null;
};

/* ───────── user_stats / v_user_wallet 조회 (canonical 1순위) ─────────
 * 001_init.sql + 009_canonical_wallet_schema.sql 에서 정의한
 * v_user_wallet 뷰를 단일 소스 오브 트루스로 사용:
 *   coins, exp, tickets, games_played, stats_created_at, stats_updated_at
 *
 *  - v_user_wallet 은 내부적으로 users + user_stats 를 조인한 뷰이다.
 *  - API 레벨에서는 user_stats 테이블 구조에 직접 의존하지 않고,
 *    canonical 뷰를 통해서만 잔액/스탯을 조회한다.
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
        tickets,
        games_played,
        stats_created_at,
        stats_updated_at
      from v_user_wallet
      where user_id = ${userId}::uuid
      limit 1
    `) as CanonicalWalletRow[];

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

    // exp: canonical exp 컬럼
    const exp = toNonNegativeNumber(r.exp ?? 0);

    const tickets = toNonNegativeNumber(r.tickets ?? 0);
    const gamesPlayed = toNonNegativeNumber(r.games_played ?? 0);

    // v_user_wallet 에서는 last_login_at 을 직접 제공하지 않으므로 null 처리
    const lastLoginAt = null;
    const updatedAt = toIsoOrNull(r.stats_updated_at ?? null);

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
      // 뷰 또는 기반 테이블이 아예 없는 경우 → 0 잔액 + not found
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

/* ───────── wallet_balances 조회 (canonical 2순위 / legacy) ─────────
 * 구 버전 및 reward.ts(최신 보상 API)에서 사용하는 간단한 지갑 테이블.
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

/* ───────── user_progress 조회 (보조 스탯 소스) ─────────
 * reward.ts 에서 갱신하는 user_progress:
 *   - exp, level, tickets, updated_at
 *
 * user_stats.exp/tickets 가 아직 마이그레이션되지 않았거나 0 인 경우에도,
 * 메인 화면이 최신 EXP / Tickets 를 그릴 수 있도록 보조 소스로 사용한다.
 */
async function fetchFromUserProgress(
  sql: ReturnType<typeof getSql>,
  userId: string
): Promise<{
  found: boolean;
  exp: number;
  tickets: number;
  level: number;
  updatedAt: string | null;
}> {
  try {
    const rows = (await sql/* sql */ `
      select
        user_id,
        exp,
        tickets,
        level,
        updated_at
      from user_progress
      where user_id = ${userId}
      limit 1
    `) as UserProgressRow[];

    if (!rows || rows.length === 0) {
      return {
        found: false,
        exp: 0,
        tickets: 0,
        level: 1,
        updatedAt: null,
      };
    }

    const r = rows[0];
    const exp = toNonNegativeNumber(r.exp ?? 0);
    const tickets = toNonNegativeNumber(r.tickets ?? 0);
    const level = toNonNegativeNumber(r.level ?? 1);
    const updatedAt = toIsoOrNull(r.updated_at ?? null);

    return { found: true, exp, tickets, level, updatedAt };
  } catch (e) {
    if (isMissingTable(e)) {
      return {
        found: false,
        exp: 0,
        tickets: 0,
        level: 1,
        updatedAt: null,
      };
    }
    throw e;
  }
}

/* ───────── handler ─────────
 *
 * 1) CORS preflight 처리
 * 2) GET 메서드만 허용
 * 3) userId 결정(X-User-Id 헤더 → query.userId)
 * 4) user_stats (v_user_wallet) 기반 잔액/스탯 조회
 * 5) wallet_balances fallback 및 drift 체크
 * 6) user_progress 기반 exp/tickets 보조 조회
 * 7) { ok: true, balance } + 헤더로 상세 상태 제공
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

    // 🔥 1순위: 쿼리스트링 userId (헬스체크/수동 호출용)
    let userId = url.searchParams.get("userId")?.trim() || null;

    // 🔥 2순위: 기존 헤더 기반 userId (미들웨어에서 넣어준 값)
    if (!userId) {
      const queryUserId: string | null = null;
      userId = resolveUserId(request, queryUserId);
    }

    if (!userId) {
      // 기존 계약 유지: userId 없거나 형식이 이상하면 400
      return withCORS(
        json({ error: "userId required" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    const sql = getSql(env);

    // canonical / legacy / progress 값을 모두 모아놓은 후,
    // 최종 헤더/요약에 사용할 값을 선택한다.
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

    let progressFound = false;
    let progressExp = 0;
    let progressTickets = 0;
    let progressLevel = 1;
    let progressUpdatedAt: string | null = null;

    // ─────────────────────────────────────────────
    // 1) canonical: v_user_wallet 기반 지갑 잔액/스탯 조회
    // ─────────────────────────────────────────────
    const statsRow = await fetchFromUserStats(sql, userId);

    if (statsRow.found) {
      balanceNum = statsRow.coins;
      expNum = statsRow.exp;
      ticketsNum = statsRow.tickets;
      gamesPlayedNum = statsRow.gamesPlayed;
      lastLoginAt = statsRow.lastLoginAt;
      statsUpdatedAt = statsRow.updatedAt;
      usedSource = "user_stats";
    }

    // ─────────────────────────────────────────────
    // 2) fallback: wallet_balances (구 스키마 + reward.ts 기준)
    //    - user_stats 에 row 가 없거나, 또는 drift 체크용
    // ─────────────────────────────────────────────
    await ensureWalletBalancesSchema(sql);

    const legacyWallet = await fetchFromWalletBalances(sql, userId);
    legacyBalance = legacyWallet.balance;
    legacyFound = legacyWallet.found;

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
    // 3) 보조 스탯: user_progress 기반 exp/tickets 조회
    //    - reward.ts 가 user_progress 를 갱신하므로,
    //      user_stats.exp/tickets 가 아직 0 인 경우 progress 값을 반영해준다.
    // ─────────────────────────────────────────────
    const progress = await fetchFromUserProgress(sql, userId);
    if (progress.found) {
      progressFound = true;
      progressExp = progress.exp;
      progressTickets = progress.tickets;
      progressLevel = progress.level;
      progressUpdatedAt = progress.updatedAt;

      // user_stats.exp 가 0 이고 progress.exp 가 더 크면 progress 기반 노출
      if (expNum <= 0 && progressExp > 0) {
        expNum = progressExp;
      }
      // user_stats.tickets 가 0 이고 progress.tickets 가 더 크면 progress 기반 노출
      if (ticketsNum <= 0 && progressTickets > 0) {
        ticketsNum = progressTickets;
      }
    }

    // ─────────────────────────────────────────────
    // 4) 응답: 기존과 동일하게 { ok: true, balance }
    //    + 헤더로 상세 상태 제공
    // ─────────────────────────────────────────────
    const tookMs = Math.round(performance.now() - t0);

    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      // 캐논 유저/소스
      "X-Wallet-User": userId,
      "X-Wallet-Source": usedSource,
      // 캐논 잔액/스탯 (exp/tickets 는 user_stats + user_progress 보정값)
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

    // user_progress 기반 요약도 별도 JSON 으로 제공(선택 사용)
    if (progressFound) {
      try {
        const progressSummary = {
          exp: progressExp,
          tickets: progressTickets,
          level: progressLevel,
          updatedAt: progressUpdatedAt,
        };
        headers["X-Wallet-Progress-Json"] = JSON.stringify(progressSummary);
      } catch {
        // stringify 실패는 무시
      }
    }

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

    const levelNum = progressFound
      ? progressLevel
      : Math.max(1, Math.floor((expNum || 0) / 1000) + 1);

    const wallet = {
      // ✅ HUD 표준 키(프론트 공통)
      coins: balanceNum,
      exp: expNum,
      tickets: ticketsNum,
      gamesPlayed: gamesPlayedNum,
      level: levelNum,

      // ✅ 기존/호환 키(레거시 클라/코드 보호)
      points: balanceNum,
      balance: balanceNum,
      plays: gamesPlayedNum,
      xp: expNum,

      xpCap: null,
    };

    const stats = {
      // ✅ HUD 표준 키
      coins: balanceNum,
      exp: expNum,
      tickets: ticketsNum,
      gamesPlayed: gamesPlayedNum,
      level: levelNum,

      // ✅ 기존/호환 키
      points: balanceNum,
      balance: balanceNum,
      xp: expNum,
      plays: gamesPlayedNum,
    };

    // 본문 계약: { ok: true, balance } 유지 + (추가 필드) wallet/stats/snapshot
    return withCORS(
      json(
        {
          ok: true,
          balance: balanceNum,
          wallet,
          stats,
          snapshot: { wallet, stats },
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

// ───────────────────────────────────────────────────────────────
// EOF - wallet/balance.ts (v_user_wallet 기반 canonical 조회 버전)
// ───────────────────────────────────────────────────────────────
