/**
 * Unified Wallet API Adapter for Retro Games
 * ------------------------------------------
 * 클라이언트(게임 페이지)는 `/api/wallet` 로 POST 요청하고
 * body.action 값으로 동작을 나눈다.
 *
 * 지원 action:
 *  - SYNC / SYNCWALLET           → 현재 사용자 wallet 상태 조회
 *  - ADD_REWARD / ADDGAMEREWARD  → 게임 보상(포인트/티켓/플레이카운트) 반영
 *
 * ※ 기존 wallet/balance.ts, wallet/transaction.ts 와 논리 호환
 * ※ _middleware.ts 가 유저 식별(X-User-Id) 헤더를 자동 주입해야 정상동작
 */

import type { Env } from "./_utils/db";
import { getSql } from "./_utils/db";
import { json } from "./_utils/json";

/* ------------------------------------------------------------------ */
/*  UserId Helper                                                      */
/* ------------------------------------------------------------------ */

/**
 * X-User-Id 헤더 값 정규화 + 검증
 *
 * - null/undefined → "" (무효)
 * - 앞뒤 공백 제거
 * - 너무 긴 값(128자 초과) → 무효
 * - 허용 문자:
 *    알파벳, 숫자, 언더바, 하이픈, @, ., :
 *
 * 이 함수에서 "" 를 반환하면 "INVALID_USER" 로 처리한다.
 */
function cleanUserId(raw: string | null): string {
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

/* ------------------------------------------------------------------ */
/*  Local badRequest Helper                                           */
/* ------------------------------------------------------------------ */

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
 */
function badRequest(body: unknown): Response {
  // _utils/json 의 시그니처: json(body, init?)
  return json(body, { status: 400 });
}

/* ------------------------------------------------------------------ */
/*  타입 정의                                                          */
/* ------------------------------------------------------------------ */

/** DB에서 읽어오는 wallet 스냅샷 타입 */
type WalletSnapshot = {
  balance: number;
  tickets: number;
  playCount: number;
};

/** 게임에서 보내는 보상 payload 타입 */
type RewardPayload = {
  reward?: number;
  score?: number;
  tier?: string;
  level?: number;
  reason?: string;
  meta?: any;
};

/** 클라이언트에서 오는 action 문자열 정규화 */
function normalizeAction(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Core Query Helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * user_wallet 테이블에서 현재 상태를 조회하고,
 * 없으면 (user_id,0,0,0) 레코드를 생성한 뒤 스냅샷을 반환한다.
 */
async function getWalletSnapshot(env: Env, userId: string): Promise<WalletSnapshot> {
  const sql = getSql(env);

  const rows = await sql<{
    balance: number | null;
    tickets: number | null;
    play_count: number | null;
  }>`
    SELECT balance, tickets, play_count
    FROM user_wallet
    WHERE user_id = ${userId}
    LIMIT 1
  `;

  if (!rows.length) {
    // 없다면 신규 생성 (중복 방지 ON CONFLICT)
    await sql`
      INSERT INTO user_wallet (user_id, balance, tickets, play_count)
      VALUES (${userId}, 0, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `;

    return { balance: 0, tickets: 0, playCount: 0 };
  }

  const row = rows[0];

  return {
    balance: row.balance ?? 0,
    tickets: row.tickets ?? 0,
    playCount: row.play_count ?? 0,
  };
}

/**
 * 게임 보상(포인트/티켓/플레이카운트)을 wallet에 반영.
 *
 * 규칙:
 * - playCount: 1 증가
 * - 10회마다 tickets +1
 * - balance: reward 만큼 증가 (최대 5,000 cap, 음수 방지)
 * - wallet_transaction 로그 기록
 */
async function applyGameReward(
  env: Env,
  userId: string,
  payload: RewardPayload
): Promise<WalletSnapshot> {
  const sql = getSql(env);

  // NaN / undefined / null 을 모두 0 으로 안전 처리
  const reward = Number.isFinite(payload.reward as number)
    ? (payload.reward as number)
    : 0;

  const reason = (payload.reason || "game_reward").slice(0, 80);
  const meta = payload.meta || {};

  const score = Number.isFinite(payload.score as number)
    ? (payload.score as number)
    : 0;

  // 현재 스냅샷 기준으로 계산
  const walletNow = await getWalletSnapshot(env, userId);
  const nextPlay = walletNow.playCount + 1;

  // 10번마다 티켓 1개
  let newTickets = walletNow.tickets;
  if (nextPlay % 10 === 0) {
    newTickets += 1;
  }

  // 포인트 증가 (최대 5000 cap 지원 + 음수 보호)
  let newBalance = walletNow.balance + reward;
  if (newBalance > 5000) newBalance = 5000;
  if (newBalance < 0) newBalance = 0;

  // wallet 업데이트
  await sql`
    UPDATE user_wallet
    SET balance    = ${newBalance},
        tickets    = ${newTickets},
        play_count = ${nextPlay}
    WHERE user_id  = ${userId}
  `;

  // transaction log 기록
  const metaJson = JSON.stringify({
    ...meta,
    score,
    tier: payload.tier || null,
    level: payload.level ?? null,
  });

  await sql`
    INSERT INTO wallet_transaction (user_id, amount, reason, meta)
    VALUES (${userId}, ${reward}, ${reason}, ${metaJson})
  `;

  // 최신 스냅샷 리턴
  return {
    balance: newBalance,
    tickets: newTickets,
    playCount: nextPlay,
  };
}

/* ------------------------------------------------------------------ */
/*  Request Handler                                                    */
/* ------------------------------------------------------------------ */

/**
 * POST /api/wallet
 *
 * Body 예시:
 *  { "action": "SYNC" }
 *  { "action": "SYNCWALLET" }
 *  { "action": "ADD_REWARD",     "reward": 120, ... }
 *  { "action": "ADDGAMEREWARD",  "reward": 120, ... }
 *
 * 클라이언트에서는 항상 credentials: "include" 로 호출하여
 * _middleware.ts 가 부여하는 X-User-Id 헤더를 함께 전달해야 한다.
 */
export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  const { request, env } = context;

  try {
    /* -------------------------------------------------------------- */
    /* 1) User identification                                         */
    /* -------------------------------------------------------------- */

    // _middleware.ts 에서 세션/쿠키 기반으로 넣어주는 헤더
    const userIdHeader = request.headers.get("X-User-Id");
    const userId = cleanUserId(userIdHeader);

    if (!userId) {
      // ❗ 기존에는 json(..., {status:400})을 직접 호출했지만,
      //    이제는 로컬 badRequest() 헬퍼를 사용해서 패턴을 통일한다.
      return badRequest({
        ok: false,
        error: "INVALID_USER",
        message: "유효하지 않은 사용자 식별자",
      });
    }

    /* -------------------------------------------------------------- */
    /* 2) Body 파싱                                                    */
    /* -------------------------------------------------------------- */

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

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount,
      });
    }

    // 3-2. 게임 보상 적립
    if (action === "ADD_REWARD" || action === "ADDGAMEREWARD") {
      const snap = await applyGameReward(env, userId, {
        reward: body.reward,
        score: body.score,
        level: body.level,
        tier: body.tier,
        reason: body.reason,
        meta: body.meta,
      });

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount,
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

/* ------------------------------------------------------------------ */
/*  Implementation Notes (for maintainers)                             */
/* ------------------------------------------------------------------ */
/**
 * 1. Cloudflare Pages / Wrangler 빌드 안정성
 * -----------------------------------------
 * - 과거 빌드 실패 원인은 `_utils/json.ts` 에 존재하지 않는
 *   `badRequest` export 를 import 하면서 발생했다.
 *
 *   예전 코드:
 *     import { json, badRequest } from "./_utils/json";
 *
 * - 이 파일에서는 badRequest 를 외부에서 가져오지 않고,
 *   내부 로컬 헬퍼로 구현했다.
 *   → Cloudflare 번들러가 `_utils/json.ts` 에서 없는 export 를
 *     찾으려고 하지 않기 때문에 빌드 에러가 사라진다.
 *
 * - json() 헬퍼는 그대로 사용하므로, 응답 포맷/헤더/동작은 기존과 동일하다.
 *
 *
 * 2. UserId 처리 흐름
 * -------------------
 * - `_middleware.ts` 에서 세션/쿠키 기반으로 X-User-Id 를 헤더에 넣어준다.
 * - 이 파일에서는 `cleanUserId()` 를 통해:
 *     * null/undefined → "" (무효)
 *     * 앞뒤 공백 제거
 *     * 허용되지 않는 문자 포함 시 "" 반환
 *     * 128자 초과 시 "" 반환
 * - 결국 onRequestPost 안에서는:
 *     const userIdHeader = request.headers.get("X-User-Id");
 *     const userId = cleanUserId(userIdHeader);
 *     if (!userId) { return badRequest({ ...INVALID_USER... }); }
 *
 *   이런 패턴으로, 잘못된/누락된 유저 식별자는 일관되게 400 처리된다.
 *
 *
 * 3. Wallet 동작 규칙 (비즈니스 로직)
 * ----------------------------------
 * - user_wallet:
 *     balance   : 포인트
 *     tickets   : 티켓 수
 *     play_count: 플레이 횟수
 *
 * - SYNC / SYNCWALLET:
 *     → 현재 값 그대로 반환.
 *     → user_wallet 에 레코드가 없으면 (user_id,0,0,0) 신규 생성 후 {0,0,0} 반환.
 *
 * - ADD_REWARD / ADDGAMEREWARD:
 *     - reward 가 NaN / undefined / null 이면 0 처리.
 *     - play_count: 기존 값 + 1
 *     - tickets: play_count 가 10, 20, 30 ... 일 때마다 +1
 *     - balance: reward 만큼 증가하되, [0, 5000] 범위를 벗어나지 않도록 clamp
 *     - wallet_transaction:
 *         (user_id, amount=reward, reason, metaJson) 기록
 *         metaJson 은 score/tier/level 등을 포함한 JSON 문자열
 *     - 최종적으로 갱신된 balance/tickets/playCount 반환.
 *
 *
 * 4. API Contract (클라이언트 관점)
 * ---------------------------------
 * - 요청:
 *     POST /api/wallet
 *     Content-Type: application/json
 *     Credentials: include (중요! 세션 쿠키 → X-User-Id 로 변환)
 *
 *   Body 예시:
 *     { "action": "SYNC" }
 *     { "action": "ADD_REWARD", "reward": 120, "score": 9999, ... }
 *
 * - 응답 (성공):
 *     {
 *       ok: true,
 *       balance: number,
 *       tickets: number,
 *       playCount: number
 *     }
 *
 * - 응답 (에러 예시):
 *     // INVALID_USER
 *     {
 *       ok: false,
 *       error: "INVALID_USER",
 *       message: "유효하지 않은 사용자 식별자"
 *     }
 *
 *     // UNSUPPORTED_ACTION
 *     {
 *       ok: false,
 *       error: "UNSUPPORTED_ACTION",
 *       message: "지원하지 않는 action 입니다."
 *     }
 *
 *     // SERVER_ERROR (HTTP 500)
 *     {
 *       ok: false,
 *       error: "SERVER_ERROR",
 *       message: "Wallet 처리 중 서버 오류가 발생했습니다."
 *     }
 *
 *
 * 5. 다른 함수/파일과의 관계
 * ---------------------------
 * - `_utils/db.ts`:
 *     - Env 타입과 getSql(env) 헬퍼를 제공.
 *     - getSql(env) 는 neon 인스턴스를 반환한다고 가정.
 *
 * - `_middleware.ts`:
 *     - 세션을 기반으로 유저를 식별하고, X-User-Id 헤더에 넣는 역할.
 *     - 이 파일은 X-User-Id 만 신뢰하고 있으며, 세션 상세 구조는 모른다.
 *
 * - 게임 클라이언트 (예: tetris.html, retro-running.html 등):
 *     - SYNC / ADD_REWARD 호출 시 항상 credentials: "include" 로 호출해야
 *       middleware → wallet → DB 흐름이 끝까지 연결된다.
 *
 *
 * 6. 유지보수 시 주의할 점
 * ------------------------
 * - badRequest 를 다시 외부 모듈에서 import 하도록 바꾸면,
 *   `_utils/json.ts` 에 해당 export 가 실제로 존재하는지 반드시 확인해야 한다.
 *
 * - wallet 의 비즈니스 규칙(10회마다 티켓 +1, balance cap 5000 등)을 바꾸고 싶다면,
 *   applyGameReward 내부만 수정하면 된다.
 *
 * - user_wallet 스키마가 바뀐다면:
 *     * SELECT / INSERT / UPDATE 문을 동시에 수정해야 한다.
 *     * WalletSnapshot 타입도 함께 갱신해야 한다.
 *
 * - 배포 과정에서 이 파일 빌드 에러가 나면,
 *   Cloudflare 로그에 `api/wallet.ts` 관련 메시지가 다시 나올 것이므로
 *   항상 최신 에러 로그를 확인해서 수정하면 된다.
 */
