// POST /api/specials/today-lucky/spin
// 티켓 5장 차감 + 랜덤 포인트 지급 + 최신 wallet/stats 반환
import { json, readJSON } from "../../_utils/json";
import { withCORS, preflight } from "../../_utils/cors";
import { getSql, type Env } from "../../_utils/db";

/**
 * ✅ 에디터/빌드 타입 에러 방지용 tiny ambient types
 * - Cloudflare Pages 프로젝트에서 PagesFunction 타입이 로컬 tsconfig에 없을 때 발생하는:
 *   ts(2304) Cannot find name 'PagesFunction'
 *   ts(7006) Parameter 'ctx' implicitly has an 'any' type
 * - 런타임 영향 없음(타입 전용)
 */
type PagesFunctionContext<E = unknown> = {
  request: Request;
  env: E;
  // middleware가 넣는 data가 있는 프로젝트도 많아서 optional로 둠
  data?: Record<string, unknown>;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
};

type PagesFunction<E = unknown> = (ctx: PagesFunctionContext<E>) => Promise<Response> | Response;

export const onRequest: PagesFunction<Env> = async (ctx: PagesFunctionContext<Env>) => {
  const { request, env } = ctx;

  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const sql = getSql(env);
  const body = await readJSON(request);

  // ✅ 정본: 미들웨어가 주입한 로그인 userId 사용
  const userId = String((ctx.data as any)?.auth || "");
  if (!userId) {
    return withCORS(json({ error: "unauthorized" }, { status: 401 }), env.CORS_ORIGIN);
  }

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
    points: Number((stats as any)?.coins ?? 0),
    tickets: Number((stats as any)?.tickets ?? 0),
  };

  const snapshot = { wallet, stats };
  return withCORS(json({ ok: true, rewardPoints, ticketCost, snapshot, wallet, stats }), env.CORS_ORIGIN);
};
