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
 *
 * [중요]
 *  - 이 파일은 `functions/api/wallet.ts` 경로에 있으며,
 *    보조 유틸들은 같은 디렉터리 내부의 `./_utils/...` 아래에 존재해야 한다.
 *  - VSCode 에서 TS2307(Cannot find module '../_utils/...') 가 발생했다면
 *    상대경로가 한 단계 위(`../`)를 바라보고 있기 때문이며,
 *    반드시 `./_utils/...` 형태로 맞춰야 한다.
 */

import type { Env } from "./_utils/db";
import { getSql } from "./_utils/db";
import { json, badRequest } from "./_utils/json";
import { cleanUserId } from "./_utils/schema/wallet";

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

/**
 * POST /api/wallet
 *
 * Body 예시:
 *  { "action": "SYNC" }
 *  { "action": "SYNCWALLET" }
 *  { "action": "ADD_REWARD",     "reward": 120, ... }
 *  { "action": "ADDGAMEREWARD",  "reward": 120, ... }
 */
export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  const { request, env } = context;

  try {
    // --- 1) User identification (middleware가 넣어주는 헤더)
    const userIdHeader = request.headers.get("X-User-Id") || "";
    const userId = cleanUserId(userIdHeader);

    if (!userId) {
      // _utils/json 의 badRequest 사용 (Response 를 다시 json에 넣지 않도록 주의)
      return badRequest({
        ok: false,
        error: "INVALID_USER",
        message: "유효하지 않은 사용자 식별자",
      });
    }

    // --- 2) Body 파싱
    const body: any =
      (await request
        .json()
        .catch(() => ({}))) || {};

    const action = String(body.action || "").toUpperCase();

    // --- 3) ACTION SWITCH

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

    // --- 지원하지 않는 action
    return badRequest({
      ok: false,
      error: "UNSUPPORTED_ACTION",
      message: "지원하지 않는 action 입니다.",
    });
  } catch (err: any) {
    console.error("[wallet.ts] error", err);

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
