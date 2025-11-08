// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\history.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/**
 * 에디터/타입 오류 해결 메모
 * - ts(2304) PagesFunction 미정의 → 아래에 최소 ambient 타입 선언
 * - ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
 * - ts(2558) neon 템플릿에 제네릭 전달 불가 → `sql<Row[]>\`...\`` 제거
 */

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ───────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────── */

type Row = {
  game: string;
  score: number | string | bigint;
  created_at: string | Date;
};

function toNumberSafe(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function cleanUserId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().normalize("NFKC");
  if (!s) return null;
  // 보수적 허용 문자 집합(기존 계약 유지)
  return /^[a-zA-Z0-9_\-.:@]+$/.test(s) && s.length <= 64 ? s : null;
}

function isoOrNull(s: string | null): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);

    // ── 필수 파라미터: userId ──────────────────────────────────────────
    const userId = cleanUserId(url.searchParams.get("userId"));
    if (!userId) {
      return withCORS(json({ error: "userId is required" }, { status: 400 }), env.CORS_ORIGIN);
    }

    // ── 선택 파라미터(기본 동작: 최신 200건) ───────────────────────────
    const gameFilter = (url.searchParams.get("game") || "").trim() || null;
    const limitRaw = url.searchParams.get("limit");
    const limit = Math.max(1, Math.min(500, limitRaw ? Number(limitRaw) : 200));

    // 기간 필터(옵션): since ≤ created_at < to
    const since = isoOrNull(url.searchParams.get("since"));
    const to = isoOrNull(url.searchParams.get("to"));

    // Seek 페이지네이션(옵션): created_before (ISO)
    const createdBefore = isoOrNull(url.searchParams.get("created_before"));

    const sql = getSql(env);

    let rows: Row[] = [];
    try {
      // ⚠️ neon 템플릿에는 제네릭을 전달하지 않습니다.
      const res = await sql`
        select game, score, created_at
        from game_scores
        where user_id = ${userId}
          ${gameFilter ? sql`and game = ${gameFilter}` : sql``}
          ${since ? sql`and created_at >= ${since}` : sql``}
          ${to ? sql`and created_at < ${to}` : sql``}
          ${createdBefore ? sql`and created_at < ${createdBefore}` : sql``}
        order by created_at desc
        limit ${limit}
      `;
      rows = res as Row[];
    } catch (e) {
      // 초기 배포 등으로 테이블이 없을 때는 빈 결과 반환(계약 유지)
      if (!isMissingTable(e)) throw e;
      rows = [];
    }

    // 타입 정규화: score → number, created_at → string(ISO)
    const safe = rows.map((r) => ({
      game: r.game,
      score: toNumberSafe(r.score),
      created_at:
        typeof r.created_at === "string"
          ? r.created_at
          : new Date(r.created_at).toISOString(),
    }));

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true, rows: safe },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-History-Limit": String(limit),
            "X-History-Took-ms": String(took),
          },
        }
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
