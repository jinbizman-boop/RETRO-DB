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

// tiny ambient types (에디터/빌드 타입 보호)
type PagesFunctionContext<E = unknown> = {
  request: Request;
  env: E;
  params: Record<string, string>;
  data?: Record<string, unknown>;
  waitUntil(promise: Promise<any>): void;
  next(): Promise<Response>;
};
type PagesFunction<E = unknown> = (
  ctx: PagesFunctionContext<E>
) => Promise<Response> | Response;

function toInt(v: any, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

async function sha256Hex(input: string) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;

  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ success: false, error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const sql = getSql(env);

  try {
    const body = await readJSON(request);

    const userId = String((body as any)?.userId || "");
    const gameId = String((body as any)?.gameId || "");
    const exp = toInt((body as any)?.exp, 0);
    const tickets = toInt((body as any)?.tickets, 0);
    const points = toInt((body as any)?.points, 0);

    const hash = String((body as any)?.hash || "");
    const secret = env.REWARD_SECRET_KEY || env.JWT_SECRET || "";


    if (!userId || !gameId) {
      return withCORS(json({ success: false, error: "bad_request" }, { status: 400 }), env.CORS_ORIGIN);
    }

    // ✅ app.js 규칙과 동일한 raw 구성
    const raw = `${userId}|${gameId}|${exp}|${tickets}|${points}|${secret}`;
    const expected = await sha256Hex(raw);

    if (!hash || hash !== expected) {
      return withCORS(json({ success: false, error: "invalid_hash" }, { status: 403 }), env.CORS_ORIGIN);
    }

    // ✅ idempotency (중복 지급 방지)
    const idemKey = `reward:${userId}:${gameId}:${hash}`;

    // transactions 에 적립 (trigger가 user_stats 갱신)
    // - coins: amount
    // - exp: exp_delta
    // - tickets: tickets_delta
    const [tx] = await sql/*sql*/`
      insert into transactions (user_id, type, amount, exp_delta, tickets_delta, reason, meta, idempotency_key)
      values (
        ${userId}::uuid,
        'earn',
        ${points},
        ${exp},
        ${tickets},
        'game_reward',
        ${JSON.stringify({ gameId, exp, tickets, points })}::jsonb,
        ${idemKey}
      )
      on conflict (user_id, idempotency_key) do update
        set meta = excluded.meta
      returning id, balance_after
    `;

    const [stats] = await sql/*sql*/`
      select coins, exp, tickets, games_played, level
      from user_stats
      where user_id = ${userId}::uuid
      limit 1
    `;

    const wallet = {
      points: Number((stats as any)?.coins ?? 0),
      tickets: Number((stats as any)?.tickets ?? 0),
      exp: Number((stats as any)?.exp ?? 0),
      plays: Number((stats as any)?.games_played ?? 0),
      level: Number((stats as any)?.level ?? 1),
    };

    return withCORS(
      json({
        success: true,
        userId,
        game: { id: gameId },
        reward: { exp, tickets, points },
        tx,
        wallet,
        stats,
        snapshot: { wallet, stats },
      }),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json({ success: false, error: String(e?.message || e) }, { status: 400 }),
      env.CORS_ORIGIN
    );
  }
};
