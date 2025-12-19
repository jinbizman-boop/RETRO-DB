/**
 * Unified Wallet API Adapter for Retro Games
 * ------------------------------------------
 * 클라이언트(게임 페이지)는 `/api/wallet` 로 POST 요청하고
 * body.action 값으로 동작을 나눈다.
 *
 * 지원 action:
 *  - SYNC / SYNCWALLET           → 현재 사용자 wallet 상태 조회
 *  - ADD_REWARD / ADDGAMEREWARD  → 게임 보상(포인트/티켓/플레이카운트 등) 반영
 *
 * 아키텍처(최신 버전, C안 반영):
 *  - user_stats   : 유저별 집계 상태(코인/티켓/경험치/플레이수)
 *  - transactions : 세부 트랜잭션 로그(게임 보상, 시스템 조정 등)
 *  - DB 트리거    : transactions INSERT 시 user_stats 를 자동 갱신
 *
 * 이 파일의 역할:
 *  - HTTP 요청 단에서 유저 식별, 파라미터 검증, 비즈니스 규칙 적용
 *  - “delta(증감)”를 계산해 transactions 테이블에 INSERT
 *  - DB 트리거가 user_stats 를 갱신하면, 최신 상태를 읽어 클라이언트에 반환
 *
 * 전제:
 *  - _middleware.ts 가 유저 식별(X-User-Id) 헤더를 자동 주입해야 정상동작
 *  - Cloudflare Pages Functions / Wrangler 빌드에서 단일 엔트리로 사용됨.
 *
 * 유저 식별 라인 맞추기 A/B 적용 개요:
 *  - A안: JWT 토큰(requireUser)을 “정본(Single Source of Truth)”으로 사용하고,
 *         여기서 나온 userId 를 cleanUserId 로 정규화하여 DB user_stats.user_id 에 사용.
 *  - B안: 과거 클라이언트/미들웨어와의 호환을 위해 X-User-Id 헤더도 받아들이되,
 *         존재하는 경우 JWT 기반 userId 와 cross-check 하여 가능한 한 일치시키고
 *         둘 다 invalid 이면 INVALID_USER 로 처리.
 */

import type { Env } from "./_utils/db";
import { getSql } from "./_utils/db";
import { json } from "./_utils/json";
import { requireUser } from "./_utils/auth";

/* ========================================================================== */
/*  UserId Helpers                                                            */
/* ========================================================================== */

/**
 * cleanUserId
 * -----------
 * X-User-Id 헤더 값 정규화 + 검증
 *
 * - null/undefined → "" (무효)
 * - 앞뒤 공백 제거
 * - 너무 긴 값(128자 초과) → 무효
 * - 허용 문자:
 *    알파벳, 숫자, 언더바(_), 하이픈(-), @, ., :
 *
 * 이 함수에서 "" 를 반환하면 "INVALID_USER" 로 처리한다.
 * 즉, 이 함수는 "사용할 수 있는 userId"만 통과시키는 필터 역할을 한다.
 */
function cleanUserId(raw: string | null | undefined): string {
  if (!raw) return "";

  const trimmed = raw.trim();
  if (!trimmed) return "";

  // 길이 보호 (Cloudflare / Neon 양쪽에서 너무 긴 키를 막기 위함)
  if (trimmed.length > 128) return "";

  // 허용 문자 이외가 포함되어 있으면 무효 처리
  const ok = /^[A-Za-z0-9_\-@.:]+$/.test(trimmed);
  if (!ok) return "";

  return trimmed;
}

/**
 * resolveUserId
 * -------------
 * 유저 식별 라인 맞추기 A + B
 *
 * A안 (정본: JWT 기반):
 *  - requireUser(request, env)를 호출해서 access token / 세션에서 payload.sub 를 얻고
 *    cleanUserId 로 정규화한다.
 *
 * B안 (헤더 호환):
 *  - request.headers.get("X-User-Id") 를 cleanUserId 로 정규화한다.
 *
 * 최종 로직:
 *  1) JWT 기반 userId (fromToken)가 유효하면 우선 사용.
 *  2) 헤더 기반 userId (fromHeader)가 유효한데, fromToken 이 비어 있으면 헤더 사용.
 *  3) 둘 다 유효하지만 값이 다를 경우:
 *     - 보안상 JWT 를 신뢰하고, 헤더 값은 무시한다.
 *     - 필요 시 콘솔 로그 정도는 남길 수 있으나, API Contract 를 깨지 않기 위해
 *       여기서는 조용히 fromToken 을 선택한다.
 *  4) 둘 다 무효이면 null 반환 (caller 가 INVALID_USER 처리).
 */
async function resolveUserId(
  request: Request,
  env: Env
): Promise<string | null> {
  // B안: 헤더 기반
  const headerRaw = request.headers.get("X-User-Id");
  const fromHeader = cleanUserId(headerRaw);

  // A안: JWT / 세션 기반 (정본)
  let fromToken = "";
  try {
    const payload = await requireUser(request, env);
    const tokenIdRaw =
      (payload && (payload.sub as string)) ||
      (payload && (payload.userId as string)) ||
      (payload && (payload.id as string)) ||
      "";
    fromToken = cleanUserId(tokenIdRaw);
  } catch {
    // 비로그인 또는 토큰 오류 → 여기서 예외를 터뜨리지 않고, 헤더 경로(B안)로 fallback
    fromToken = "";
  }

  // 1) 토큰 기반이 있으면 그것이 우선 (A안)
  if (fromToken) {
    // 헤더가 있고, 토큰과 다르다면 토큰을 신뢰 (헤더는 무시)
    if (fromHeader && fromHeader !== fromToken) {
      // 필요하다면 디버깅용 로그 정도는 남길 수 있음:
      // console.warn("[wallet] X-User-Id header mismatch, using token subject");
    }
    return fromToken;
  }

  // 2) 토큰이 없고, 헤더만 유효하면 B안 경로 사용
  if (fromHeader) {
    return fromHeader;
  }

  // 3) 둘 다 무효 → INVALID_USER
  return null;
}

/* ========================================================================== */
/*  Local badRequest Helper                                                   */
/* ========================================================================== */

/**
 * badRequest
 * ----------
 * - `_utils/json.ts` 에 badRequest export 가 없어서 발생했던
 *   Cloudflare 빌드 에러를 피하기 위해, 이 파일 안에서만 사용하는
 *   로컬 헬퍼로 구현한다.
 * - 내부적으로는 프로젝트 공통 json() 헬퍼를 그대로 사용한다.
 *
 * 사용 패턴:
 *   return badRequest({ ok:false, error:"INVALID_USER", ... });
 *
 * 주의:
 *   - 절대로 `import { badRequest } from "./_utils/json"` 형태로
 *     외부에서 가져오지 않는다. (빌드 에러 방지)
 */
function badRequest(body: unknown): Response {
  return json(body, { status: 400 });
}

/* ========================================================================== */
/*  타입 정의                                                                 */
/* ========================================================================== */

/**
 * user_stats 스냅샷을 API 관점으로 매핑한 타입
 *
 * DB 가정:
 *   CREATE TABLE IF NOT EXISTS user_stats (
 *     user_id       text PRIMARY KEY,
 *     coins         integer NOT NULL DEFAULT 0,
 *     tickets       integer NOT NULL DEFAULT 0,
 *     exp           integer NOT NULL DEFAULT 0,
 *     games_played  integer NOT NULL DEFAULT 0,
 *     created_at    timestamptz NOT NULL DEFAULT now(),
 *     updated_at    timestamptz NOT NULL DEFAULT now()
 *   );
 */
type WalletSnapshot = {
  /** 코인/포인트 (user_stats.coins) */
  balance: number;
  /** 보유 티켓 수 (user_stats.tickets) */
  tickets: number;
  /** 플레이 횟수 (user_stats.games_played) */
  playCount: number;
  /** 경험치 (user_stats.exp) */
  exp: number;
};

/** user_stats SELECT 결과 행 타입 (내부용) */
type UserStatsRow = {
  coins: number | null;
  tickets: number | null;
  exp: number | null;
  games_played: number | null;
};

/**
 * 게임에서 보내는 보상 payload 타입
 *
 * Body 예시:
 *   {
 *     "action": "ADD_REWARD",
 *     "reward": 120,
 *     "score": 9999,
 *     "tier": "bronze",
 *     "level": 3,
 *     "reason": "tetris_clear",
 *     "game": "tetris",
 *     "meta": { "stage": 2 }
 *   }
 */
type RewardPayload = {
  // 기존 (게임 보상)
  reward?: number;
  score?: number;
  tier?: string;
  level?: number;
  reason?: string;
  game?: string;
  meta?: any;

  // 신규 (수동/이벤트 보상: today-lucky 같은 곳)
  pointsEarned?: number;      // +/-
  ticketsEarned?: number;     // +/-
  expEarned?: number;         // +/-
  playsIncrement?: number;    // +/-
};

/**
 * DB 에 반영할 Wallet Delta (증감치)
 * - transactions 테이블에 INSERT 될 구조를 표현
 *
 * DB 가정:
 *   CREATE TABLE IF NOT EXISTS transactions (
 *     id             bigserial PRIMARY KEY,
 *     user_id        text NOT NULL,
 *     amount         integer NOT NULL,
 *     type           text NOT NULL,
 *     reason         text NOT NULL,
 *     meta           jsonb,
 *     created_at     timestamptz NOT NULL DEFAULT now(),
 *     game           text,
 *     exp_delta      integer NOT NULL DEFAULT 0,
 *     tickets_delta  integer NOT NULL DEFAULT 0,
 *     plays_delta    integer NOT NULL DEFAULT 0,
 *     balance_after  integer
 *   );
 *
 *   CREATE OR REPLACE FUNCTION apply_wallet_transaction() RETURNS trigger AS $$
 *   BEGIN
 *     -- 이 함수에서 transactions 의 delta 를 user_stats 에 반영
 *     -- (coins / tickets / exp / games_played 갱신)
 *     RETURN NEW;
 *   END;
 *   $$ LANGUAGE plpgsql;
 *
 *   CREATE TRIGGER trigger_user_stats_from_transactions
 *   AFTER INSERT ON transactions
 *   FOR EACH ROW
 *   EXECUTE FUNCTION apply_wallet_transaction();
 */
type WalletDelta = {
  userId: string;
  /** 코인/포인트 증감 (transactions.amount) */
  pointsDelta: number;
  /** 티켓 증감 (transactions.tickets_delta) */
  ticketsDelta: number;
  /** 경험치 증감 (transactions.exp_delta) */
  expDelta: number;
  /** 플레이 수 증감 (transactions.plays_delta) */
  playsDelta: number;
  /** 게임 식별자 (transactions.game, 예: "tetris") */
  game: string;
  /** 사유 (transactions.reason, 예: "game:tetris") */
  reason: string;
  /** 메타데이터 (transactions.meta) */
  meta: any;
};

/**
 * 클라이언트에서 오는 action 문자열 정규화
 * - undefined / null / 비문자열 → ""
 * - 앞뒤 공백 제거 후 대문자로 통일
 *   예) " sync " → "SYNC"
 */
function normalizeAction(value: unknown): string {
  if (typeof value !== "string") return "";
  const s = value.trim().toUpperCase();
  if (!s) return "";

  // today-lucky.html 등: action: "reward"
  if (s === "REWARD") return "REWARD";

  // 관용/레거시 alias
  if (s === "ADDREWARD") return "ADD_REWARD";
  if (s === "ADD_REWARD") return "ADD_REWARD";
  if (s === "ADDGAMEREWARD") return "ADDGAMEREWARD";
  if (s === "ADD_GAME_REWARD") return "ADDGAMEREWARD";

  if (s === "SYNC_WALLET") return "SYNCWALLET";

  return s;
}

/* ========================================================================== */
/*  Core Query Helpers: user_stats Snapshot                                   */
/* ========================================================================== */

/**
 * user_stats 테이블에서 현재 상태를 조회하고,
 * 없으면 (user_id, 0, 0, 0, 0) 레코드를 생성한 뒤 스냅샷을 반환한다.
 *
 * - 레코드가 없을 때:
 *     INSERT INTO user_stats (user_id, coins, tickets, exp, games_played)
 *     VALUES (${userId}, 0, 0, 0, 0)
 *     ON CONFLICT (user_id) DO NOTHING;
 *
 *   이후 balance=0, tickets=0, playCount=0, exp=0 을 반환한다.
 *
 * 이 함수는 “현재 집계 상태”만 책임지고, 세부 거래는 transactions + 트리거에
 * 의해 관리된다.
 */
async function getWalletSnapshot(env: Env, userId: string): Promise<WalletSnapshot> {
  const sql = getSql(env);

  const rows = await sql<UserStatsRow>`
    SELECT coins, tickets, exp, games_played
    FROM user_stats
    WHERE user_id = ${userId}::uuid
    LIMIT 1
  `;

  if (!rows.length) {
    // 없다면 신규 생성 (중복 방지 ON CONFLICT)
    await sql`
      INSERT INTO user_stats (user_id, coins, tickets, exp, games_played)
      VALUES (${userId}::uuid, 0, 0, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `;

    return {
      balance: 0,
      tickets: 0,
      playCount: 0,
      exp: 0,
    };
  }

  const row = rows[0];

  return {
    balance: row.coins ?? 0,
    tickets: row.tickets ?? 0,
    playCount: row.games_played ?? 0,
    exp: row.exp ?? 0,
  };
}

/* ========================================================================== */
/*  Delta Builder: Reward → WalletDelta                                       */
/* ========================================================================== */

/**
 * clampPoints
 * -----------
 * 포인트(코인)를 0 ~ 5000 범위로 고정(clamp)하기 위한 헬퍼.
 *
 * - 기존 비즈니스 규칙:
 *     balance: reward 만큼 증가하되, [0, 5000] 범위를 벗어나지 않도록 clamp
 */
function clampPoints(
  raw: number,
  currentBalance: number
): {
  nextBalance: number;
  delta: number;
} {
  let next = currentBalance + raw;
  if (next > 5000) next = 5000;
  if (next < 0) next = 0;
  return {
    nextBalance: next,
    delta: next - currentBalance,
  };
}

/**
 * sanitizeNumber
 * --------------
 * NaN / null / undefined → 0 으로 처리하는 숫자 정규화 유틸.
 */
function sanitizeNumber(val: unknown): number {
  if (typeof val !== "number") return 0;
  if (!Number.isFinite(val)) return 0;
  return val;
}

/**
 * buildGameRewardDelta
 * --------------------
 * 게임 보상 payload + 현재 user_stats 스냅샷을 받아서
 * DB transactions 테이블에 INSERT 할 WalletDelta(증감치)를 계산한다.
 *
 * 비즈니스 규칙:
 *  - playsDelta:
 *      * 항상 1 (게임 1회 플레이)
 *  - ticketsDelta:
 *      * (현재 playCount + 1)이 10, 20, 30, ... 인 경우 +1
 *  - pointsDelta (포인트/코인):
 *      * reward 만큼 증가 (단, 최종 balance 는 [0, 5000] 으로 clamp)
 *      * delta = clamp 결과(nextBalance - currentBalance)
 *  - expDelta (경험치):
 *      * 기본적으로 reward 를 기반으로 산정
 *      * reward <= 0 이고 score > 0 인 경우, score 를 사용
 *      * 필요시 향후 별도 규칙으로 교체 가능
 *  - game / reason / meta:
 *      * game: body.game 또는 meta.game, 기본값 "generic"
 *      * reason: body.reason 또는 "game:<game>"
 *      * meta: payload.meta 에 score, rawReward, nextBalance, nextPlayCount 등 추가
 */
function buildGameRewardDelta(
  userId: string,
  payload: RewardPayload,
  snapshot: WalletSnapshot
): { delta: WalletDelta; nextBalance: number; nextPlayCount: number } {
  const rawReward = sanitizeNumber(payload.reward);
  const score = sanitizeNumber(payload.score);

  // 다음 플레이 카운트 (항상 +1)
  const nextPlayCount = snapshot.playCount + 1;

  // 티켓: 10회의 배수 플레이마다 1장 지급
  const ticketsDelta = nextPlayCount > 0 && nextPlayCount % 10 === 0 ? 1 : 0;

  // 포인트/코인: clamp 규칙 적용
  const { nextBalance, delta: pointsDelta } = clampPoints(
    rawReward,
    snapshot.balance
  );

  // 경험치: 기본적으로 reward 기반, 없으면 score 기반
  let expDelta = 0;
  if (rawReward > 0) {
    expDelta = rawReward;
  } else if (score > 0) {
    // 보상 포인트가 없지만 점수는 있는 경우, 점수를 경험치로 사용
    expDelta = score;
  }

  // 게임 식별자
  const rawGame =
    (typeof payload.game === "string" && payload.game.trim()) ||
    (payload.meta &&
      typeof payload.meta.game === "string" &&
      payload.meta.game.trim()) ||
    "generic";
  const game = rawGame.slice(0, 64);

  // 사유
  const rawReason =
    (typeof payload.reason === "string" && payload.reason.trim()) ||
    `game:${game}`;
  const reason = rawReason.slice(0, 80);

  const baseMeta =
    payload.meta && typeof payload.meta === "object" ? payload.meta : {};

  const meta = {
    ...baseMeta,
    score,
    rawReward,
    nextBalance,
    nextPlayCount,
    tier: payload.tier ?? null,
    level: payload.level ?? null,
  };

  const delta: WalletDelta = {
    userId,
    pointsDelta,
    ticketsDelta,
    expDelta,
    playsDelta: 1,
    game,
    reason,
    meta,
  };

  return { delta, nextBalance, nextPlayCount };
}

/* ========================================================================== */
/*  Core: Apply Game Reward (user_stats + transactions + 트리거)              */
/* ========================================================================== */

/**
 * applyGameReward
 * ---------------
 * 게임 보상(포인트/티켓/플레이카운트/경험치)을 wallet 시스템에 반영한다.
 *
 * 절차:
 *  1) 현재 user_stats 스냅샷 조회 (없으면 0,0,0,0 으로 생성)
 *  2) buildGameRewardDelta 로 증감치(WalletDelta) 계산
 *  3) transactions 테이블에 INSERT
 *  4) DB 트리거가 user_stats 를 업데이트
 *  5) 최신 user_stats 스냅샷을 다시 조회하여 API 응답으로 반환
 *
 * 이 함수는 “DB 구조(user_stats + transactions + 트리거)”에 맞춰 설계되어 있으며,
 * 개별 wallet 필드(balance/tickets/exp/playCount)는 user_stats 의 결과만 믿는다.
 */
async function applyGameReward(
  env: Env,
  userId: string,
  payload: RewardPayload
): Promise<WalletSnapshot> {
  const sql = getSql(env);

  // 1) 현재 스냅샷 조회
  const snapshot = await getWalletSnapshot(env, userId);

  // 2) Delta 계산
  const { delta } = buildGameRewardDelta(userId, payload, snapshot);

  // 3) transactions INSERT
  const metaJson = JSON.stringify(delta.meta ?? {});

  await sql`
    INSERT INTO transactions (
      user_id,
      amount,
      type,
      reason,
      meta,
      game,
      exp_delta,
      tickets_delta,
      plays_delta
    )
    VALUES (
      ${delta.userId}::uuid,
      ${delta.pointsDelta},
      'game',
      ${delta.reason},
      ${metaJson},
      ${delta.game},
      ${delta.expDelta},
      ${delta.ticketsDelta},
      ${delta.playsDelta}
    )
  `;

  // 4) 트리거가 user_stats 를 갱신했다고 가정하고, 다시 스냅샷 조회
  const updated = await getWalletSnapshot(env, userId);

  return updated;
}

/* ========================================================================== */
/*  Request Handler                                                           */
/* ========================================================================== */

/**
 * POST /api/wallet
 * ----------------
 *
 * Body 예시:
 *  { "action": "SYNC" }
 *  { "action": "SYNCWALLET" }
 *  { "action": "ADD_REWARD",     "reward": 120, "score": 9999, ... }
 *  { "action": "ADDGAMEREWARD",  "reward": 120, "score": 9999, ... }
 *
 * 클라이언트에서는 항상 credentials: "include" 로 호출하여
 * _middleware.ts 가 부여하는 X-User-Id 헤더를 함께 전달해야 한다.
 *
 * 유저 식별 A/B 적용 후 실제 동작:
 *  - 먼저 requireUser(request, env) 로 JWT/세션 기반 userId 를 구한다(A안).
 *  - X-User-Id 헤더가 별도로 설정된 경우, cleanUserId 로 정규화하여 비교(B안).
 *  - 둘 중 유효한 것을 고르고, 충돌 시 JWT 를 우선시한다.
 *
 * 응답 공통 포맷:
 *  - 성공:
 *      {
 *        ok: true,
 *        balance:  number,
 *        tickets:  number,
 *        playCount:number,
 *        exp:      number
 *      }
 *
 *  - 에러:
 *      { ok: false, error: string, message?: string }
 *
 *   error 값 예:
 *      INVALID_USER / UNSUPPORTED_ACTION / SERVER_ERROR
 *
 * 기존 클라이언트 호환성:
 *  - balance, tickets, playCount 필드는 기존과 동일한 의미/타입을 유지한다.
 *  - exp 필드는 신규 필드이며, 이전 클라이언트는 이를 무시해도 무방하다.
 */
export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  const { request, env } = context;

  try {
    /* -------------------------------------------------------------- */
    /* 1) User identification (A + B 라인 맞추기)                      */
    /* -------------------------------------------------------------- */

    const userId = await resolveUserId(request, env);

    if (!userId) {
      // 유효한 유저 식별자를 찾지 못한 경우
      return badRequest({
        ok: false,
        error: "INVALID_USER",
        message: "유효하지 않은 사용자 식별자",
      });
    }

    /* -------------------------------------------------------------- */
    /* 2) Body 파싱                                                    */
    /* -------------------------------------------------------------- */

    // 잘못된 JSON 이거나, body 자체가 없는 경우를 대비해 방어 코드
    const body: any =
      (await request
        .json()
        .catch(() => ({}))) || {};

    const action = normalizeAction(body.action);

    /* -------------------------------------------------------------- */
    /* 3) ACTION SWITCH                                                */
    /* -------------------------------------------------------------- */

    // 3-1. 지갑 상태 동기화
    if (action === "SYNC" || action === "SYNCWALLET") {
      const snap = await getWalletSnapshot(env, userId);

      const level = Math.max(1, Math.floor((snap.exp || 0) / 1000) + 1);
      const wallet = {
        points: snap.balance,
        tickets: snap.tickets,
        exp: snap.exp,
        plays: snap.playCount,
        level,
        xpCap: null,
      };
      const stats = {
        points: snap.balance,
        exp: snap.exp,
        tickets: snap.tickets,
        gamesPlayed: snap.playCount,
        level,
      };

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount,
        exp: snap.exp,
        wallet,
        stats,
        snapshot: { wallet, stats },
      });
    }

    // 3-2. 수동/이벤트 보상 (today-lucky.html: action="reward")
    if (action === "REWARD") {
      const toNum = (v: any) => {
        const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
        return Number.isFinite(n) ? Math.trunc(n) : 0;
      };

      const pointsDelta = toNum(body.pointsEarned ?? body.reward ?? 0);
      const ticketsDelta = toNum(body.ticketsEarned ?? 0);
      const expDelta = toNum(body.expEarned ?? 0);
      const playsDelta = toNum(body.playsIncrement ?? 0);

      const reason =
        (typeof body.reason === "string" && body.reason.trim().slice(0, 80)) ||
        "reward:manual";
      const game =
        (typeof body.game === "string" && body.game.trim().slice(0, 64)) ||
        "reward";
      const metaJson = JSON.stringify(
        body.meta && typeof body.meta === "object" ? body.meta : {}
      );

      const sql = getSql(env);

      // runId (멱등성): today-lucky.html이 이미 runId를 보내고 있음
      const runId =
        (typeof body.runId === "string" && body.runId.trim().slice(0, 200)) ||
        (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim().slice(0, 200)) ||
        null;

      // game 정규화(소문자/허용문자) → daily unique index 매칭을 100% 보장
      const gameRaw =
        (typeof body.game === "string" && body.game.trim()) ||
        "reward";
      const gameNorm =
        gameRaw
          .toLowerCase()
          .replace(/\s+/g, "")
          .replace(/[^a-z0-9_\-]/g, "")
          .slice(0, 64) || "reward";

      try {
        await sql`
          INSERT INTO transactions (
            user_id,
            amount,
            type,
            reason,
            meta,
            game,
            exp_delta,
            tickets_delta,
            plays_delta,
            run_id
          )
          VALUES (
            ${userId}::uuid,
            ${pointsDelta},
            'reward',
            ${reason},
            ${metaJson},
            ${gameNorm},
            ${expDelta},
            ${ticketsDelta},
            ${playsDelta},
            ${runId}
          )
        `;
      } catch (e: any) {
        // Postgres unique violation
        const code = String(e?.code || "");
        const constraint = String(e?.constraint || "");

        if (code === "23505") {
          // 1) today-lucky 하루 1회 제한
          if (constraint === "idx_transactions_today_lucky_daily") {
            const snap = await getWalletSnapshot(env, userId);

            const level = Math.max(1, Math.floor((snap.exp || 0) / 1000) + 1);
            const wallet = {
              points: snap.balance,
              tickets: snap.tickets,
              exp: snap.exp,
              plays: snap.playCount,
              level,
              xpCap: null,
            };
            const stats = {
              points: snap.balance,
              exp: snap.exp,
              tickets: snap.tickets,
              gamesPlayed: snap.playCount,
              level,
            };

            return json(
              {
                ok: false,
                error: "ALREADY_SPUN_TODAY",
                message: "이미 오늘의 행운을 사용했습니다.",
                wallet,
                stats,
                snapshot: { wallet, stats },
              },
              { status: 409 }
            );
          }

          // 2) run_id 멱등성(같은 runId 재호출) → 성공으로 처리
          if (constraint === "idx_transactions_user_run") {
            const snap = await getWalletSnapshot(env, userId);

            const level = Math.max(1, Math.floor((snap.exp || 0) / 1000) + 1);
            const wallet = {
              points: snap.balance,
              tickets: snap.tickets,
              exp: snap.exp,
              plays: snap.playCount,
              level,
              xpCap: null,
            };
            const stats = {
              points: snap.balance,
              exp: snap.exp,
              tickets: snap.tickets,
              gamesPlayed: snap.playCount,
              level,
            };

            return json({
              ok: true,
              duplicate: true,
              balance: snap.balance,
              tickets: snap.tickets,
              playCount: snap.playCount,
              exp: snap.exp,
              wallet,
              stats,
              snapshot: { wallet, stats },
            });
          }
        }

        throw e;
      }

      const snap = await getWalletSnapshot(env, userId);

      const level = Math.max(1, Math.floor((snap.exp || 0) / 1000) + 1);
      const wallet = {
        points: snap.balance,
        tickets: snap.tickets,
        exp: snap.exp,
        plays: snap.playCount,
        level,
        xpCap: null,
      };
      const stats = {
        points: snap.balance,
        exp: snap.exp,
        tickets: snap.tickets,
        gamesPlayed: snap.playCount,
        level,
      };

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount,
        exp: snap.exp,
        wallet,
        stats,
        snapshot: { wallet, stats },
      });
    }

    // 3-3. 게임 보상 적립
    if (action === "ADD_REWARD" || action === "ADDGAMEREWARD") {
      const snap = await applyGameReward(env, userId, {
        reward: body.reward,
        score: body.score,
        level: body.level,
        tier: body.tier,
        reason: body.reason,
        game: body.game,
        meta: body.meta,
      });

      const level = Math.max(1, Math.floor((snap.exp || 0) / 1000) + 1);
      const wallet = {
        points: snap.balance,
        tickets: snap.tickets,
        exp: snap.exp,
        plays: snap.playCount,
        level,
        xpCap: null,
      };
      const stats = {
        points: snap.balance,
        exp: snap.exp,
        tickets: snap.tickets,
        gamesPlayed: snap.playCount,
        level,
      };

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount,
        exp: snap.exp,
        wallet,
        stats,
        snapshot: { wallet, stats },
      });
    }

    /* -------------------------------------------------------------- */
    /* 4) 지원하지 않는 action                                         */
    /* -------------------------------------------------------------- */

    return badRequest({
      ok: false,
      error: "UNSUPPORTED_ACTION",
      message: "지원하지 않는 action 입니다.",
    });
  } catch (err: any) {
    console.error("[wallet.ts] error", err);

    // json() helper 는 (body, init?) 시그니처를 사용하는 것으로 가정
    return json(
      {
        ok: false,
        error: "SERVER_ERROR",
        message: "Wallet 처리 중 서버 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}

/* ========================================================================== */
/*  Implementation Notes (for maintainers) – C안 + 유저 식별 A/B 정렬         */
/* ========================================================================== */

/**
 * 1. 전체 구조 요약
 * -----------------
 * - user_stats:
 *     * 유저별 집계 상태를 1행으로 유지한다.
 *     * coins (포인트), tickets, exp(경험치), games_played(플레이 수)를 포함.
 *
 * - transactions:
 *     * 모든 세부 지갑 변동 이력을 기록하는 로그 테이블이다.
 *     * amount, type, reason, meta, game, exp_delta, tickets_delta, plays_delta,
 *       balance_after 등을 포함하도록 설계할 수 있다.
 *
 * - 트리거(apply_wallet_transaction):
 *     * transactions 에 INSERT 된 delta 를 읽어 user_stats 를 갱신한다.
 *     * “한 방향(INSERT)”만 지원하므로, UPDATE/DELETE 를 사용할 때는
 *       별도의 정책을 수립해야 한다(이 파일은 INSERT 기반 보상만 사용).
 *
 * - wallet.ts:
 *     * HTTP 레벨에서 action 분기, 유저 식별, 비즈니스 규칙(티켓/경험치 등)
 *       을 처리하고, 최종적으로는 delta 를 transactions 에 INSERT 한다.
 *     * user_stats 의 최종 결과를 읽어 클라이언트에 전달하는 프록시 역할이다.
 *
 *
 * 2. 유저 식별 라인 맞추기 (A안 + B안)
 * -----------------------------------
 * - A안(정본: JWT 기반):
 *     * requireUser(request, env) 를 호출하여 access token / 세션의 payload 를 얻는다.
 *     * payload.sub, payload.userId, payload.id 순으로 userId 후보를 찾는다.
 *     * cleanUserId 로 정규화하여, 이 값이 있으면 무조건 우선 사용한다.
 *
 * - B안(헤더 호환):
 *     * request.headers.get("X-User-Id") 를 cleanUserId 로 정규화한다.
 *     * 과거 미들웨어/클라이언트가 X-User-Id 를 직접 세팅하던 흐름을 보존한다.
 *
 * - resolveUserId 로직:
 *     * fromToken(토큰 기반)이 있으면 → 정본으로 사용.
 *         - fromHeader(헤더)가 있고 값이 달라도, 보안상 토큰을 신뢰한다.
 *     * fromToken 이 없고, fromHeader 만 유효하면 → 헤더 기반으로 사용.
 *     * 둘 다 무효이면 → null 을 반환하고, 상위에서 INVALID_USER 로 처리.
 *
 * - 이 구조를 통해:
 *     * 새 아키텍처(_middleware.ts + auth utils)가 적용된 경로에서는 JWT 가 정본.
 *     * 과거/임시 클라이언트는 여전히 X-User-Id 헤더만으로 동작 가능.
 *     * DB user_stats.user_id 에는 항상 cleanUserId 로 정규화된 값이 들어간다.
 *
 *
 * 3. Wallet 동작 규칙 (비즈니스 로직 상세)
 * ---------------------------------------
 * - SYNC / SYNCWALLET:
 *   - getWalletSnapshot(env, userId)를 호출하여 user_stats 를 읽는다.
 *   - 레코드가 없다면 (user_id, 0, 0, 0, 0)으로 신규 생성 후 {0,0,0,0} 반환.
 *   - 응답:
 *       {
 *         ok: true,
 *         balance: snapshot.balance,
 *         tickets: snapshot.tickets,
 *         playCount: snapshot.playCount,
 *         exp: snapshot.exp
 *       }
 *
 * - ADD_REWARD / ADDGAMEREWARD:
 *
 *   (1) snapshot 읽기
 *     - getWalletSnapshot으로 현재 balance, tickets, exp, playCount 조회.
 *
 *   (2) buildGameRewardDelta 호출
 *     - reward, score, tier, level, game, reason, meta 를 기반으로 delta 계산.
 *     - playsDelta:
 *         snapshot.playCount + 1 을 nextPlayCount 로 보고, 항상 1을 기록.
 *     - ticketsDelta:
 *         nextPlayCount 가 10, 20, 30, ... 인 경우 1, 그 외 0.
 *     - pointsDelta:
 *         clampPoints() 를 통해 [0, 5000] 범위 내에서 변화량을 계산.
 *     - expDelta:
 *         기본적으로 reward 를 사용, reward <= 0 인 경우 score 를 사용.
 *
 *   (3) transactions INSERT
 *     - INSERT INTO transactions (...) VALUES (...delta...)
 *     - type 은 항상 'game' 으로 기록(다른 타입은 별도 API 에서 사용 가능).
 *
 *   (4) 트리거 처리
 *     - DB 레벨에서 AFTER INSERT 트리거가 동작하여 user_stats 를 갱신한다.
 *     - 이 로직 안에서 coins, tickets, exp, games_played 를 모두 업데이트하도록
 *       구현되어 있어야 한다.
 *
 *   (5) 최신 상태 재조회
 *     - 최종적으로 getWalletSnapshot 을 다시 호출해 최신 상태를 읽고,
 *       클라이언트에 반환한다.
 *
 *
 * 4. DB 스키마/트리거 예시 (참고용, 실제 적용 시 마이그레이션에 사용)
 * ------------------------------------------------------------------
 *
 * -- user_stats 테이블
 * CREATE TABLE IF NOT EXISTS user_stats (
 *   user_id       text PRIMARY KEY,
 *   coins         integer NOT NULL DEFAULT 0,
 *   tickets       integer NOT NULL DEFAULT 0,
 *   exp           integer NOT NULL DEFAULT 0,
 *   games_played  integer NOT NULL DEFAULT 0,
 *   created_at    timestamptz NOT NULL DEFAULT now(),
 *   updated_at    timestamptz NOT NULL DEFAULT now()
 * );
 *
 * -- transactions 테이블
 * CREATE TABLE IF NOT EXISTS transactions (
 *   id             bigserial PRIMARY KEY,
 *   user_id        text NOT NULL,
 *   amount         integer NOT NULL,
 *   type           text NOT NULL,
 *   reason         text NOT NULL,
 *   meta           jsonb,
 *   created_at     timestamptz NOT NULL DEFAULT now(),
 *   game           text,
 *   exp_delta      integer NOT NULL DEFAULT 0,
 *   tickets_delta  integer NOT NULL DEFAULT 0,
 *   plays_delta    integer NOT NULL DEFAULT 0,
 *   balance_after  integer
 * );
 *
 * -- user_stats 갱신용 트리거 함수
 * CREATE OR REPLACE FUNCTION apply_wallet_transaction() RETURNS trigger AS $$
 * DECLARE
 *   current_stats user_stats;
 *   new_coins integer;
 *   new_tickets integer;
 *   new_exp integer;
 *   new_games integer;
 * BEGIN
 *   SELECT * INTO current_stats
 *   FROM user_stats
 *   WHERE user_id = NEW.user_id
 *   FOR UPDATE;
 *
 *   IF NOT FOUND THEN
 *     INSERT INTO user_stats (user_id, coins, tickets, exp, games_played)
 *     VALUES (NEW.user_id, 0, 0, 0, 0)
 *     ON CONFLICT (user_id) DO NOTHING;
 *
 *     SELECT * INTO current_stats
 *     FROM user_stats
 *     WHERE user_id = NEW.user_id
 *     FOR UPDATE;
 *   END IF;
 *
 *   new_coins   := GREATEST(0, LEAST(5000, current_stats.coins + NEW.amount));
 *   new_tickets := GREATEST(0, current_stats.tickets + NEW.tickets_delta);
 *   new_exp     := GREATEST(0, current_stats.exp + NEW.exp_delta);
 *   new_games   := GREATEST(0, current_stats.games_played + NEW.plays_delta);
 *
 *   UPDATE user_stats
 *   SET coins        = new_coins,
 *       tickets      = new_tickets,
 *       exp          = new_exp,
 *       games_played = new_games,
 *       updated_at   = now()
 *   WHERE user_id = NEW.user_id;
 *
 *   NEW.balance_after := new_coins;
 *   RETURN NEW;
 * END;
 * $$ LANGUAGE plpgsql;
 *
 * CREATE TRIGGER trigger_user_stats_from_transactions
 * AFTER INSERT ON transactions
 * FOR EACH ROW
 * EXECUTE FUNCTION apply_wallet_transaction();
 *
 *
 * 5. API Contract (클라이언트 관점 정리)
 * --------------------------------------
 * - 요청:
 *     POST /api/wallet
 *     Content-Type: application/json
 *     Credentials: include (중요! 세션 쿠키 → X-User-Id 로 변환)
 *
 *   Body 예시:
 *     // 지갑 동기화
 *     { "action": "SYNC" }
 *     { "action": "SYNCWALLET" }
 *
 *     // 게임 보상 적립
 *     {
 *       "action": "ADD_REWARD",
 *       "reward": 120,
 *       "score": 12345,
 *       "tier": "bronze",
 *       "level": 3,
 *       "reason": "tetris_clear",
 *       "game": "tetris",
 *       "meta": { "stage": 2 }
 *     }
 *
 * - 응답 (성공):
 *     {
 *       ok: true,
 *       balance: number,   // 코인/포인트
 *       tickets: number,   // 티켓 수
 *       playCount: number, // 총 플레이 횟수
 *       exp: number        // 경험치
 *     }
 *
 * - 에러 응답:
 *   - INVALID_USER (HTTP 400)
 *     {
 *       ok: false,
 *       error: "INVALID_USER",
 *       message: "유효하지 않은 사용자 식별자"
 *     }
 *
 *   - UNSUPPORTED_ACTION (HTTP 400)
 *     {
 *       ok: false,
 *       error: "UNSUPPORTED_ACTION",
 *       message: "지원하지 않는 action 입니다."
 *     }
 *
 *   - SERVER_ERROR (HTTP 500)
 *     {
 *       ok: false,
 *       error: "SERVER_ERROR",
 *       message: "Wallet 처리 중 서버 오류가 발생했습니다."
 *     }
 *
 *
 * 6. 유지보수 시 주의할 점
 * ------------------------
 * - badRequest 를 다시 외부 모듈에서 import 하도록 바꾸려면,
 *   `_utils/json.ts` 에 해당 export 가 실제로 존재하는지 반드시 확인해야 한다.
 *   현재 구조에서는 로컬 badRequest 헬퍼만 사용하는 것이 가장 안전하다.
 *
 * - wallet 의 비즈니스 규칙(10회마다 티켓 +1, balance cap 5000 등)을 바꾸고 싶다면,
 *   buildGameRewardDelta 내부 로직을 수정하면 된다.
 *
 * - user_stats / transactions 스키마가 바뀐다면:
 *     * getWalletSnapshot 의 SELECT / INSERT 문을 수정해야 한다.
 *     * WalletSnapshot 타입도 함께 갱신해야 한다.
 *     * applyGameReward 에서 INSERT 하는 컬럼 목록도 맞춰야 한다.
 *
 * - DB 트리거(apply_wallet_transaction)를 수정할 때:
 *     * amount, exp_delta, tickets_delta, plays_delta 를 활용하여
 *       user_stats.coins, user_stats.exp, user_stats.tickets,
 *       user_stats.games_played 를 어떻게 업데이트할지 명확히 정의해야 한다.
 *     * balance_after 컬럼을 사용하는 경우, 트리거에서 NEW.balance_after 에
 *       최종 코인 값을 기록하도록 구현할 수 있다.
 *
 * - 로컬 개발 시:
 *     * `wrangler pages dev public --local` 또는 레포 설정에 맞는
 *       dev 명령을 사용해 /api/wallet 을 직접 호출해 볼 수 있다.
 *     * 브라우저 콘솔이나 네트워크 탭에서 요청/응답을 확인하여
 *       action, reward, game, 쿠키/헤더 등이 제대로 전달되는지 검증하는 것이 좋다.
 *
 * - 클라이언트에서 exp 를 활용하려면:
 *     * SYNC 응답의 exp 값을 받아 UI 에 표시하거나, 레벨업 계산에 사용할 수 있다.
 *     * 게임별 경험치 규칙을 세밀하게 조정하고 싶다면, buildGameRewardDelta 에
 *       game / tier / level 에 따른 가중치를 추가하는 방식으로 확장하면 된다.
 *
 *
 * 7. 향후 확장 아이디어
 * ---------------------
 * - 추가 action:
 *     * RESET         : 개발용/테스트용으로 특정 유저의 stats 를 초기화
 *     * ADMIN_ADJUST  : 관리자 콘솔에서 amount/exp/tickets 를 수동 조정
 *     * REWARD_BATCH  : 여러 게임 결과를 한 번에 반영
 *
 *   이런 action 은 별도의 분기에서 delta 를 계산하고, type='admin'/'system'
 *   등으로 transactions 에 기록하면 된다.
 *
 * - 멀티 게임/플랫폼 확장:
 *     * game 필드는 최대 64자로 제한하고, 별도의 games 테이블을 두어
 *       메타 정보를 관리할 수 있다.
 *     * meta JSON 에 클라이언트 버전, 플랫폼(iOS/Android/Web) 등도 함께
 *       저장하면 디버깅/분석에 도움이 된다.
 *
 * - 분석/리포트:
 *     * transactions 를 기반으로 게임별 평균 보상, 유저별 LTV/Retention 등
 *       분석 쿼리를 만들 수 있다.
 *     * user_stats.exp 와 games_played 를 조합해서 레벨 시스템을 설계할 수 있다.
 *
 *
 * 이 파일은 “회원가입 유저 정보(유저 가입 정보, 게임 플레이로 얻은 경험치,
 * 포인트, 티켓 등) 인식, 식별, 계정 반영 정상 작동”을 목표로 하는
 * 최종 통합 버전 wallet API 구현이며, user_stats + transactions + 트리거 구조에
 * 맞춰 풀 체인이 완성되도록 설계된 C안 구현 + 유저 식별 A/B 정렬 버전이다.
 */
