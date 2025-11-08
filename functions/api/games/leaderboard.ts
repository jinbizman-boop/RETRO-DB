// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\leaderboard.ts
//
// ✅ 목표
// - 기존 기능/규격/응답 계약은 그대로 유지하면서 TS 편집기 오류를 모두 제거
// - Cloudflare Pages 타입 미정의(ts2304) / 암시적 any(ts7031) / neon 제네릭 오류(ts2558) 해결
//
// 핵심 변경점
// 1) 최소 ambient 타입으로 PagesFunction 정의(에디터 전용, 런타임 영향 없음)
// 2) 핸들러 인자(request/env) 타입을 명시
// 3) neon 템플릿에 제네릭 전달을 제거하고 결과를 안전 캐스팅
// 4) 나머지 로직/응답 스키마/쿼리 동작은 원본과 동일 유지

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ─────────
   - 프로젝트에 @cloudflare/workers-types 가 없어도 VS Code 경고 없이 개발 가능
   - 런타임에는 영향 없음(순수 타입 선언) */
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

type Row = { user_id: string; top_score: number | string | bigint };

// bigint | string → number 안전 변환
function toNumberSafe(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// 게임 키 정리: 영소문자/숫자/_- 1~64자
function cleanGame(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().normalize("NFKC");
  return /^[a-z0-9_\-]{1,64}$/.test(s) ? s : null;
}

// ISO 날짜 문자열 검증(유효하지 않으면 null)
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

// 초기 배포 등 테이블 미존재 감지
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

    // ── 파라미터(기본 동작: 기존과 동일) ─────────────────────────────────
    const gameParam = cleanGame(url.searchParams.get("game")) ?? "2048";

    // limit: 1~200, 기본 50
    const limitRaw = url.searchParams.get("limit");
    const parsed = Number(limitRaw);
    const limit = Math.max(
      1,
      Math.min(200, Number.isFinite(parsed) ? parseInt(String(parsed), 10) : 50)
    );

    // 선택 기간 필터(없으면 전체): since ≤ created_at < to
    const since = isoOrNull(url.searchParams.get("since"));
    const to = isoOrNull(url.searchParams.get("to"));

    const sql = getSql(env);

    // 인덱스 보강(존재하면 무시) — 상위 점수 집계/정렬 최적화
    await sql`
      create index if not exists game_scores_game_user_score_created
      on game_scores (game, user_id, score desc, created_at asc)
    `;

    // 각 user_id별 최고 점수만 추출 → 점수 내림차순 정렬
    // 동점이면 created_at 이른 기록이 우선 (tie-breaker)
    // ⚠️ neon 템플릿에는 제네릭을 전달하지 않습니다(ts2558 방지).
    let rows: Row[] = [];
    try {
      const res = await sql`
        with ranked as (
          select
            user_id,
            score::bigint as score,
            created_at,
            row_number() over (partition by user_id order by score desc, created_at asc) as rn
          from game_scores
          where game = ${gameParam}
            ${since ? sql`and created_at >= ${since}` : sql``}
            ${to ? sql`and created_at < ${to}` : sql``}
        )
        select user_id, score as top_score
        from ranked
        where rn = 1
        order by top_score desc, user_id asc
        limit ${limit}
      `;
      rows = res as Row[];
    } catch (e) {
      // 초기 배포 등 테이블 미존재 시: 기존 계약 유지하며 빈 결과
      if (!isMissingTable(e)) throw e;
      rows = [];
    }

    // bigint → number 정규화
    const safe = rows.map((r) => ({
      user_id: r.user_id,
      top_score: toNumberSafe(r.top_score),
    }));

    const took = Math.round(performance.now() - t0);

    // 기존 응답 계약 유지: { ok: true, game, rows }
    return withCORS(
      json(
        { ok: true, game: gameParam, rows: safe },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Leaderboard-Game": gameParam,
            "X-Leaderboard-Limit": String(limit),
            "X-Leaderboard-Took-ms": String(took),
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
