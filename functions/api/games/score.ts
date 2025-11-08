// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\score.ts
//
// ✅ 목표
// - 기존 기능/계약(POST /api/games/score → { ok:true }) 100% 유지
// - 문제 해결: VS Code TS 오류(ts2304 PagesFunction / ts7031 implicit any) 제거
// - 보강: 입력 정규화/범위 검증, 멱등키 지원, 인덱스, 캐시 차단 헤더, 레이트리밋 연동 그대로 유지
//
// 참고: 아래 ambient 타입은 에디터 전용 선언으로 런타임에 영향이 없습니다.

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateScore } from "../_utils/schema/games";
import * as Rate from "../_utils/rate-limit";

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ─────────
   - @cloudflare/workers-types 없이도 TS 편집기 경고 없이 개발 가능
   - 런타임 영향 없음(순수 타입 선언) */
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

// ───────── helpers ─────────
function cleanUserId(v: string): string {
  const s = (v || "").trim().normalize("NFKC");
  if (!/^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s)) {
    throw new Error("Invalid userId");
  }
  return s;
}

function cleanGame(v: string): string {
  const s = (v || "").trim().toLowerCase().normalize("NFKC");
  if (!/^[a-z0-9_\-]{1,64}$/.test(s)) {
    throw new Error("Invalid game");
  }
  return s;
}

function toSafeScore(n: any): number {
  // 정수/범위 보정: 0 ~ 2_147_483_647 (int4 상한)
  const x = Number(n);
  if (!Number.isFinite(x)) throw new Error("Invalid score");
  const i = Math.floor(x);
  if (i < 0) return 0;
  if (i > 2_147_483_647) return 2_147_483_647;
  return i;
}

// 중복 제출 방지용 멱등 키(선택)
function getIdemKey(req: Request): string | null {
  return (
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key") ||
    req.headers.get("x-idempotency-key")
  );
}

// 초기 상태에서도 안전하게 동작하도록 "테이블 없음" 감지
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // 남용 방지(토큰버킷)
  if (!(await Rate.allow(request))) {
    return withCORS(
      json({ error: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "60" } }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);
    // 원래 스키마 검증(계약 유지)
    const data = validateScore(body);

    // 추가 서버측 방어(형식/범위 보정)
    const userId = cleanUserId(data.userId);
    const game = cleanGame(data.game);
    const score = toSafeScore(data.score);

    const sql = getSql(env);

    // 스키마/인덱스 보강(존재 시 무시)
    try {
      await sql`
        create table if not exists game_scores(
          id bigserial primary key,
          user_id text not null,
          game text not null,
          score int not null,
          created_at timestamptz not null default now(),
          idempotency_key text unique
        )`;
      await sql`create index if not exists game_scores_user_created on game_scores (user_id, created_at desc)`;
      await sql`create index if not exists game_scores_game_user_score_created on game_scores (game, user_id, score desc, created_at asc)`;
    } catch (e) {
      // Neon 초기 스키마 경쟁 등 예외는 이후 로직으로 계속 진행
      if (!isMissingTable(e)) {
        // 비치명적이면 무시 — 저장 자체는 아래에서 시도
      }
    }

    // 멱등성: 키가 있으면 중복 삽입 방지
    const idem = getIdemKey(request);
    if (idem) {
      await sql`
        insert into game_scores (user_id, game, score, idempotency_key)
        values (${userId}, ${game}, ${score}, ${idem})
        on conflict (idempotency_key) do nothing
      `;
    } else {
      await sql`
        insert into game_scores (user_id, game, score)
        values (${userId}, ${game}, ${score})
      `;
    }

    return withCORS(
      json(
        { ok: true },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Score-Took-ms": String(Math.round(performance.now() - t0)),
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
