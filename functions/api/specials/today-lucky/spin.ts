// POST /api/specials/today-lucky/spin
// 티켓 5장 차감 + 랜덤 포인트 지급 + 최신 wallet/stats 반환
import { json, readJSON } from "../../../_utils/json";
import { withCORS, preflight } from "../../../_utils/cors";
import { getSql, type Env } from "../../../_utils/db";

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST")
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);

  const sql = getSql(env);
  const body = await readJSON(request);
  const userId = String((body as any)?.userId || "");
  if (!userId) return withCORS(json({ error: "unauthorized" }, { status: 401 }), env.CORS_ORIGIN);

  const rewardPoints = Math.floor(Math.random() * 50) + 10; // 10~59 포인트
  const ticketCost = 5;

  const [stats] = await sql/*sql*/`
    update user_stats
       set coins = coins + ${rewardPoints},
           tickets = greatest(tickets - ${ticketCost}, 0),
           exp = exp + ${rewardPoints},
           updated_at = now()
     where user_id = ${userId}::uuid
     returning coins, exp, tickets, games_played, level
  `;

  const wallet = {
    points: Number(stats?.coins ?? 0),
    tickets: Number(stats?.tickets ?? 0),
  };

  const snapshot = { wallet, stats };
  return withCORS(json({ ok: true, rewardPoints, ticketCost, snapshot, wallet, stats }), env.CORS_ORIGIN);
};
