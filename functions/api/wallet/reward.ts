// functions/api/wallet/reward.ts
// ------------------------------------------------------------
// POST /api/wallet/reward
// - app.js(window.sendGameReward)에서 호출하는 보상 지급 엔드포인트
// - ✅ Neon(getSql) 기반으로 통일
// - ✅ app.js 해시 규칙과 100% 일치:
//     raw = `${userId}|${gameId}|${exp}|${tickets}|${points}|${secret}`
// - ✅ 응답: { success:true, wallet, stats, reward, game, userId }
//
// 주의:
// - 이미 게임들이 /api/games/finish 와 /api/wallet/reward 를 "둘 다" 호출하면
//   보상이 중복될 수 있음. (게임 페이지에서 한 쪽만 쓰도록 정리 권장)
// ------------------------------------------------------------

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { allow as rateAllow } from "../_utils/rate-limit";

type CfEventLike<E = unknown> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;

function toStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function toNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function clampNonNeg(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * userId 해석 우선순위:
 * 1) _middleware.ts가 주입한 ctx.data.auth.userId
 * 2) 헤더 X-User-Id
 * 3) body.userId
 */
function resolveUserId(ctx: CfEventLike<Env>, body: any): string | null {
  const dataUserId = (ctx.data as any)?.auth?.userId;
  const headerId =
    ctx.request.headers.get("X-User-Id") ||
    ctx.request.headers.get("x-user-id") ||
    "";
  const bodyId = body?.userId;

  const id = toStr(dataUserId || headerId || bodyId);
  return id || null;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * ✅ app.js(buildRewardHash)와 동일 규칙
 * raw = `${userId}|${gameId}|${exp}|${tickets}|${points}|${secret}`
 */
async function buildServerRewardHash(
  userId: string,
  gameId: string,
  exp: number,
  tickets: number,
  points: number,
  secret: string
): Promise<string> {
  const raw = `${userId}|${gameId}|${exp}|${tickets}|${points}|${secret}`;
  return sha256Hex(raw);
}

/**
 * 기본 보상 테이블 (game_rewards.json이 없거나 접근 실패 시 fallback)
 * - 필요하면 너가 실제 밸런스에 맞게 수치 조정 가능
 */
function fallbackRewardRule(gameId: string) {
  const g = gameId.toLowerCase();

  if (g === "2048") return { exp: 20, tickets: 1, points: 8, maxExp: 200, maxTickets: 3, maxPoints: 100 };
  if (g === "tetris") return { exp: 18, tickets: 1, points: 7, maxExp: 200, maxTickets: 3, maxPoints: 100 };
  if (g === "brick-breaker") return { exp: 16, tickets: 1, points: 6, maxExp: 200, maxTickets: 3, maxPoints: 100 };
  if (g === "retro-running") return { exp: 16, tickets: 1, points: 6, maxExp: 200, maxTickets: 3, maxPoints: 100 };
  if (g === "brick-match") return { exp: 14, tickets: 1, points: 5, maxExp: 180, maxTickets: 3, maxPoints: 90 };
  if (g === "today-lucky" || g === "lucky-slot") return { exp: 5, tickets: 1, points: 2, maxExp: 50, maxTickets: 2, maxPoints: 15 };

  // unknown game: 클라이언트 전달값만 허용(상한은 넉넉히)
  return { exp: 0, tickets: 0, points: 0, maxExp: 200, maxTickets: 5, maxPoints: 200 };
}

function clampByMax(v: number, max?: number): number {
  const n = clampNonNeg(v);
  if (typeof max === "number" && Number.isFinite(max) && max >= 0) return Math.min(n, Math.floor(max));
  return n;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;

  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "POST") {
    return withCORS(json({ success: false, error: "Only POST supported" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // (선택) 간단 레이트리밋 (프로젝트 유틸: allow(req)만 제공)
  const ok = await rateAllow(request);
  if (!ok) {
    return withCORS(
      json(
        { success: false, error: "rate_limited" },
        { status: 429, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }

  // Parse JSON safely
  let body: any = null;
  try {
    body = await readJSON(request);
  } catch {
    body = null;
  }
  if (!body) {
    return withCORS(json({ success: false, error: "Invalid JSON body" }, { status: 400 }), env.CORS_ORIGIN);
  }

  const userId = resolveUserId(ctx, body);
  const gameId = toStr(body?.game || body?.gameId || body?.slug || "unknown").toLowerCase();
  const reason = toStr(body?.reason || "reward") || "reward";

  if (!userId) return withCORS(json({ success: false, error: "Missing userId" }, { status: 401 }), env.CORS_ORIGIN);
  if (!gameId) return withCORS(json({ success: false, error: "Missing game" }, { status: 400 }), env.CORS_ORIGIN);

  // client values (0이면 서버 룰로 자동계산)
  const clientExp = clampNonNeg(toNum(body?.exp));
  const clientTickets = clampNonNeg(toNum(body?.tickets));
  const clientPoints = clampNonNeg(toNum(body?.points));

  // ✅ 해시 검증
  // - app.js는 nonce 없이 계산하므로, 서버도 동일 규칙으로 맞춘다.
  // - env.REWARD_SECRET_KEY가 없으면 빈 문자열로 처리(개발 단계에서 동작 보장)
  const providedHash = toStr(body?.hash);
  const secretKey = String((env as any).REWARD_SECRET_KEY || "");

  if (!providedHash) {
    return withCORS(json({ success: false, error: "Missing reward hash" }, { status: 400 }), env.CORS_ORIGIN);
  }

  const expected = await buildServerRewardHash(userId, gameId, clientExp, clientTickets, clientPoints, secretKey);
  if (providedHash !== expected) {
    return withCORS(
      json(
        { success: false, error: "Hash mismatch – reward rejected (anti-cheat)" },
        { status: 409 }
      ),
      env.CORS_ORIGIN
    );
  }

  // ✅ 보상 최종값 결정: (클라 값 > 0) 우선, 아니면 서버 룰
  const rule = fallbackRewardRule(gameId);

  const finalExp = clampByMax(clientExp > 0 ? clientExp : (rule.exp || 0), rule.maxExp);
  const finalTickets = clampByMax(clientTickets > 0 ? clientTickets : (rule.tickets || 0), rule.maxTickets);
  const finalPoints = clampByMax(clientPoints > 0 ? clientPoints : (rule.points || 0), rule.maxPoints);

  if (finalExp === 0 && finalTickets === 0 && finalPoints === 0) {
    return withCORS(
      json(
        {
          success: true,
          userId,
          game: gameId,
          reward: { exp: 0, tickets: 0, points: 0 },
          wallet: { coins: 0, balance: 0, points: 0, tickets: 0, exp: 0, xp: 0, level: 1 },
          stats: { coins: 0, balance: 0, points: 0, tickets: 0, exp: 0, xp: 0, level: 1 },
          noop: true,
        },
        { headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const sql = getSql(env);

  try {
    // ✅ getSql은 begin()/commit() 트랜잭션을 제공하지 않음
    // ✅ 단일 CTE 쿼리로: (1) user_stats 보정 (2) 갱신 (3) wallet_balances 동기화
    const [st] = await sql/* sql */`
      with ensure as (
        insert into user_stats (user_id)
        values (${userId}::uuid)
        on conflict (user_id) do nothing
      ),
      cur as (
        select coins, exp, tickets, games_played, level
        from user_stats
        where user_id = ${userId}::uuid
      ),
      upd as (
        update user_stats
        set coins = greatest(0, (select coins from cur) + ${finalPoints}),
            exp = greatest(0, (select exp from cur) + ${finalExp}),
            tickets = greatest(0, (select tickets from cur) + ${finalTickets}),
            updated_at = now()
        where user_id = ${userId}::uuid
        returning coins, exp, tickets, games_played, level
      ),
      wb as (
        insert into wallet_balances (user_id, balance, updated_at)
        select ${userId}::uuid, (select coins from upd), now()
        on conflict (user_id)
        do update set balance = excluded.balance, updated_at = excluded.updated_at
      )
      select
        (select coins from upd) as coins,
        (select exp from upd) as exp,
        (select tickets from upd) as tickets,
        (select games_played from upd) as games_played,
        (select level from upd) as level
    `;

    const nextCoins = Math.max(0, Number(st?.coins ?? 0));
    const nextExp = Math.max(0, Number(st?.exp ?? 0));
    const nextTickets = Math.max(0, Number(st?.tickets ?? 0));
    const curGames = Math.max(0, Number(st?.games_played ?? 0));
    const curLevel = Math.max(1, Number(st?.level ?? 1));

    // analytics_events가 있으면 기록(없어도 보상은 성공)
    try {
      await sql/* sql */`
        insert into analytics_events (user_id, event_type, meta, created_at)
        values (
          ${userId}::uuid,
          'wallet_reward',
          ${JSON.stringify({
            gameId,
            reason,
            exp: finalExp,
            tickets: finalTickets,
            points: finalPoints,
          })}::jsonb,
          now()
        )
      `;
    } catch (_) {}

    const wallet = {
      coins: nextCoins,
      balance: nextCoins,
      points: nextCoins,
      exp: nextExp,
      xp: nextExp,
      tickets: nextTickets,
      gamesPlayed: curGames,
      level: curLevel,
    };
    const stats = {
      coins: nextCoins,
      balance: nextCoins,
      points: nextCoins,
      exp: nextExp,
      xp: nextExp,
      tickets: nextTickets,
      gamesPlayed: curGames,
      level: curLevel,
    };

    return withCORS(
      json(
        {
          success: true,
          userId,
          game: gameId,
          reward: { exp: finalExp, tickets: finalTickets, points: finalPoints },
          wallet,
          stats,
        },
        { headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { success: false, error: "DB Error", detail: String(e?.message || e) },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
