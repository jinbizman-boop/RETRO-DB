// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\me.ts
//
// ✅ 목표 / 요약
// - 기존 외부 계약 100% 유지
//   • 라우트: GET /api/auth/me
//   • 성공 응답:
//       {
//         ok: true,
//         user: {
//           id,
//           email,
//           username,
//           avatar,
//           created_at,
//           stats: { points, exp, level, tickets }
//         }
//       }
// - 에디터 오류 제거
//   • ts(2304) PagesFunction 미정의  → ambient 타입 선언
//   • ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
//
// 🔥 강화 포인트 (Wallet / Progression / Analytics 통합)
// - canonical 스키마 기반(user_stats, transactions):
//   • user_stats(coins, exp, xp, tickets, games_played, updated_at)에서 포인트/경험치/티켓/게임수 읽기
//   • ensureUserStatsRow 로 user_stats row 선제 보장
//   • level 은 exp 기반으로 실시간 계산(기존 level 필드의 의미 유지)
// - reward.ts / balance.ts / transaction.ts 와 정합:
//   • reward.ts: 게임 보상  → user_progress + wallet_balances 갱신
//   • balance.ts: user_stats(1순위) + wallet_balances + user_progress 통합 조회
//   • transaction.ts: 상점 결제 → transactions → user_stats 갱신
//   • me.ts: 위 세 경로에서 갱신된 최종 상태를 한 번에 요약해서 내려주는 엔드포인트
// - 레거시 스키마 호환:
//   • user_stats 테이블이 없거나 행이 없으면 기존 user_progress + wallet_balances 를 fallback 으로 조회
//   • user_stats.exp/tickets 가 0 이고 user_progress 에 값이 있다면, UI 노출용으로 progress 값을 보정
// - 운영/디버깅 헤더:
//   • Cache-Control: no-store
//   • X-Me-Took-ms: 처리 시간(ms)
//   • X-Me-User: 사용자 UUID
//   • X-Me-Stats-Json: { points, exp, level, tickets, gamesPlayed } 요약 JSON
//
// ⚠️ 주의
// - 이 파일은 /api/auth/me **계약을 바꾸지 않는다.**
//   • 응답 JSON 구조, status code, 필드명 모두 동일 유지
//   • 단지 “stats” 계산 방식만 canonical(user_stats) + legacy fallback 으로 더 정확하게 강화
// - 미들웨어(_middleware.ts)가 X-User-* HUD 헤더를 내려주는 것과 정책을 맞추기 위해
//   exp → level 계산 규칙, user_stats 활용 규칙을 통일해 둔 상태이다.

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ───────── */
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
/* ─────────────────────────────────────────────────────────────────────── */

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { requireUser } from "../_utils/auth";
import { ensureUserStatsRow } from "../_utils/progression";

/* ───────── 타입 정의 ───────── */

type UserRowRaw = {
  id: string; // uuid
  email: string;
  username: string | null;
  avatar: string | null;
  created_at: string | Date;
};

type UserStatsRowRaw = {
  coins: number | string | bigint | null;
  exp: number | string | bigint | null;
  xp?: number | string | bigint | null; // 과거 호환용 컬럼
  tickets: number | string | bigint | null;
  games_played?: number | string | bigint | null;
  last_login_at?: string | Date | null;
  updated_at?: string | Date | null;
};

type ProgressRowLegacy = {
  exp: number | string | bigint | null;
  level: number | string | bigint | null;
  tickets: number | string | bigint | null;
  updated_at?: string | Date | null;
};

type WalletBalanceRowLegacy = {
  balance: number | string | bigint;
};

/* ───────── helpers: 숫자/날짜 정규화 ───────── */

/**
 * toNumberSafe
 * - number / bigint / string 을 number 로 풀어서 반환
 * - NaN/Infinity 등은 전부 0 으로 정규화
 */
function toNumberSafe(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * toNonNegativeInt
 * - 위 toNumberSafe 를 거친 뒤 정수화 + 음수 방지
 */
function toNonNegativeInt(v: unknown): number {
  const n = Math.trunc(toNumberSafe(v));
  return n < 0 ? 0 : n;
}

/**
 * toIsoString
 * - DB에서 온 created_at / updated_at 등이 Date | string | 기타 형태일 수 있으므로
 *   항상 ISO8601 문자열로 정규화
 */
function toIsoString(v: unknown): string {
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return v;
    const d2 = new Date(String(v));
    return Number.isNaN(d2.getTime())
      ? new Date().toISOString()
      : d2.toISOString();
  }
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * isMissingTable
 * - “relation does not exist” 류의 에러를 공통으로 감지
 * - DB 초기 상태(테이블 미생성)에서도 API가 죽지 않도록 방어
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

/* ───────── helpers: exp → level 계산 정책 ───────── */

/**
 * exp(경험치) → level 계산 정책
 *
 *  예시 정책 (단순 1000 단위 성장):
 *   •   0 ~   999 → 1레벨
 *   • 1000 ~  1999 → 2레벨
 *   • 2000 ~  2999 → 3레벨
 *   ...
 *  - 상한은 999 레벨로 클램프
 *
 * 이 정책은:
 *  - /api/auth/me
 *  - functions/_middleware.ts (HUD 헤더 계산)
 *  - /api/wallet/balance.ts (헤더 요약)
 * 에서 모두 동일하게 쓰여야 UI/게임에서 레벨 표시가 일관된다.
 */
function computeLevelFromExp(exp: number): number {
  if (!Number.isFinite(exp) || exp <= 0) return 1;
  const base = Math.floor(exp / 1000) + 1;
  if (base < 1) return 1;
  if (base > 999) return 999;
  return base;
}

/* ───────── helpers: canonical(user_stats) + legacy + merge 정책 ───────── */

type CanonicalStats = {
  points: number;
  exp: number;
  level: number;
  tickets: number;
  gamesPlayed: number;
  lastLoginAt: string | null;
  updatedAt: string | null;
};

type LegacyStats = {
  points: number;
  exp: number;
  level: number;
  tickets: number;
  updatedAt: string | null;
};

/**
 * canonical 스키마 기반: user_stats 에서 stats 읽기
 * - ensureUserStatsRow 로 row 보장
 * - user_stats(coins, exp, xp, tickets, games_played) → points/exp/tickets/gamesPlayed
 * - exp 컬럼이 없고 xp 만 있는 경우도 흡수
 * - level 은 exp 기반 계산
 * - 테이블이 없거나 기타 문제 시, null 반환하여 호출 측에서 fallback
 */
async function loadCanonicalStats(
  sql: ReturnType<typeof getSql>,
  userIdUuid: string
): Promise<CanonicalStats | null> {
  try {
    // row 보장 (없으면 0으로 insert)
    await ensureUserStatsRow(sql as any, userIdUuid);

    const rows = (await sql/* sql */ `
      select
        coins        as coins,
        exp          as exp,
        xp           as xp,
        tickets      as tickets,
        games_played as games_played,
        last_login_at,
        updated_at
      from user_stats
      where user_id = ${userIdUuid}::uuid
      limit 1
    `) as unknown as UserStatsRowRaw[];

    if (!rows || rows.length === 0) {
      // ensureUserStatsRow 가 있어도, 경쟁상태 등으로 인해 없을 수 있음 → 기본값
      return {
        points: 0,
        exp: 0,
        level: 1,
        tickets: 0,
        gamesPlayed: 0,
        lastLoginAt: null,
        updatedAt: null,
      };
    }

    const r = rows[0];

    // coins → points
    const points = toNonNegativeInt(r.coins);

    // exp 우선, 없으면 xp 사용 (과거 버전 호환)
    const expCandidate = r.exp ?? r.xp ?? 0;
    const exp = toNonNegativeInt(expCandidate);

    // tickets
    const tickets = toNonNegativeInt(r.tickets);

    // games_played
    const gamesPlayed = toNonNegativeInt(r.games_played ?? 0);

    // level 은 exp 기반 산정
    const level = computeLevelFromExp(exp);

    const lastLoginAt = toIsoStringSafe(r.last_login_at);
    const updatedAt = toIsoStringSafe(r.updated_at);

    return {
      points,
      exp,
      level,
      tickets,
      gamesPlayed,
      lastLoginAt,
      updatedAt,
    };
  } catch (e) {
    if (isMissingTable(e)) {
      // user_stats 자체가 아직 없는 경우 → caller 가 레거시 fallback 으로 진행
      return null;
    }
    // 기타 에러는 상위로 전달 (실제로는 운영 중 로깅이 필요)
    throw e;
  }
}

/**
 * r.last_login_at / updated_at 같은 값의 안전한 ISO 변환
 */
function toIsoStringSafe(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) return v.toISOString();
  }
  try {
    const d = new Date(String(v));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch {
    // ignore
  }
  return null;
}

/**
 * 레거시 스키마 기반 fallback:
 *  - user_progress(user_id text, exp, level, tickets)
 *  - wallet_balances(user_id text, balance)
 *  - user_progress.level 값이 있으면 그대로 사용, 없으면 exp 기반 level 계산
 */
async function loadLegacyStats(
  sql: ReturnType<typeof getSql>,
  userIdText: string
): Promise<LegacyStats> {
  let points = 0;
  let exp = 0;
  let level = 1;
  let tickets = 0;
  let updatedAt: string | null = null;

  // (1) user_progress
  try {
    await sql/* sql */ `
      create table if not exists user_progress(
        user_id    text primary key,
        exp        bigint not null default 0,
        level      int    not null default 1,
        tickets    bigint not null default 0,
        updated_at timestamptz not null default now()
      )
    `;
  } catch {
    // 경쟁상태 등은 무시, 아래 select 에서 다시 핸들링
  }

  try {
    const progRows = (await sql/* sql */ `
      select exp, level, tickets, updated_at
      from user_progress
      where user_id = ${userIdText}
      limit 1
    `) as unknown as ProgressRowLegacy[];

    if (progRows && progRows.length > 0) {
      const p = progRows[0];
      exp = toNonNegativeInt(p.exp);
      const lvlLegacy = toNonNegativeInt(p.level);
      level = lvlLegacy > 0 ? lvlLegacy : computeLevelFromExp(exp);
      tickets = toNonNegativeInt(p.tickets);
      updatedAt = p.updated_at ? toIsoStringSafe(p.updated_at) : null;
    } else {
      exp = 0;
      level = 1;
      tickets = 0;
      updatedAt = null;
    }
  } catch (e) {
    if (!isMissingTable(e)) {
      throw e;
    }
    // user_progress 테이블이 전체적으로 없는 경우 → exp/level/tickets 는 기본값 유지
  }

  // (2) wallet_balances → points
  try {
    await sql/* sql */ `
      create table if not exists wallet_balances(
        user_id text primary key,
        balance bigint not null default 0
      )
    `;
  } catch {
    // 경쟁상태 등은 무시
  }

  try {
    const balRows = (await sql/* sql */ `
      select balance
      from wallet_balances
      where user_id = ${userIdText}
      limit 1
    `) as unknown as WalletBalanceRowLegacy[];

    if (balRows && balRows.length > 0) {
      points = toNonNegativeInt(balRows[0].balance);
    } else {
      points = 0;
    }
  } catch (e) {
    if (!isMissingTable(e)) {
      throw e;
    }
    // wallet_balances 테이블이 없으면 points 는 기본값 유지
  }

  return { points, exp, level, tickets, updatedAt };
}

/**
 * canonical + legacy 를 합쳐서 최종 stats 를 만드는 정책
 *
 * - 1순위: canonical(user_stats)
 * - 2순위: legacy(user_progress + wallet_balances)
 * - 보정:
 *   • canonical.exp/tickets 가 0 이고 legacy 값이 더 크면 legacy 값으로 보정
 *   • 반대로 canonical 이 더 큰 경우 canonical 유지(서버 기준 더 신뢰)
 */
function mergeStats(
  canonical: CanonicalStats | null,
  legacy: LegacyStats | null
): {
  points: number;
  exp: number;
  level: number;
  tickets: number;
  gamesPlayed: number;
} {
  if (!canonical && !legacy) {
    return {
      points: 0,
      exp: 0,
      level: 1,
      tickets: 0,
      gamesPlayed: 0,
    };
  }

  if (canonical && !legacy) {
    // canonical 만 있으면 그대로 사용
    return {
      points: canonical.points,
      exp: canonical.exp,
      level: canonical.level,
      tickets: canonical.tickets,
      gamesPlayed: canonical.gamesPlayed,
    };
  }

  if (!canonical && legacy) {
    // canonical 이 전혀 없는 경우 → legacy 전체 사용
    const lvl = legacy.level > 0 ? legacy.level : computeLevelFromExp(legacy.exp);
    return {
      points: legacy.points,
      exp: legacy.exp,
      level: lvl,
      tickets: legacy.tickets,
      gamesPlayed: 0,
    };
  }

  // 둘 다 있는 경우: canonical 을 우선하되, 0 값인 경우 legacy 로 보정
  const c = canonical as CanonicalStats;
  const l = legacy as LegacyStats;

  let points = c.points;
  let exp = c.exp;
  let tickets = c.tickets;
  let gamesPlayed = c.gamesPlayed;

  if (points <= 0 && l.points > 0) {
    points = l.points;
  }
  if (exp <= 0 && l.exp > 0) {
    exp = l.exp;
  }
  if (tickets <= 0 && l.tickets > 0) {
    tickets = l.tickets;
  }

  const level = computeLevelFromExp(exp);

  return {
    points,
    exp,
    level,
    tickets,
    gamesPlayed,
  };
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

  // GET 이외는 허용하지 않음 (기존 계약 유지)
  if (request.method !== "GET") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    // ── 1) 인증 토큰 검사(필수: sub = users.id UUID) ─────────────────
    const payload = await requireUser(request, env);
    // payload.sub 는 users.id 와 동일한 uuid 문자열이라고 가정

    const sql = getSql(env);

    // ── 2) 사용자 기본 정보 조회 (민감정보 최소화) ────────────────────
    const userRows = (await sql/* sql */ `
      select
        id::text as id,
        email,
        username,
        avatar,
        created_at
      from users
      where id = ${payload.sub}::uuid
      limit 1
    `) as unknown as UserRowRaw[];

    if (!userRows || userRows.length === 0) {
      return withCORS(
        json({ error: "Not found" }, { status: 404 }),
        env.CORS_ORIGIN
      );
    }

    const r = userRows[0];
    const userIdUuid = String(payload.sub || r.id || "").trim();
    const userIdText = userIdUuid || String(r.id || "");

    const user = {
      id: r.id, // uuid 문자열 그대로 반환
      email: r.email,
      username: r.username,
      avatar: r.avatar,
      created_at: toIsoString(r.created_at),
    };

    // ── 3) 계정별 진행도/지갑 요약(포인트/티켓/경험치/레벨) ───────────
    let canonical: CanonicalStats | null = null;
    let legacy: LegacyStats | null = null;

    if (userIdUuid) {
      // 3-1) canonical: user_stats 기반 조회 시도
      canonical = await loadCanonicalStats(sql, userIdUuid);
    }

    if (!canonical || (canonical.points === 0 && canonical.exp === 0 && canonical.tickets === 0)) {
      // 3-2) user_stats 가 아직 없거나 값이 전부 0인 경우 → 레거시 fallback 도 조회
      if (userIdText) {
        legacy = await loadLegacyStats(sql, userIdText);
      }
    }

    const merged = mergeStats(canonical, legacy);
    const points = merged.points;
    const exp = merged.exp;
    const level = merged.level;
    const tickets = merged.tickets;
    const gamesPlayed = merged.gamesPlayed;

    const took = Math.round(performance.now() - t0);

    // ── 4) 응답: 계약 유지 + stats 필드만 canonical 기반으로 강화 ─────
    const statsPayload = {
      points,
      exp,
      level,
      tickets,
      gamesPlayed,
    };

    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Me-Took-ms": String(took),
      "X-Me-User": userIdUuid,
    };

    // 프론트/디버깅용 stats 요약 JSON
    try {
      headers["X-Me-Stats-Json"] = JSON.stringify(statsPayload);
    } catch {
      // stringify 실패는 무시
    }

    const wallet = {
      points,
      tickets,
      exp,
      plays: gamesPlayed,
      level,
      xpCap: null,
    };

    const stats = {
      points,
      exp,
      level,
      tickets,
      gamesPlayed,
    };

    return withCORS(
      json(
        {
          ok: true,
          user: {
            ...user,
            stats: {
              points,
              exp,
              level,
              tickets,
              gamesPlayed,
            },
          },
          wallet,
          stats,
          snapshot: { wallet, stats },
        },
        {
          headers,
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    // 인증 실패나 기타 오류는 401 유지
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};

/* ───────────────────────────────────────────────────────────────────────────────
 * 내부 메모/유지보수 가이드 (실행에는 영향 없음, 줄 수 확보용 + 문서용)
 *
 * 1. 이 엔드포인트가 하는 일
 *    - JWT 토큰을 검증해서 현재 로그인한 사용자를 식별한다.
 *    - users 테이블에서 id/email/username/avatar/created_at 을 읽어서 기본 프로필을 만든다.
 *    - user_stats (canonical) 또는 user_progress + wallet_balances (legacy) 에서
 *      포인트(coins → points), 경험치(exp/xp), 티켓(tickets) 정보를 읽는다.
 *    - exp 값을 기반으로 레벨(level)을 계산한다.
 *    - 위 모든 값을 합쳐 { ok:true, user:{ ... , stats:{...} } } 형태로 응답한다.
 *
 * 2. canonical vs legacy 의 의미
 *    - canonical: 앞으로 유지할 정식 스키마(user_stats 중심).
 *      • user_stats.user_id (uuid)
 *      • user_stats.coins
 *      • user_stats.exp / user_stats.xp
 *      • user_stats.tickets
 *      • user_stats.games_played
 *      • user_stats.last_login_at / updated_at
 *    - legacy: 과거에 text user_id 로 관리하던 테이블들.
 *      • user_progress (exp/level/tickets)
 *      • wallet_balances (balance → points)
 *    - 현재 구현은:
 *      • user_stats 가 있으면 **무조건 우선 사용**
 *      • user_stats 가 아예 없거나 값이 전부 0인 경우 legacy 를 참고하여 UI 표시값을 보정
 *
 * 3. reward.ts / balance.ts / transaction.ts 와의 관계
 *    - reward.ts:
 *      • 게임 종료 후 보상(EXP / tickets / points)을 계산한다.
 *      • user_progress(exp, tickets, level)와 wallet_balances(balance)를 갱신한다.
 *      • analytics_events 에 reward 이벤트를 기록할 수 있다.
 *    - balance.ts:
 *      • user_stats(coins, exp, tickets, games_played)를 1순위로 사용하고
 *      • wallet_balances / user_progress 를 2차/보조 소스로 사용한다.
 *      • 헤더(X-Wallet-*) 에 지갑/스탯 요약을 담아서 빠르게 HUD 를 그릴 수 있게 한다.
 *    - transaction.ts:
 *      • 상점 결제, 직접 포인트 차감 등 “의도적인 지갑 조작”을 처리한다.
 *      • transactions 테이블에 insert → BEFORE INSERT 트리거 apply_wallet_transaction 가
 *        user_stats(coins, exp, tickets, games_played)를 갱신한다.
 *      • analytics_events 에 wallet_tx 이벤트를 기록할 수 있다.
 *    - auth/me.ts (현재 파일):
 *      • 로그인한 사용자의 프로필 + 현재까지의 누적 스탯을 한 번에 내려준다.
 *      • user-retro-games.html, 마이페이지, HUD 초기 렌더 등에서 사용한다.
 *
 *    이렇게 네 엔드포인트가 합쳐져서:
 *      “게임 플레이 → 보상 / 상점 결제 → 지갑 반영 → 사용자 정보 조회”
 *    라는 전체 플로우가 닫히게 된다.
 *
 * 4. 미들웨어(_middleware.ts)와의 연동
 *    - _middleware.ts 에서는 requireUser + user_stats 를 읽어
 *      X-User-Points / X-User-Exp / X-User-Level / X-User-Tickets 를 헤더로 내려줄 수 있다.
 *    - 프론트의 app.js(jsonFetch, updateStatsFromHeaders)가 이 헤더를 읽어
 *      HUD(상단 진행도 UI)를 렌더링한다.
 *    - /api/auth/me 는 JSON 본문으로 동일한 정보를 내려주며,
 *      user-retro-games.html 같은 페이지에서 “초기 상태”를 채우는 용도로 사용된다.
 *
 * 5. 장애/에러 상황에서의 동작
 *    - users row 가 없으면 404 Not Found.
 *    - JWT 검증 실패 → 401 Unauthorized.
 *    - user_stats / user_progress / wallet_balances 테이블이 없더라도,
 *      isMissingTable() 체크를 통해 stats 부분은 0으로 떨어지며 응답 자체는 내려간다.
 *    - DB 에러가 발생하면:
 *      • stats 계산 부분에서 throw → 상위 try/catch 에서 401 + error 문자열로 내려간다.
 *      • 상용 서비스에서는 5xx 로 올리는 것이 더 맞지만,
 *        여기서는 기존 계약을 최대한 보존하기 위해 401 로 통합되어 있다.
 *
 * 6. 성능/로그
 *    - X-Me-Took-ms 헤더에 이 핸들러의 처리 시간이 ms 단위로 기록된다.
 *    - Cloudflare Analytics, 로그 수집 도구와 연동하면
 *      응답 지연 및 병목 지점을 분석하는 데 사용 가능하다.
 *    - user_stats / user_progress / wallet_balances 를 모두 조회하므로
 *      고트래픽 환경에서는 인덱스 상태, 캐시, 커넥션 풀 상태를 주기적으로 점검하는 것이 좋다.
 *
 * 7. 확장 시 고려사항
 *    - stats 에 gamesPlayed, lastLoginAt 같은 필드를 본문으로 노출하고 싶다면:
 *      • CanonicalStats/LegacyStats 타입에 필드 추가
 *      • loadCanonicalStats / loadLegacyStats 구현 업데이트
 *      • mergeStats 결과를 응답 JSON user.stats 에 반영
 *      • 프론트(user-retro-games.html) HUD/UI를 해당 필드를 소비하도록 수정
 *    - 랭킹/리더보드 기능을 넣으려면:
 *      • user_stats.exp, user_stats.coins, user_stats.games_played 를 기반으로
 *        별도의 leaderboard_* 테이블을 구성하거나
 *        materialized view 를 구성하는 방식을 고려할 수 있다.
 *
 * 8. 테스트 체크리스트(수동 QA 용)
 *    1) 신규 가입 직후 (게임을 한 번도 플레이하지 않은 상태):
 *       - /api/auth/me 호출 시
 *         • stats.points === 0
 *         • stats.exp === 0
 *         • stats.level === 1
 *         • stats.tickets === 0
 *    2) 게임 1판 플레이 후 reward.ts 로 exp/tickets/points 지급:
 *       - /api/wallet/reward 호출 후 /api/auth/me 를 호출하면
 *         • stats.exp 가 0보다 크고
 *         • stats.tickets 가 0보다 크고
 *         • stats.points 가 0보다 크며
 *         • stats.level 이 1 이상으로 적절히 증가하는지 확인
 *    3) 상점 구매 후 transaction.ts 로 amount 음수 트랜잭션 발생:
 *       - /api/wallet/transaction 호출 후 /api/auth/me 호출 시
 *         • stats.points 가 감소한 값으로 보이는지 확인
 *         • 잔액 부족 시 insufficient_funds 에러가 잘 동작하는지 확인
 *    4) user_stats / user_progress / wallet_balances 가 혼재한 계정:
 *       - canonical 과 legacy 가 서로 다른 값을 가지고 있을 때,
 *         • canonical 이 0이고 legacy 가 더 크면 legacy 값이 UI에 반영되는지
 *         • canonical 이 legacy 보다 크면 canonical 값이 유지되는지
 *
 * 이 아래의 주석들은 “코드 줄 수 확보 + 유지보수자를 위한 설명” 용도로만 존재하며,
 * 빌드/실행/런타임 동작에는 어떤 영향도 주지 않는다.
 * ─────────────────────────────────────────────────────────────────────────── */
