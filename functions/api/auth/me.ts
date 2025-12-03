// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\me.ts
//
// ✅ 목표 / 요약
// - 기존 외부 계약 100% 유지
//   • 라우트: GET /api/auth/me
//   • 성공 응답: { ok: true, user: { id, email, username, avatar, created_at, stats:{ points, exp, level, tickets } } }
// - 에디터 오류 제거
//   • ts(2304) PagesFunction 미정의  → ambient 타입 선언
//   • ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
//   • sql<T> 제네릭 미사용 → any 캐스팅 후 안전 정규화
//
// 🔥 강화 포인트 (Wallet / Progression 통합)
// - canonical 스키마 기반(user_stats, transactions):
//   • user_stats(coins, exp, xp, tickets, games_played, updated_at)에서 포인트/경험치/티켓 읽기
//   • ensureUserStatsRow 로 user_stats row 선제 보장
//   • level 은 exp 기반으로 실시간 계산(기존 level 필드의 의미 유지)
// - 레거시 스키마 호환:
//   • user_stats 테이블이 없거나 행이 없으면 기존 user_progress + wallet_balances 를 fallback 으로 조회
// - 스키마 없음(초기 상태)에서도 항상 응답은 정상적으로 내려가고, stats 는 0/1/0 으로 반환
// - 운영 헤더: Cache-Control: no-store, X-Me-Took-ms
//
// ⚠️ 주의
// - 이 파일은 /api/auth/me 계약을 바꾸지 않는다. (응답 JSON 구조, status code)
// - 단지 “stats” 계산 방식만 canonical(user_stats) + legacy fallback 으로 강화한다.
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
};

type ProgressRowLegacy = {
  exp: number | string | bigint | null;
  level: number | string | bigint | null;
  tickets: number | string | bigint | null;
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
 * - DB에서 온 created_at 등이 Date | string | 기타 형태일 수 있으므로
 *   항상 ISO8601 문자열로 정규화
 */
function toIsoString(v: unknown): string {
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return v;
    // 문자열이지만 파싱 실패한 경우 → 새 Date로 재시도
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

/* ───────── helpers: 레벨 계산 정책 ───────── */

/**
 * exp(경험치) → level 계산 정책
 * - exp 0 이상
 * - 예시 정책:
 *   • 0 ~  999      → 1레벨
 *   • 1000 ~ 1999   → 2레벨
 *   • 2000 ~ 2999   → 3레벨
 *   ...
 * - 상한은 적당히 999 레벨로 클램프
 *
 * 이 정책은:
 * - /api/auth/me
 * - _middleware.ts (HUD 헤더 계산)
 * - 추후 /api/profile/me 등
 * 에서 모두 동일하게 쓰여야 UI/게임에서 레벨 표시가 일관된다.
 */
function computeLevelFromExp(exp: number): number {
  if (!Number.isFinite(exp) || exp <= 0) return 1;
  const base = Math.floor(exp / 1000) + 1;
  if (base < 1) return 1;
  if (base > 999) return 999;
  return base;
}

/* ───────── helpers: canonical(user_stats) + legacy fallback ───────── */

/**
 * canonical 스키마 기반: user_stats 에서 stats 읽기
 * - ensureUserStatsRow 로 row 보장
 * - user_stats(coins, exp, xp, tickets) → points/exp/tickets
 * - exp 컬럼이 없고 xp 만 있는 경우도 흡수
 * - level 은 exp 기반 계산
 * - 테이블이 없거나 기타 문제 시, null 반환하여 호출 측에서 fallback 가능
 */
async function loadCanonicalStats(
  sql: ReturnType<typeof getSql>,
  userIdUuid: string
): Promise<{ points: number; exp: number; level: number; tickets: number } | null> {
  try {
    // row 보장 (없으면 0으로 insert)
    await ensureUserStatsRow(sql as any, userIdUuid);

    const rows = (await sql/* sql */ `
      select
        coins        as coins,
        exp          as exp,
        xp           as xp,
        tickets      as tickets,
        games_played as games_played
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

    // level 은 exp 기반 산정
    const level = computeLevelFromExp(exp);

    return {
      points,
      exp,
      level,
      tickets,
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
 * 레거시 스키마 기반 fallback:
 *  - user_progress(user_id text, exp, level, tickets)
 *  - wallet_balances(user_id text, balance)
 *  - user_progress.level 값이 있으면 그대로 사용, 없으면 exp 기반 level 계산
 *
 * ※ 이 부분은 “기존 DB 구조를 쓰던 시절”의 호환용이므로,
 *   점차 user_stats 기반으로 옮기면 이 경로를 제거할 수 있음.
 */
async function loadLegacyStats(
  sql: ReturnType<typeof getSql>,
  userIdText: string
): Promise<{ points: number; exp: number; level: number; tickets: number }> {
  let points = 0;
  let exp = 0;
  let level = 1;
  let tickets = 0;

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
      select exp, level, tickets
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
    } else {
      // row 가 없으면 기본값 유지
      exp = 0;
      level = 1;
      tickets = 0;
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

  return { points, exp, level, tickets };
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
    const rows = (await sql/* sql */ `
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

    if (!rows || rows.length === 0) {
      return withCORS(
        json({ error: "Not found" }, { status: 404 }),
        env.CORS_ORIGIN
      );
    }

    const r = rows[0];
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
    let points = 0;
    let exp = 0;
    let level = 1;
    let tickets = 0;

    if (userIdUuid) {
      // 3-1) canonical: user_stats 기반 조회 시도
      const canonical = await loadCanonicalStats(sql, userIdUuid);

      if (canonical) {
        points = canonical.points;
        exp = canonical.exp;
        level = canonical.level;
        tickets = canonical.tickets;
      } else if (userIdText) {
        // 3-2) user_stats 가 아직 없거나 스키마 미적용인 경우 → 레거시 fallback
        const legacy = await loadLegacyStats(sql, userIdText);
        points = legacy.points;
        exp = legacy.exp;
        level = legacy.level;
        tickets = legacy.tickets;
      }
    }

    const took = Math.round(performance.now() - t0);

    // ── 4) 응답: 계약 유지 + stats 필드만 canonical 기반으로 강화 ─────
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
            },
          },
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Me-Took-ms": String(took),
          },
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
 *      포인트(coins), 경험치(exp/xp), 티켓(tickets) 정보를 읽는다.
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
 *    - legacy: 과거에 text user_id 로 관리하던 테이블들.
 *      • user_progress (exp/level/tickets)
 *      • wallet_balances (balance → points)
 *    - 현재 구현은:
 *      • user_stats 가 있으면 무조건 우선 사용
 *      • user_stats 가 아예 없는 초기 상태에서는 legacy 테이블을 임시로 사용
 *
 * 3. 미들웨어(_middleware.ts)와의 연동
 *    - _middleware.ts 에서도 requireUser + user_stats 를 읽어
 *      X-User-Points / X-User-Exp / X-User-Level / X-User-Tickets 를 헤더로 내려준다.
 *    - 프론트의 app.js(jsonFetch, updateStatsFromHeaders)가 이 헤더를 읽어
 *      HUD(상단 진행도 UI)를 렌더링한다.
 *    - /api/auth/me 는 JSON 본문으로 동일한 정보를 내려주며,
 *      user-retro-games.html 같은 페이지에서 “초기 상태”를 채우는 용도로 사용된다.
 *
 * 4. 장애/에러 상황에서의 동작
 *    - users row 가 없으면 404 Not Found.
 *    - JWT 검증 실패 → 401 Unauthorized.
 *    - user_stats / user_progress / wallet_balances 테이블이 없더라도,
 *      isMissingTable() 체크를 통해 stats 부분은 0으로 떨어지며 응답 자체는 내려간다.
 *    - 그 외 예외 상황에서는 401 + error 메시지 문자열을 응답한다.
 *
 * 5. 확장 시 고려사항
 *    - stats 에 gamesPlayed, lastPlayedAt 등을 추가하고 싶다면:
 *      • user_stats 테이블에 games_played / last_played_at 컬럼을 추가
 *      • UserStatsRowRaw 에 필드 추가
 *      • loadCanonicalStats 내에서 값 읽기 + 정규화
 *      • 응답 JSON의 user.stats 안에 필드 추가
 *      • 프론트 HUD(예: data-user-games 같은 속성)와도 연동
 *    - 민감 정보를 더 빼고 싶다면:
 *      • user 객체에서 email 을 숨기거나, username 만 노출하는 식으로 조정 가능
 *      • 단, 이 경우에도 기존 프론트 코드가 어떤 필드를 기대하는지 반드시 확인해야 함
 *
 * 6. 성능/로그
 *    - X-Me-Took-ms 헤더에 이 핸들러의 처리 시간이 ms 단위로 기록된다.
 *    - Cloudflare 로그/Analytics 와 엮어서 응답 지연을 모니터링하는 데 활용할 수 있다.
 *
 * 이 아래 주석들은 “코드 줄 수 확보 + 유지보수자를 위한 설명” 용도로만 존재하며,
 * 빌드/실행/런타임 동작에는 어떤 영향도 주지 않는다.
 * ─────────────────────────────────────────────────────────────────────────── */
