// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\score.ts
//
// ✅ 목표 (기존 주석 + 강화 버전)
// - 기존 기능/계약(POST /api/games/score → { ok:true }) 100% 유지
// - VS Code TS 오류(ts2304 PagesFunction / ts7031 implicit any) 제거
// - 입력 정규화/범위 검증, 멱등키 지원, 인덱스, 캐시 차단 헤더, 레이트리밋 연동 유지
// - 🔥 강화(지금까지 설계한 내용 전부 반영):
//   • _utils/schema/games.ts 의 확장된 validateScore( difficulty/mode/playTime 등 ) 활용
//   • migrations/game_runs.sql 의 game_runs 스키마에 맞춰 런 기록 저장
//   • migrations/003_shop_effects.sql 의 user_effects( coins/xp multiplier ) 적용
//   • migrations/001_init.sql + 006_wallet_inventory_bridge.sql 의 transactions 경로 사용
//     → apply_wallet_transaction 트리거를 통해 user_stats / wallet 계정에 코인/경험치/티켓 반영
//   • progression.ts 의 computeGameProgressionDelta / applyProgressionDeltaDb 활용
//     → 보상 정책/계정 반영 로직을 중앙화
//   • userId 는 X-User-Id 헤더(우선) → body.userId 순으로 사용 (UUID v4 강제)
//   • 모든 강화는 “추가 동작”일 뿐, 기존 응답 계약/형식은 변경 없음
//
// ───────────────────────────────────────────────────────────────

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateScore } from "../_utils/schema/games";
import * as Rate from "../_utils/rate-limit";
import {
  computeGameProgressionDelta,
  applyProgressionDeltaDb,
  type ProgressionDelta,
} from "../_utils/progression";

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ───────── */
/**
 * VSCode / TS 언어 서버에서 functions 디렉토리의 타입 오류를 없애기 위해
 * Cloudflare PagesFunction 과 거의 동일한 최소 타입을 정의한다.
 * (실제 런타임에서는 Cloudflare 가 주입하는 타입을 사용)
 */
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

/**
 * userId 우선순위:
 *  1) X-User-Id 헤더 (미들웨어에서 JWT → UUID 로 세팅)
 *  2) body.userId (백워드 호환용)
 *
 * 둘 중 하나는 반드시 UUID v4 형식이어야 한다.
 */
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
    // 일부 런타임에서 normalize 미지원 시 조용히 무시
  }

  if (!normalized) throw new Error("Missing userId");
  if (!UUID_V4_REGEX.test(normalized)) {
    // 지금 스키마는 UUID users.id 기준으로 동작하므로 uuid 강제
    throw new Error("Invalid userId");
  }
  return normalized;
}

/**
 * game slug 정규화:
 * - 소문자
 * - 좌우 공백 제거
 * - NFKC 정규화
 * - 정규식(GAME_SLUG_REGEX)에 맞는지 검증
 */
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

/**
 * score 를 int4 범위로 안전하게 클램프.
 * - NaN/Infinity → 에러
 * - 음수 → 0
 * - 상한: 2_147_483_647
 */
function toSafeScore(n: any): number {
  const x = Number(n);
  if (!Number.isFinite(x)) throw new Error("Invalid score");
  const i = Math.floor(x);
  if (i < 0) return 0;
  if (i > 2_147_483_647) return 2_147_483_647;
  return i;
}

/**
 * 중복 제출 방지용 멱등 키(선택)
 * - 헤더 이름 다양한 케이스 수용
 */
function getIdemKey(req: Request): string | null {
  return (
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key") ||
    req.headers.get("x-idempotency-key")
  );
}

/**
 * 초기 상태에서도 안전하게 동작하도록 "테이블 없음" 감지
 * - Neon / Postgres 에서 relation missing 관련 에러 메시지 패턴에 대응
 */
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    msg.includes("undefined_table")
  );
}

/**
 * 클라이언트 메타데이터 (ip/ua) — game_runs.metadata / transactions.meta 에 기록
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

/* ───────── 난이도 타입 / 변환 헬퍼 ───────── */

type Difficulty = "easy" | "normal" | "hard" | "extreme" | null;

/**
 * validateScore 에서 넘어오는 difficulty 가 string | undefined 일 수 있으므로
 * 내부에서 안전하게 캐스팅해주는 헬퍼.
 */
function toDifficulty(raw: any): Difficulty {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "easy" || s === "normal" || s === "hard" || s === "extreme") {
    return s;
  }
  return null;
}

/* ───────── user_effects(버프) 적용 ───────── */

/**
 * 003_shop_effects.sql 에 정의된 효과 키 예시:
 *  - 'coins_multiplier' : 코인 x2, x3 ...
 *  - 'xp_multiplier'    : 경험치 x2 ...
 *  - 'tickets_multiplier': 티켓 x2 ...
 *
 * 예시 스키마(요약):
 *  create table user_effects(
 *    id bigserial primary key,
 *    user_id uuid not null,
 *    effect_key text not null,
 *    value numeric not null,
 *    expires_at timestamptz,
 *    created_at timestamptz not null default now()
 *  );
 */

type EffectRow = {
  effect_key: string;
  value: unknown;
};

/**
 * 활성화된(만료되지 않은) user_effects 로우들을 전부 읽어온다.
 * - 테이블이 없으면 조용히 빈 배열 반환(초기 상태 호환용)
 */
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
    return (rows as any[]) as EffectRow[];
  } catch (e) {
    if (isMissingTable(e)) {
      // user_effects 테이블이 아직 없거나 미적용 → 조용히 기본 보상만 사용
      return [];
    }
    // 기타 에러도 게임 진행 자체를 막지 않도록 여기서는 empty 로 처리
    return [];
  }
}

/**
 * baseCoins/baseExp/baseTickets 를 기반으로 user_effects 의 multiplier 를 적용.
 * - coins_multiplier / xp_multiplier / tickets_multiplier 를 모두 곱한 뒤 최종 보상 계산
 * - multiplier 는 0~10 사이로 클램프
 */
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

    // 0배~10배 사이에서 안전하게 클램프
    const v = Math.max(0, Math.min(vRaw, 10));

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

  // 안전 상한 (BIGINT + UX 관점)
  const MAX_BIG_INTISH = 9_000_000_000;
  if (coins > MAX_BIG_INTISH) coins = MAX_BIG_INTISH;
  if (exp > MAX_BIG_INTISH) exp = MAX_BIG_INTISH;
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

/**
 * progression.ts 기반 보상 + user_effects multiplier 를 한 번에 계산하는 헬퍼.
 * - 1단계: computeGameProgressionDelta 로 "게임 기본 보상" 산출
 * - 2단계: basePoints/baseExp/baseTickets 를 숫자로 변환
 * - 3단계: loadActiveEffects + applyEffectMultipliers 로 버프 적용
 * - 4단계: 최종 coinsDelta/expDelta/ticketsDelta 와 snapshot 반환
 */
async function computeRewardsWithEffects(
  sql: ReturnType<typeof getSql>,
  userId: string,
  gameSlug: string,
  score: number,
  difficulty: Difficulty,
  extraMeta: Record<string, unknown>
): Promise<{
  finalDelta: ProgressionDelta;
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
  // 1) progression.ts 의 기본 보상 계산
  const baseDelta = computeGameProgressionDelta({
    userId,
    game: gameSlug,
    score,
    meta: {
      difficulty,
      ...extraMeta,
    },
  });

  // progression.ts 의 델타는 number | bigint 이므로 숫자로 안전하게 변환
  const baseCoins = Number(baseDelta.pointsDelta ?? 0);
  const baseExp = Number(baseDelta.expDelta ?? 0);
  const baseTickets = Number(baseDelta.ticketsDelta ?? 0);

  // 2) 활성 user_effects 조회
  const effects = await loadActiveEffects(sql, userId);

  // 3) multiplier 적용
  const applied = applyEffectMultipliers(
    {
      baseCoins,
      baseExp,
      baseTickets,
    },
    effects
  );

  // 4) 최종 델타 구성 (playsDelta 는 progression 기본값 유지)
  const finalDelta: ProgressionDelta = {
    userId,
    pointsDelta: applied.coinsDelta,
    expDelta: applied.expDelta,
    ticketsDelta: applied.ticketsDelta,
    playsDelta: baseDelta.playsDelta ?? 1,
    reason: baseDelta.reason || `play_${gameSlug}`,
    refTable: baseDelta.refTable ?? null,
    refId: baseDelta.refId ?? null,
    idempotencyKey: baseDelta.idempotencyKey ?? null,
    meta: {
      ...(baseDelta.meta ?? {}),
      difficulty,
      appliedEffects: applied.snapshot.appliedKeys,
    },
  };

  return {
    finalDelta,
    snapshot: {
      baseCoins,
      baseExp,
      baseTickets,
      coinsMultiplier: applied.snapshot.coinsMultiplier,
      xpMultiplier: applied.snapshot.xpMultiplier,
      ticketsMultiplier: applied.snapshot.ticketsMultiplier,
      appliedKeys: applied.snapshot.appliedKeys,
    },
  };
}

/* ───────── legacy game_scores 스키마 보장 ───────── */

/**
 * 기존 public/user-retro-games.html 등에서 사용하는 레거시 랭킹/통계는
 * game_scores 테이블을 참고할 수 있으므로
 * 새로운 canonical 경로(game_runs + transactions)와 별개로 계속 유지한다.
 */
async function ensureLegacyGameScoresSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
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
}

/**
 * 레거시 game_scores 에 점수를 기록.
 * - 멱등 키가 있으면 on conflict(idempotency_key) do nothing 으로 중복 방지
 * - 이 단계 실패는 전체 API 실패로 이어지지 않게 조용히 무시
 */
async function insertLegacyGameScore(
  sql: ReturnType<typeof getSql>,
  params: { userId: string; gameSlug: string; score: number; idem: string | null }
): Promise<void> {
  const { userId, gameSlug, score, idem } = params;

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
}

/* ───────── games / game_runs canonical 스키마 연동 ───────── */

/**
 * games(slug) row 를 보장하고, id 를 반환.
 * - 이미 존재하면 select 로 가져오고
 * - 없으면 insert on conflict 로 생성
 */
async function ensureGameRow(
  sql: ReturnType<typeof getSql>,
  gameSlug: string
): Promise<string | null> {
  let gameId: string | null = null;

  // 1) 이미 있는지 확인
  try {
    const rows = await sql/* sql */ `
      select id from games where slug = ${gameSlug} limit 1
    `;
    if (rows && rows.length > 0) {
      return String(rows[0].id);
    }
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    // games 테이블이 없다면 아래 insert 부분에서 다시 처리 시도
  }

  // 2) 없으면 insert
  try {
    const title = gameSlug.replace(/[-_]/g, " ").toUpperCase();
    const rows = await sql/* sql */ `
      insert into games (slug, title, category)
      values (${gameSlug}, ${title}, 'arcade')
      on conflict (slug) do update set title = excluded.title
      returning id
    `;
    if (rows && rows.length > 0) {
      gameId = String(rows[0].id);
    }
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }

  return gameId;
}

/**
 * game_runs 에 이번 플레이 기록을 남기고 id 를 반환.
 * - startedAt/finishedAt 은 validateScore 가 넘겨주는 값 기준으로 변환
 * - metadata 에는 difficulty/mode/playTimeMs/deviceHint/ip/ua/rawPayload 등을 저장
 */
async function insertGameRun(
  sql: ReturnType<typeof getSql>,
  params: {
    userId: string;
    gameSlug: string;
    score: number;
    difficulty: Difficulty;
    mode: string | null;
    playTimeMs: number | null;
    deviceHint: string | null;
    startedAt: unknown;
    finishedAt: unknown;
    ip: string | null;
    ua: string | null;
    rawPayload: unknown;
  }
): Promise<string | null> {
  const {
    userId,
    gameSlug,
    score,
    difficulty,
    mode,
    playTimeMs,
    deviceHint,
    startedAt,
    finishedAt,
    ip,
    ua,
    rawPayload,
  } = params;

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
    difficulty,
    mode,
    playTimeMs,
    deviceHint,
    game: gameSlug,
    score,
    ip,
    ua,
    startedAt: started.toISOString(),
    finishedAt: finished ? finished.toISOString() : null,
    source: "api/games/score",
    rawPayload,
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

  return runId;
}

/* ───────── Handler ───────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // Preflight
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
      difficulty: rawDifficulty,
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
    const difficulty = toDifficulty(rawDifficulty);

    const idem = getIdemKey(request);
    const { ip, ua } = getClientMeta(request);
    const sql = getSql(env);

    // ──────────────────────────────────────────────────────────
    // 2) 레거시 game_scores 테이블 기록 (기존 기능 유지용)
    // ──────────────────────────────────────────────────────────
    await ensureLegacyGameScoresSchema(sql);
    await insertLegacyGameScore(sql, { userId, gameSlug, score, idem });

    // ──────────────────────────────────────────────────────────
    // 3) 새 canonical 경로:
    //    - games(slug) 보장
    //    - game_runs 기록
    //    - progression.ts + user_effects 를 통한 보상 + transactions 기록
    // ──────────────────────────────────────────────────────────

    try {
      // 3-1) games(slug) row 보장
      await ensureGameRow(sql, gameSlug);

      // 3-2) game_runs 에 플레이 기록 저장
      const runId = await insertGameRun(sql, {
        userId,
        gameSlug,
        score,
        difficulty,
        mode: mode ?? null,
        playTimeMs: typeof playTimeMs === "number" ? playTimeMs : null,
        deviceHint: deviceHint ?? null,
        startedAt,
        finishedAt,
        ip,
        ua,
        rawPayload: raw ?? body,
      });

      // 3-3) 점수 → progression + user_effects 버프까지 반영한 보상 계산
      const rewards = await computeRewardsWithEffects(
        sql,
        userId,
        gameSlug,
        score,
        difficulty,
        {
          mode,
          playTimeMs,
          ip,
          ua,
        }
      );

      const finalDelta = rewards.finalDelta;

      // 보상이 전혀 없다면 progression 적용은 스킵(기록만 남기고 끝)
      const hasNonZero =
        !!finalDelta.pointsDelta ||
        !!finalDelta.expDelta ||
        !!finalDelta.ticketsDelta ||
        !!finalDelta.playsDelta;

      if (hasNonZero) {
        // 3-4) transactions 기반 progression 적용 (apply_wallet_transaction 트리거 경유)
        const txMeta = {
          score,
          game: gameSlug,
          run_id: runId,
          ip,
          ua,
          rewards: {
            pointsDelta: finalDelta.pointsDelta ?? 0,
            expDelta: finalDelta.expDelta ?? 0,
            ticketsDelta: finalDelta.ticketsDelta ?? 0,
            playsDelta: finalDelta.playsDelta ?? 0,
          },
          rewardBase: {
            baseCoins: rewards.snapshot.baseCoins,
            baseExp: rewards.snapshot.baseExp,
            baseTickets: rewards.snapshot.baseTickets,
          },
          effects: {
            coinsMultiplier: rewards.snapshot.coinsMultiplier,
            xpMultiplier: rewards.snapshot.xpMultiplier,
            ticketsMultiplier: rewards.snapshot.ticketsMultiplier,
            appliedKeys: rewards.snapshot.appliedKeys,
          },
        };

        try {
          await applyProgressionDeltaDb(sql, {
            ...finalDelta,
            // 여기서 refTable/refId/idempotencyKey/meta 를 덮어쓴다.
            refTable: "game_runs",
            refId: runId ?? null,
            idempotencyKey: idem ?? null,
            meta: txMeta,
            reason: finalDelta.reason || "game_score",
          });
        } catch (e) {
          if (!isMissingTable(e)) {
            // transactions / user_stats 관련 스키마가 부분적일 경우에도
            // 게임 진행 자체는 막지 않도록 에러를 삼킨다.
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
