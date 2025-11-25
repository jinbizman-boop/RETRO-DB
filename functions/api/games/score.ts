// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\score.ts
//
// ✅ 목표
// - 기존 기능/계약(POST /api/games/score → { ok:true }) 100% 유지
// - VS Code TS 오류(ts2304 PagesFunction / ts7031 implicit any) 제거
// - 입력 정규화/범위 검증, 멱등키 지원, 인덱스, 캐시 차단 헤더, 레이트리밋 연동 유지
// - 🔥 강화: 새 DB 스키마와 완전 정합
//   • migrations/game_runs.sql 의 game_runs 테이블에 정식 런 기록 저장
//   • games(slug)와 연결 (존재 안 하면 안전한 upsert)
//   • migrations/001_init.sql 의 transactions + apply_wallet_transaction 트리거와 연동
//     → 게임 점수에 따라 coins/exp/games_played 자동 갱신 (user_stats)
//   • userId 는 우선 X-User-Id 헤더(미들웨어) → body.userId 순으로 사용
//   • 모든 강화는 “추가 동작”일 뿐, 기존 응답 계약/형식은 변경 없음

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateScore } from "../_utils/schema/games";
import * as Rate from "../_utils/rate-limit";

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

/* ───────── helpers: user/game/score 정규화 ───────── */

// userId 우선순위: X-User-Id 헤더(미들웨어) → body.userId
// UUID 기반 users.id 와 정합되도록 엄격히 제한
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveUserId(req: Request, bodyUserId: unknown): string {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";
  const candidate = (headerId || String(bodyUserId ?? "")).trim().normalize("NFKC");
  if (!candidate) throw new Error("Missing userId");
  if (!UUID_V4_REGEX.test(candidate)) {
    // 지금 스키마는 UUID users.id 기준으로 동작하므로 uuid 강제
    throw new Error("Invalid userId");
  }
  return candidate;
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
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table")
  );
}

// 클라이언트 메타데이터 (ip/ua) — game_runs.metadata / transactions.meta 에 기록
function getClientMeta(req: Request) {
  const headers = req.headers;
  const ip =
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    null;
  const ua = headers.get("user-agent") || null;
  return { ip, ua };
}

// 점수 → 보상 변환 (간단 정책)
// - exp: score / 10
// - coins: score / 50 (최대 5000)
// - tickets: 매우 큰 점수에만 보너스 1장
function computeRewards(score: number): {
  coinsDelta: number;
  expDelta: number;
  ticketsDelta: number;
} {
  const expDelta = Math.max(1, Math.floor(score / 10));
  let coinsDelta = Math.max(0, Math.floor(score / 50));
  if (coinsDelta > 5000) coinsDelta = 5000;

  const ticketsDelta = score >= 100000 ? 1 : 0;

  return { coinsDelta, expDelta, ticketsDelta };
}

/* ───────── Handler ───────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 남용 방지(토큰버킷)
  if (!(await Rate.allow(request))) {
    return withCORS(
      json(
        { error: "Too Many Requests" },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);
    // 원래 스키마 검증(계약 유지)
    const data = validateScore(body);

    // 추가 서버측 방어(형식/범위 보정)
    const userId = resolveUserId(request, (data as any).userId);
    const gameSlug = cleanGame((data as any).game);
    const score = toSafeScore((data as any).score);
    const idem = getIdemKey(request);
    const { ip, ua } = getClientMeta(request);

    const sql = getSql(env);

    // ─────────────────────────────────────────────────────────────
    // 1) 기존 game_scores 테이블 (과거 코드와 완전 호환용)
    //    - 기존 기능/페이지들이 game_scores 를 보고 있다면 그대로 유지
    // ─────────────────────────────────────────────────────────────
    try {
      await sql/* sql */ `
        create table if not exists game_scores(
          id bigserial primary key,
          user_id text not null,
          game text not null,
          score int not null,
          created_at timestamptz not null default now(),
          idempotency_key text unique
        )
      `;
      await sql/* sql */ `
        create index if not exists game_scores_user_created
        on game_scores (user_id, created_at desc)
      `;
      await sql/* sql */ `
        create index if not exists game_scores_game_user_score_created
        on game_scores (game, user_id, score desc, created_at asc)
      `;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 스키마 경쟁 등 비치명적이면 무시 — 아래 canonical 경로는 계속 진행
      }
    }

    try {
      if (idem) {
        await sql/* sql */ `
          insert into game_scores (user_id, game, score, idempotency_key)
          values (${userId}, ${gameSlug}, ${score}, ${idem})
          on conflict (idempotency_key) do nothing
        `;
      } else {
        await sql/* sql */ `
          insert into game_scores (user_id, game, score)
          values (${userId}, ${gameSlug}, ${score})
        `;
      }
    } catch (e) {
      if (!isMissingTable(e)) {
        // game_scores 삽입 실패도 전체 API 실패로 만들지 않고 무시
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 2) 새 스키마 기반 canonical 경로
    //    - games(slug) / game_runs / transactions / user_stats 연계
    // ─────────────────────────────────────────────────────────────
    try {
      // 2-1) games(slug) upsert
      let gameId: string | null = null;
      try {
        const rows = await sql/* sql */ `
          select id from games where slug = ${gameSlug} limit 1
        `;
        if (rows && rows.length > 0) {
          gameId = String(rows[0].id);
        }
      } catch (e) {
        if (!isMissingTable(e)) throw e;
      }

      if (!gameId) {
        try {
          const title = gameSlug.replace(/[-_]/g, " ").toUpperCase();
          const rows = await sql/* sql */ `
            insert into games (slug, title, category)
            values (${gameSlug}, ${title}, 'arcade')
            on conflict (slug) do update set title = excluded.title
            returning id
          `;
          gameId = String(rows[0].id);
        } catch (e) {
          if (!isMissingTable(e)) throw e;
        }
      }

      // game_runs / transactions 가 존재하지 않으면 여기서 더 진행하지 않음
      if (!gameId) {
        // games 테이블이 없으면 canonical path 를 건너뜀
        // (기존 game_scores 는 이미 기록됨)
      } else {
        // 2-2) game_runs 에 플레이 기록 저장
        let runId: string | null = null;
        const runMetadata = {
          ip,
          ua,
          game: gameSlug,
          score,
          source: "api/games/score",
        };

        try {
          const rows = await sql/* sql */ `
            insert into game_runs (user_id, game_id, score, metadata)
            values (${userId}::uuid, ${gameId}::uuid, ${score}, ${JSON.stringify(
              runMetadata
            )}::jsonb)
            returning id
          `;
          if (rows && rows.length > 0) {
            runId = String(rows[0].id);
          }
        } catch (e) {
          if (!isMissingTable(e)) throw e;
        }

        // 2-3) wallet C안: transactions 에 기록 → trigger 로 user_stats 갱신
        try {
          const { coinsDelta, expDelta, ticketsDelta } = computeRewards(score);

          if (coinsDelta !== 0 || expDelta !== 0 || ticketsDelta !== 0) {
            const txPayload = {
              score,
              game: gameSlug,
              run_id: runId,
              ip,
              ua,
            };

            if (idem) {
              await sql/* sql */ `
                insert into transactions (
                  user_id,
                  type,
                  amount,
                  exp_delta,
                  tickets_delta,
                  plays_delta,
                  reason,
                  game,
                  ref_table,
                  ref_id,
                  idempotency_key,
                  meta
                )
                values (
                  ${userId}::uuid,
                  'game',
                  ${coinsDelta},
                  ${expDelta},
                  ${ticketsDelta},
                  1,
                  'game_score',
                  ${gameSlug},
                  ${runId ? "game_runs" : null},
                  ${runId ? `${runId}::uuid` : null},
                  ${idem},
                  ${JSON.stringify(txPayload)}::jsonb
                )
                on conflict (idempotency_key) do nothing
              `;
            } else {
              await sql/* sql */ `
                insert into transactions (
                  user_id,
                  type,
                  amount,
                  exp_delta,
                  tickets_delta,
                  plays_delta,
                  reason,
                  game,
                  ref_table,
                  ref_id,
                  meta
                )
                values (
                  ${userId}::uuid,
                  'game',
                  ${coinsDelta},
                  ${expDelta},
                  ${ticketsDelta},
                  1,
                  'game_score',
                  ${gameSlug},
                  ${runId ? "game_runs" : null},
                  ${runId ? `${runId}::uuid` : null},
                  ${JSON.stringify(txPayload)}::jsonb
                )
              `;
            }
            // apply_wallet_transaction 트리거가 user_stats(coins/exp/tickets/games_played)를 자동 갱신
          }
        } catch (e) {
          if (!isMissingTable(e)) {
            // transactions 스키마 문제는 게임 기록 자체를 실패시키지 않는다
          }
        }
      }
    } catch {
      // canonical 경로 전체 실패는 조용히 무시 (기존 계약 유지)
    }

    // ─────────────────────────────────────────────────────────────
    // 응답: 기존과 동일하게 { ok: true } + 헤더만 추가
    // ─────────────────────────────────────────────────────────────
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
