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
//   • user_stats(coins, exp, tickets, games_played, updated_at)에서 포인트/경험치/티켓 읽기
//   • ensureUserStatsRow 로 user_stats row 선제 보장
//   • level 은 exp 기반으로 실시간 계산(기존 level 필드의 의미 유지)
// - 레거시 스키마 호환:
//   • user_stats 테이블이 없거나 행이 없으면 기존 user_progress + wallet_balances 를 fallback 으로 조회
// - 스키마 없음(초기 상태)에서도 항상 응답은 정상적으로 내려가고, stats 는 0/1/0 으로 반환
// - 운영 헤더: Cache-Control: no-store, X-Me-Took-ms

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

function toNumberSafe(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toNonNegativeInt(v: unknown): number {
  const n = Math.trunc(toNumberSafe(v));
  return n < 0 ? 0 : n;
}

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
 *   • 0 ~ 999      → 1레벨
 *   • 1000 ~ 1999  → 2레벨
 *   • 2000 ~ 2999  → 3레벨
 *   ...
 * - 상한은 적당히 999 레벨로 클램프
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
 * - user_stats(coins, exp, tickets) → points/exp/tickets
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

    const rows = (await sql/* sql */`
      select
        coins   as coins,
        exp     as exp,
        tickets as tickets,
        games_played
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
    const points = toNonNegativeInt(r.coins);
    const exp = toNonNegativeInt(r.exp);
    const tickets = toNonNegativeInt(r.tickets);
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
    await sql/* sql */`
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
    const progRows = (await sql/* sql */`
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
    await sql/* sql */`
      create table if not exists wallet_balances(
        user_id text primary key,
        balance bigint not null default 0
      )
    `;
  } catch {
    // 경쟁상태 등은 무시
  }

  try {
    const balRows = (await sql/* sql */`
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
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
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
    const rows = (await sql/* sql */`
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
      id: r.id, // uuid 문자열 그대로 반환 (기존 계약에서 number 였다면 이후 마이그레이션에서 맞춰 사용)
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
