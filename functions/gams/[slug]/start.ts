// functions/games/[slug]/start.ts
// POST /games/:slug/start  -> { ok:true, runId, gameSlug }

import { json } from "../../api/_utils/json";
import { withCORS, preflight } from "../../api/_utils/cors";
import { getSql, type Env } from "../../api/_utils/db";
import { requireUser } from "../../api/_utils/auth";
import * as Rate from "../../api/_utils/rate-limit";

// Minimal Cloudflare Pages ambient types (type-checker only)
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;

export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  // CORS preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // Rate-limit (optional)
  if (!(await Rate.allow(request))) {
    return withCORS(json({ error: "Too Many Requests" }, { status: 429 }), env.CORS_ORIGIN);
  }

  try {
    const user = await requireUser(request, env);
    const userId = user.userId; // UUID string

    const slug = String(params?.slug || "").trim();
    if (!slug) {
      return withCORS(json({ ok: false, error: "missing_slug" }, { status: 400 }), env.CORS_ORIGIN);
    }

    const sql = getSql(env);

    const g = await sql/* sql */`
      select id
      from games
      where slug = ${slug}
      limit 1
    `;
    if (!g[0]?.id) {
      return withCORS(json({ ok: false, error: "game_not_found" }, { status: 404 }), env.CORS_ORIGIN);
    }

    const run = await sql/* sql */`
      insert into game_runs(user_id, game_id, started_at, meta)
      values(${userId}::uuid, ${g[0].id}::uuid, now(), ${JSON.stringify({ source: "gameStart" })}::jsonb)
      returning id
    `;

    return withCORS(
      json(
        { ok: true, runId: run[0]?.id, gameSlug: slug },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  } catch (err: any) {
    return withCORS(
      json(
        { ok: false, error: String(err?.message || err) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
