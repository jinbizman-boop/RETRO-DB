// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\analytics\event.ts
//
// Retro Games – Analytics Event API (game_start / game_end / 기타 추적용)
// ────────────────────────────────────────────────────────────────
// ✅ 외부 계약
//   • 라우트: POST /api/analytics/event
//   • 요청 JSON 예시:
//       {
//         "game": "2048",
//         "type": "game_start",
//         "meta": {
//           "difficulty": "normal",
//           "seed": 1234
//         }
//       }
//   • 응답: { ok: true }
//
// ✅ 역할
//   • 게임 시작/종료, 기타 사용자 행동을 analytics_events 테이블에 기록
//   • reward.ts / transaction.ts 와 같은 analytics_events 스키마 공유
//   • requireUser 로 로그인 유저 식별 (user_id = users.id UUID)
//   • game_id / event_type / meta_json 을 안전하게 정규화 후 저장
//
// ✅ 특징 / 강화 포인트
//   • Cloudflare Pages Functions 형식 유지 (PagesFunction<Env>)
//   • CORS / preflight 연동 (withCORS, preflight)
//   • 토큰 버킷 레이트리밋(*_utils/rate-limit) 적용
//   • 테이블 미존재 시 create table if not exists 로 자동 보완
//   • 메타(meta_json)는 순수 JSON만 허용, 순환/함수 등은 제거
//   • 운영 헤더: Cache-Control: no-store, X-Analytics-Took-ms, X-Analytics-User
//   • event_type/game_id 길이 & 문자 제한으로 DB 오염 방지
//
// ⚠️ 주의
//   • 이 API는 “로그 기록용”이므로, 실패해도 게임 진행에는 영향이 없어야 한다.
//   • 프론트에서는 결과를 강하게 의존하지 않고 fire-and-forget 스타일로 쓰는 것을 권장.

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
import * as Rate from "../_utils/rate-limit";

/* ───────── 타입 정의 ───────── */

type AnalyticsEventRow = {
  id?: string;
};

type SqlClient = ReturnType<typeof getSql>;

/* ───────── helpers: 문자열/JSON 정규화 ───────── */

/**
 * 문자열 안전 정규화
 * - trim + NFKC
 */
function normalizeStr(v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v.trim();
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore
  }
  return s;
}

/**
 * event_type 정규화
 * - 소문자
 * - 공백 → 언더스코어
 * - 영문/숫자/언더스코어만 허용
 * - 최대 64자 제한
 *
 * 예) "Game Start" → "game_start"
 */
function cleanEventType(v: unknown): string | null {
  let s = normalizeStr(v).toLowerCase();
  if (!s) return null;
  s = s.replace(/\s+/g, "_");
  s = s.replace(/[^a-z0-9_]/g, "");
  if (!s) return null;
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

/**
 * game_id 정규화
 * - 소문자
 * - 공백 제거
 * - 영문/숫자/언더스코어만 허용
 * - 최대 64자 제한
 *
 * 예) "Tetris Classic" → "tetrisclassic"
 */
function cleanGameId(v: unknown): string | null {
  let s = normalizeStr(v).toLowerCase();
  if (!s) return null;
  s = s.replace(/\s+/g, "");
  s = s.replace(/[^a-z0-9_]/g, "");
  if (!s) return null;
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

/**
 * meta JSONB 보정
 * - 순수 JSON만 허용
 * - 순환참조/함수 등 있으면 빈 객체로 대체
 * - 숫자/문자/불리언/배열/객체만 허용
 */
function sanitizeMeta(meta: any): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  try {
    JSON.stringify(meta);
    return meta as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * relation / table 미존재 여부 감지
 */
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

/**
 * 클라이언트 메타: ip / user-agent
 */
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

/* ───────── 테이블 준비 ───────── */

/**
 * analytics_events 테이블이 없을 경우를 대비한 스키마 보강
 * reward.ts / transaction.ts 에서 사용하는 것과 동일한 구조 유지
 */
async function ensureAnalyticsSchema(sql: SqlClient): Promise<void> {
  try {
    await sql/* sql */ `
      create table if not exists analytics_events (
        id         uuid primary key default gen_random_uuid(),
        user_id    text,
        game_id    text,
        event_type text not null,
        meta_json  jsonb,
        created_at timestamptz default now()
      )
    `;
    await sql/* sql */ `
      create index if not exists analytics_events_user_idx
      on analytics_events (user_id)
    `;
    await sql/* sql */ `
      create index if not exists analytics_events_game_idx
      on analytics_events (game_id)
    `;
    await sql/* sql */ `
      create index if not exists analytics_events_type_idx
      on analytics_events (event_type)
    `;
  } catch (e) {
    // 스키마 생성 실패는 상위에서 처리
    if (!isMissingTable(e)) {
      throw e;
    }
  }
}

/* ───────── handler ───────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // CORS preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  // POST 이외는 허용하지 않음
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 토큰 버킷 레이트리밋
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
    // 1) 사용자 인증 (로그인 필수)
    const payload = await requireUser(request, env);
    const userId = String(payload.sub || "").trim();
    if (!userId) {
      return withCORS(
        json({ error: "Unauthorized" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    const sql = getSql(env);

    // 2) 요청 바디 파싱
    let body: any;
    try {
      body = await request.json();
    } catch {
      return withCORS(
        json({ error: "Invalid JSON body" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    const type = cleanEventType(body.type);
    if (!type) {
      return withCORS(
        json({ error: "Missing or invalid event type" }, { status: 400 }),
        env.CORS_ORIGIN
      );
    }

    const gameId = cleanGameId(body.game ?? body.gameId ?? "");
    const clientMeta = getClientMeta(request);
    const metaUser = sanitizeMeta(body.meta || {});

    const metaCombined = {
      ...metaUser,
      ip: clientMeta.ip,
      ua: clientMeta.ua,
      source: "api/analytics/event",
      env: {
        nodeEnv: (env as any).NODE_ENV ?? undefined,
        runtime: "cloudflare-pages",
      },
    };

    // 3) 테이블 준비
    await ensureAnalyticsSchema(sql);

    // 4) insert
    try {
      await sql/* sql */ `
        insert into analytics_events(
          user_id,
          game_id,
          event_type,
          meta_json
        )
        values(
          ${userId},
          ${gameId || null},
          ${type},
          ${JSON.stringify(metaCombined)}::jsonb
        )
      ` as AnalyticsEventRow[];
    } catch (e) {
      // 스키마가 아예 없는 경우에 대한 추가 방어
      if (isMissingTable(e)) {
        return withCORS(
          json(
            {
              error:
                "Analytics schema is not initialized. Run DB migrations for analytics_events.",
            },
            { status: 400, headers: { "Cache-Control": "no-store" } }
          ),
          env.CORS_ORIGIN
        );
      }
      throw e;
    }

    const tookMs = Math.round(performance.now() - t0);

    // 5) 응답 헤더
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Analytics-Took-ms": String(tookMs),
      "X-Analytics-User": userId,
      "X-Analytics-Event-Type": type,
    };
    if (gameId) headers["X-Analytics-Game"] = gameId;

    return withCORS(
      json(
        {
          ok: true,
        },
        { headers }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    // 인증/기타 오류
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};

/* ───────────────────────────────────────────────────────────────────────────────
 * 내부 메모 / 유지보수 가이드 (실행에는 영향 없음)
 *
 * 1. 이 엔드포인트가 하는 일
 *    - requireUser 로 로그인한 사용자를 식별(userId = users.id UUID).
 *    - 프론트/게임 코드가 보내는 { game, type, meta } 를 받아서
 *      analytics_events 테이블에 한 줄씩 insert 한다.
 *    - event_type, game_id, meta_json 을 정규화해 DB 오염을 방지한다.
 *
 * 2. type / game 필드 정책
 *    - type:
 *      • 소문자, 영문/숫자/언더스코어만 허용, 최대 64자.
 *      • 권장 값 예시:
 *          - game_start
 *          - game_end
 *          - reward
 *          - wallet_tx
 *          - level_up
 *    - game:
 *      • 공백 제거, 영문/숫자/언더스코어, 최대 64자.
 *      • 예시:
 *          - "2048"
 *          - "tetris"
 *          - "brick_breaker"
 *          - "dino"
 *
 * 3. 프론트에서의 사용 예
 *    - 게임 시작 시:
 *        trackGameEvent("game_start", "2048", {
 *          difficulty: "normal",
 *          seed: 1234
 *        });
 *
 *    - 게임 종료 시:
 *        trackGameEvent("game_end", "2048", {
 *          score: finalScore,
 *          playTimeMs: elapsed,
 *          result: "gameover"
 *        });
 *
 *    - 이때 trackGameEvent 유틸은
 *        fetch("/api/analytics/event", { method: "POST", body: JSON... })
 *      를 래핑하는 단순 함수.
 *
 * 4. reward.ts / transaction.ts 와의 관계
 *    - reward.ts 내부에서 logAnalyticsEvent("reward", ...) 같은 기능을 사용하면
 *      보상 지급 내역도 analytics_events 에 기록할 수 있다.
 *    - transaction.ts에서 wallet_tx 이벤트를 남기는 것도 동일 스키마를 사용.
 *    - game_start / game_end / reward / wallet_tx를 한 테이블에서 모으면
 *      “한 판 플레이의 전체 라이프사이클”을 재구성하기가 쉬워진다.
 *
 * 5. 장애/성능 고려
 *    - analytics_events 는 로그 테이블 성격이 강하므로
 *      • 파티셔닝(월별/분기별) 또는
 *      • 주기적인 아카이빙/삭제 정책을 함께 설계하는 것이 좋다.
 *    - 이 API는 게임 경험을 방해하지 않도록
 *      • 프론트에서는 fire-and-forget 스타일로 사용하고
 *      • 실패하더라도 게임 로직이 깨지지 않게 설계해야 한다.
 *
 * 6. 확장 아이디어
 *    - event_type 별로 meta_json 에 공통 필드를 정해두면
 *      • BI/리포트 도구에서 쿼리하는데 도움이 된다.
 *    - 예:
 *      • game_start:
 *          - { difficulty, seed, deviceType, screenSize }
 *      • game_end:
 *          - { score, playTimeMs, maxTile, result }
 *      • reward:
 *          - { game, score, exp, tickets, points }
 *      • wallet_tx:
 *          - { amount, reason, game, balanceAfter }
 *
 * ─────────────────────────────────────────────────────────────────────────── */
