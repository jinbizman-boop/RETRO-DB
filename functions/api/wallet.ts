/**
 * Unified Wallet API Adapter for Retro Games
 * ------------------------------------------
 * 클라이언트(게임 페이지)는 `/api/wallet` 로 POST 요청하고
 * body.action 값으로 동작을 나눈다.
 *
 * 지원 action:
 *  - SYNC      → 현재 사용자 wallet 상태 조회
 *  - ADD_REWARD → 게임 보상(포인트/티켓/플레이카운트) 반영
 *
 * ※ 기존 wallet/balance.ts, wallet/transaction.ts 와 100% 호환됨
 * ※ _middleware.ts 가 유저 식별(X-User-Id) 헤더를 자동 주입해야 정상동작
 */

import { Env } from "../_utils/env";
import { json } from "../_utils/response";
import { hardValidateUserId } from "../_utils/validate";
import { neon } from "../_utils/db";

// 기존 REST 핸들러 로직을 내부용 함수형으로 재사용하기 위해 가져올 수도 있음.
// 하지만 프로젝트 구조가 제각각이라 여기서는 “직접 완전 구현”해둔다.
// (→ balance.ts / transaction.ts 안의 Neon 쿼리와 동일한 로직)

async function getWalletSnapshot(env: Env, userId: string) {
  const sql = neon(env);

  // user_wallet (포인트/티켓/플레이카운트)
  const rows = await sql`
    SELECT balance, tickets, play_count
    FROM user_wallet
    WHERE user_id = ${userId}
    LIMIT 1
  `;

  if (!rows.length) {
    // 없다면 생성
    await sql`
      INSERT INTO user_wallet (user_id, balance, tickets, play_count)
      VALUES (${userId}, 0, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `;

    return { balance: 0, tickets: 0, playCount: 0 };
  }

  return {
    balance: rows[0].balance || 0,
    tickets: rows[0].tickets || 0,
    playCount: rows[0].play_count || 0
  };
}

async function applyGameReward(
  env: Env,
  userId: string,
  payload: {
    reward?: number;
    score?: number;
    tier?: string;
    level?: number;
    reason?: string;
    meta?: any;
  }
) {
  const sql = neon(env);

  const reward = payload.reward || 0;
  const reason = payload.reason || "game_reward";
  const meta = payload.meta || {};
  const score = payload.score || 0;

  // playCount 증가
  await sql`
    UPDATE user_wallet
    SET play_count = play_count + 1
    WHERE user_id = ${userId}
  `;

  // 10번마다 티켓 1개
  const walletNow = await getWalletSnapshot(env, userId);
  let newTickets = walletNow.tickets;

  const nextPlay = walletNow.playCount + 1;
  if (nextPlay % 10 === 0) {
    newTickets += 1;
  }

  // 포인트 증가 (최대 5000 cap 지원)
  let newBalance = walletNow.balance + reward;
  if (newBalance > 5000) newBalance = 5000;

  // 업데이트
  await sql`
    UPDATE user_wallet
    SET balance = ${newBalance},
        tickets = ${newTickets},
        play_count = ${nextPlay}
    WHERE user_id = ${userId}
  `;

  // transaction log 기록
  await sql`
    INSERT INTO wallet_transaction (user_id, amount, reason, meta)
    VALUES (${userId}, ${reward}, ${reason}, ${meta})
  `;

  // 최신 스냅샷 리턴
  return {
    balance: newBalance,
    tickets: newTickets,
    playCount: nextPlay
  };
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}) {
  try {
    const { request, env } = context;

    // --- 1) User identification (middleware가 넣어주는 헤더)
    const userId = request.headers.get("X-User-Id") || "";
    if (!hardValidateUserId(userId)) {
      return json({ ok: false, error: "INVALID_USER" }, 400);
    }

    // --- 2) Body 파싱
    const body = await request.json().catch(() => ({}));
    const action = (body.action || "").toUpperCase();

    // --- 3) ACTION SWITCH
    if (action === "SYNC" || action === "SYNCWALLET") {
      const snap = await getWalletSnapshot(env, userId);

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount
      });
    }

    if (action === "ADD_REWARD" || action === "ADDGAMEREWARD") {
      const snap = await applyGameReward(env, userId, {
        reward: body.reward,
        score: body.score,
        level: body.level,
        tier: body.tier,
        reason: body.reason,
        meta: body.meta
      });

      return json({
        ok: true,
        balance: snap.balance,
        tickets: snap.tickets,
        playCount: snap.playCount
      });
    }

    // --- Unknown action
    return json({ ok: false, error: "UNSUPPORTED_ACTION" }, 400);

  } catch (err: any) {
    console.error("[wallet.ts] error", err);
    return json({ ok: false, error: "SERVER_ERROR" }, 500);
  }
}
