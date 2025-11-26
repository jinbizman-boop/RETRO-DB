// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\score.ts
//
// ✅ 목표
// - 기존 기능/계약(POST /api/games/score → { ok:true }) 100% 유지
// - VS Code TS 오류(ts2304 PagesFunction / ts7031 implicit any) 제거
// - 입력 정규화/범위 검증, 멱등키 지원, 인덱스, 캐시 차단 헤더, 레이트리밋 연동 유지
// - 🔥 강화(지금까지 설계한 내용 전부 반영):
//   • _utils/schema/games.ts 의 확장된 validateScore( difficulty/mode/playTime 등 ) 활용
//   • migrations/game_runs.sql 의 game_runs 스키마에 맞춰 런 기록 저장
//   • migrations/003_shop_effects.sql 의 user_effects( coins/xp multiplier ) 적용
//   • migrations/001_init.sql + 006_wallet_inventory_bridge.sql 의 transactions 경로 사용
//     → apply_wallet_transaction 트리거를 통해 user_stats / wallet 계정에 코인/경험치/티켓 반영
//   • userId 는 X-User-Id 헤더(우선) → body.userId 순으로 사용 (UUID v4 강제)
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

// UUID 기반 users.id 와 정합되도록 엄격히 제한
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// game_runs.sql 의 slug 체크와 동일(소문자 시작, 숫자/언더스코어/하이픈 1~64자)
const GAME_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// userId 우선순위: X-User-Id 헤더(미들웨어) → body.userId
function resolveUserId(req: Request, bodyUserId: unknown): string {
  const headerId =
    req.headers.get("X-User-Id") ||
    req.headers.get("x-user-id") ||
    "";

  const candidate = (headerId || String(bodyUserId ?? "")).trim();
  let normalized = candidate;
  try {
    normalized = normalized.normalize("NFKC");
  } catch {
    // ignore
  }

  if (!normalized) throw new Error("Missing userId");
  if (!UUID_V4_REGEX.test(normalized)) {
    // 지금 스키마는 UUID users.id 기준으로 동작하므로 uuid 강제
    throw new Error("Invalid userId");
  }
  return normalized;
}

function cleanGameSlug(v: string): string {
  let s = (v || "").trim().toLowerCase();
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore
  }
  if (!GAME_SLUG_REGEX.test(s)) {
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

/* ───────── 점수 → 기본 보상 계산 ───────── */

type Difficulty = "easy" | "normal" | "hard" | "extreme" | null;

function difficultyMultiplier(diff: Difficulty): number {
  switch (diff) {
    case "easy":
      return 0.8;
    case "normal":
      return 1.0;
    case "hard":
      return 1.2;
    case "extreme":
      return 1.5;
    default:
      return 1.0;
  }
}

// 점수 → 코인/경험치/티켓 기본 값
function computeBaseRewards(score: number, diff: Difficulty): {
  baseCoins: number;
  baseExp: number;
  baseTickets: number;
} {
  const s = Math.max(0, score);
  const mul = difficultyMultiplier(diff);

  // 아주 단순한 정책(서비스에 맞게 이후 조정 가능)
  let exp = Math.max(1, Math.floor((s / 10) * mul));
  let coins = Math.max(0, Math.floor((s / 50) * mul));
  let tickets = s >= 100_000 ? 1 : 0;

  // 안전 상한 (BIGINT/UX용)
  if (exp > 9_000_000_000) exp = 9_000_000_000;
  if (coins > 9_000_000_000) coins = 9_000_000_000;

  return {
    baseCoins: coins,
    baseExp: exp,
    baseTickets: tickets,
  };
}

/* ───────── user_effects(버프) 적용 ───────── */

// 003_shop_effects.sql 에 정의된 효과 키 예시:
//  - 'coins_multiplier' : 코인 x2, x3 ...
//  - 'xp_multiplier'    : 경험치 x2 ...
//  - (필요하면 'tickets_multiplier' 같은 키도 확장 가능)

type EffectRow = {
  effect_key: string;
  value: any;
};

async function loadActiveEffects(
  sql: ReturnType<typeof getSql>,
  userId: string
): Promise<EffectRow[]> {
  try {
    const rows = await sql/* sql */ `
      select effect_key, value
      from user_effects
      where user_id = ${userId}::uuid
        and (expires_at is null or expires_at > now())
    `;
    return rows as EffectRow[];
  } catch (e) {
    if (isMissingTable(e)) {
      // user_effects 테이블이 아직 없거나 미적용 → 조용히 기본 보상만 사용
      return [];
    }
    // 기타 에러도 게임 진행 자체를 막지 않도록 여기서는 empty 로 처리
    return [];
  }
}

function applyEffectMultipliers(
  base: { baseCoins: number; baseExp: number; baseTickets: number },
  effects: EffectRow[]
): {
  coinsDelta: number;
  expDelta: number;
  ticketsDelta: number;
  snapshot: {
    coinsMultiplier: number;
    xpMultiplier: number;
    ticketsMultiplier: number;
    appliedKeys: string[];
  };
} {
  if (!effects.length) {
    return {
      coinsDelta: base.baseCoins,
      expDelta: base.baseExp,
      ticketsDelta: base.baseTickets,
      snapshot: {
        coinsMultiplier: 1,
        xpMultiplier: 1,
        ticketsMultiplier: 1,
        appliedKeys: [],
      },
    };
  }

  let coinsMul = 1;
  let xpMul = 1;
  let ticketsMul = 1;
  const keys: string[] = [];

  for (const row of effects) {
    const key = String(row.effect_key || "").trim();
    const vRaw = Number(row.value);
    if (!Number.isFinite(vRaw)) continue;
    const v = Math.max(0, Math.min(vRaw, 10)); // 최소 0, 최대 10배 정도로 클램프

    if (key === "coins_multiplier") {
      coinsMul *= v;
      keys.push(key);
    } else if (key === "xp_multiplier") {
      xpMul *= v;
      keys.push(key);
    } else if (key === "tickets_multiplier") {
      ticketsMul *= v;
      keys.push(key);
    }
  }

  // 곱셈이 0이나 비정상으로 가는것 방지
  if (!Number.isFinite(coinsMul) || coinsMul <= 0) coinsMul = 1;
  if (!Number.isFinite(xpMul) || xpMul <= 0) xpMul = 1;
  if (!Number.isFinite(ticketsMul) || ticketsMul <= 0) ticketsMul = 1;

  let coins = Math.round(base.baseCoins * coinsMul);
  let exp = Math.round(base.baseExp * xpMul);
  let tickets = Math.round(base.baseTickets * ticketsMul);

  // 안전 상한
  if (coins > 9_000_000_000) coins = 9_000_000_000;
  if (exp > 9_000_000_000) exp = 9_000_000_000;
  if (tickets > 10_000) tickets = 10_000;

  return {
    coinsDelta: coins,
    expDelta: exp,
    ticketsDelta: tickets,
    snapshot: {
      coinsMultiplier: coinsMul,
      xpMultiplier: xpMul,
      ticketsMultiplier: ticketsMul,
      appliedKeys: keys,
    },
  };
}

async function computeRewardsWithEffects(
  sql: ReturnType<typeof getSql>,
  userId: string,
  score: number,
  difficulty: Difficulty
): Promise<{
  coinsDelta: number;
  expDelta: number;
  ticketsDelta: number;
  snapshot: {
    baseCoins: number;
    baseExp: number;
    baseTickets: number;
    coinsMultiplier: number;
    xpMultiplier: number;
    ticketsMultiplier: number;
    appliedKeys: string[];
  };
}> {
  const base = computeBaseRewards(score, difficulty);
  const effects = await loadActiveEffects(sql, userId);
  const applied = applyEffectMultipliers(base, effects);

  return {
    coinsDelta: applied.coinsDelta,
    expDelta: applied.expDelta,
    ticketsDelta: applied.ticketsDelta,
    snapshot: {
      baseCoins: base.baseCoins,
      baseExp: base.baseExp,
      baseTickets: base.baseTickets,
      coinsMultiplier: applied.snapshot.coinsMultiplier,
      xpMultiplier: applied.snapshot.xpMultiplier,
      ticketsMultiplier: applied.snapshot.ticketsMultiplier,
      appliedKeys: applied.snapshot.appliedKeys,
    },
  };
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

    // ──────────────────────────────────────────────────────────
    // 1) 입력 검증/정규화 (schema/games.ts 확장 버전)
    // ──────────────────────────────────────────────────────────
    const validated = validateScore(body);
    const {
      userId: bodyUserId,
      game,
      slug,
      score: rawScore,
      difficulty,
      mode,
      playTimeMs,
      deviceHint,
      startedAt,
      finishedAt,
      raw,
    } = validated as any;

    // 서버 쪽에서 최종 userId/slug/score 강제 정규화
    const userId = resolveUserId(request, bodyUserId);
    const gameSlug = cleanGameSlug(slug || game);
    const score = toSafeScore(rawScore);

    const idem = getIdemKey(request);
    const { ip, ua } = getClientMeta(request);
    const sql = getSql(env);

    // ──────────────────────────────────────────────────────────
    // 2) 기존 game_scores 테이블 (구 레거시 호환용)
    //    - 기존 페이지/랭킹이 game_scores 를 참고한다면 계속 동작
    // ──────────────────────────────────────────────────────────
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
        // 스키마 경쟁 등 비치명 오류 → canonical 경로는 계속 진행
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

    // ──────────────────────────────────────────────────────────
    // 3) 새 canonical 경로
    //    - game_runs + games + transactions + user_effects
    // ──────────────────────────────────────────────────────────
    try {
      // 3-1) games(slug) upsert (있으면 재활용)
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

      // 3-2) game_runs 에 플레이 기록 저장
      let runId: string | null = null;
      const started =
        startedAt instanceof Date
          ? startedAt
          : startedAt
          ? new Date(startedAt)
          : new Date();
      const finished =
        finishedAt instanceof Date
          ? finishedAt
          : finishedAt
          ? new Date(finishedAt)
          : null;

      const runMetadata = {
        // validateScore 확장 필드
        difficulty,
        mode,
        playTimeMs,
        deviceHint,
        // 기타 컨텍스트
        game: gameSlug,
        score,
        ip,
        ua,
        startedAt: started.toISOString(),
        finishedAt: finished ? finished.toISOString() : null,
        source: "api/games/score",
        rawPayload: raw ?? body, // 디버깅용 스냅샷
      };

      try {
        // game_runs.sql 스키마(user_id, slug, score, started_at, finished_at, metadata, client_ip, device_hint)
        const rows = await sql/* sql */ `
          insert into game_runs (
            user_id,
            slug,
            score,
            started_at,
            finished_at,
            metadata,
            client_ip,
            device_hint
          )
          values (
            ${userId}::uuid,
            ${gameSlug},
            ${score},
            ${started},
            ${finished},
            ${JSON.stringify(runMetadata)}::jsonb,
            ${ip},
            ${deviceHint ?? null}
          )
          returning id
        `;
        if (rows && rows.length > 0) {
          runId = String(rows[0].id);
        }
      } catch (e) {
        if (!isMissingTable(e)) throw e;
      }

      // 3-3) 점수 → 보상 계산(난이도 + user_effects 버프까지 반영)
      const reward = await computeRewardsWithEffects(
        sql,
        userId,
        score,
        difficulty as Difficulty
      );

      const coinsDelta = reward.coinsDelta;
      const expDelta = reward.expDelta;
      const ticketsDelta = reward.ticketsDelta;

      // 보상이 전혀 없다면 transactions 삽입은 스킵(단순 기록만 필요하다면 여기서 정책 변경 가능)
      if (coinsDelta !== 0 || expDelta !== 0 || ticketsDelta !== 0) {
        // 3-4) transactions 기록 → apply_wallet_transaction 트리거로 user_stats / wallet 반영
        try {
          const txMeta = {
            score,
            game: gameSlug,
            run_id: runId,
            ip,
            ua,
            rewards: {
              coinsDelta,
              expDelta,
              ticketsDelta,
            },
            rewardBase: {
              baseCoins: reward.snapshot.baseCoins,
              baseExp: reward.snapshot.baseExp,
              baseTickets: reward.snapshot.baseTickets,
            },
            effects: {
              coinsMultiplier: reward.snapshot.coinsMultiplier,
              xpMultiplier: reward.snapshot.xpMultiplier,
              ticketsMultiplier: reward.snapshot.ticketsMultiplier,
              appliedKeys: reward.snapshot.appliedKeys,
            },
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
                ${JSON.stringify(txMeta)}::jsonb
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
                ${JSON.stringify(txMeta)}::jsonb
              )
            `;
          }
          // apply_wallet_transaction 트리거(001 + 006)에서 user_stats / wallet_balances / user_progress 등을 실제 갱신
        } catch (e) {
          if (!isMissingTable(e)) {
            // transactions 스키마 문제는 게임 기록 자체를 실패시키지 않는다
          }
        }
      }
    } catch {
      // canonical 경로 전체 실패는 조용히 무시 (기존 계약 유지)
    }

    // ──────────────────────────────────────────────────────────
    // 4) 응답: 기존과 동일하게 { ok: true } + 헤더만 추가
    // ──────────────────────────────────────────────────────────
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
