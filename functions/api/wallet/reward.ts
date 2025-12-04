// functions/api/wallet/reward.ts
// ───────────────────────────────────────────────────────────────
// Retro Games – Reward API
//
// ▶ 역할
// - 게임 플레이 후 지급되는 “경험치 / 티켓 / 포인트(balance)”를 계정에 반영
// - user_progress(exp, level, tickets) 업데이트
// - wallet_balances(balance) 업데이트
// - wallet_tx 보상 지급 로그 기록
//
// ▶ 외부 계약(API Request)
//   POST /api/wallet/reward
//   Content-Type: application/json
//   {
//     "userId": "uuid",
//     "exp": number,         // optional, default 0
//     "tickets": number,     // optional, default 0
//     "points": number,      // optional, default 0   ← balance
//     "game": "2048",        // optional
//     "reason": "reward"     // optional
//   }
//
// ▶ 반환
//   {
//     success: true,
//     progress: {...},
//     wallet: {...}
//   }
//
// ───────────────────────────────────────────────────────────────

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env } = ctx;

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Only POST supported" }),
      { status: 405 }
    );
  }

  // JSON 파싱
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({
      success: false,
      error: "Invalid JSON body"
    }), { status: 400 });
  }

  // 입력값 추출
  const userId = String(body.userId || "").trim();
  const expDelta = Number(body.exp || 0);
  const ticketDelta = Number(body.tickets || 0);
  const pointDelta = Number(body.points || 0);
  const gameId = String(body.game || "game").trim();
  const reason = String(body.reason || "reward").trim();

  // 기본 검증
  if (!userId) {
    return new Response(JSON.stringify({
      success: false,
      error: "Missing userId"
    }), { status: 400 });
  }

  if (!Number.isFinite(expDelta) || !Number.isFinite(ticketDelta) || !Number.isFinite(pointDelta)) {
    return new Response(JSON.stringify({
      success: false,
      error: "Bad numeric value"
    }), { status: 400 });
  }

  if (expDelta < 0 || ticketDelta < 0 || pointDelta < 0) {
    return new Response(JSON.stringify({
      success: false,
      error: "Reward deltas must be >= 0"
    }), { status: 400 });
  }

  // SQL 커넥션
  const sql = env.DB;

  // 트랜잭션 시작
  const cx = await sql.begin();

  try {
    // ───────────────────────────────────────────────
    // 1) user_progress 생성/업데이트
    // ───────────────────────────────────────────────
    await cx.run(`
      create table if not exists user_progress (
        user_id text primary key,
        exp bigint default 0,
        level int default 1,
        tickets bigint default 0,
        updated_at timestamptz default now()
      );
    `);

    // 현재 값 조회
    const cur = await cx.get<
      { exp: number; level: number; tickets: number }
    >(
      `select exp, level, tickets from user_progress where user_id = ?`,
      [userId]
    );

    let newExp = (cur?.exp || 0) + expDelta;
    let newTickets = (cur?.tickets || 0) + ticketDelta;
    let level = cur?.level || 1;

    // ───────────────────────────────────────────────
    // 1-1) 레벨업 계산식 (EXP 기반)
    //     예: LV1→LV2=100exp, LV2→LV3=300exp 등 성장 커브 적용 가능
    // ───────────────────────────────────────────────
    const calcLevel = (exp: number) => {
      // 간단한 성장 함수(원하면 제작해둔 테이블 기반 EXP 커브도 적용 가능)
      if (exp < 100) return 1;
      if (exp < 300) return 2;
      if (exp < 700) return 3;
      if (exp < 1500) return 4;
      if (exp < 3000) return 5;
      return Math.floor(1 + Math.log2(exp / 200 + 1));
    };

    level = calcLevel(newExp);

    // 업서트
    await cx.run(
      `
      insert into user_progress(user_id, exp, level, tickets)
      values(?, ?, ?, ?)
      on conflict(user_id)
      do update set
        exp = excluded.exp,
        level = excluded.level,
        tickets = excluded.tickets,
        updated_at = now()
      `,
      [userId, newExp, level, newTickets]
    );

    // ───────────────────────────────────────────────
    // 2) wallet_balances 업데이트 (points → balance)
    // ───────────────────────────────────────────────

    await cx.run(`
      create table if not exists wallet_balances (
        user_id text primary key,
        balance bigint default 0
      );
    `);

    const curBal = await cx.get<{ balance: number }>(
      `select balance from wallet_balances where user_id = ?`,
      [userId]
    );

    const newBalance = (curBal?.balance || 0) + pointDelta;

    await cx.run(
      `
      insert into wallet_balances(user_id, balance)
      values(?, ?)
      on conflict(user_id)
      do update set balance = excluded.balance
      `,
      [userId, newBalance]
    );

    // ───────────────────────────────────────────────
    // 3) wallet_tx 보상 지급 로그 기록
    // ───────────────────────────────────────────────

    await cx.run(`
      create table if not exists wallet_tx (
        id uuid primary key default gen_random_uuid(),
        user_id text not null,
        amount bigint not null,
        reason text default 'reward',
        game_id text default '',
        created_at timestamptz default now()
      );
    `);

    if (pointDelta > 0) {
      await cx.run(
        `
        insert into wallet_tx(user_id, amount, reason, game_id)
        values(?, ?, ?, ?)
        `,
        [userId, pointDelta, reason, gameId]
      );
    }

    // ───────────────────────────────────────────────
    // 커밋
    // ───────────────────────────────────────────────
    await cx.commit();

    // 결과 반환
    return new Response(
      JSON.stringify({
        success: true,
        progress: {
          exp: newExp,
          level,
          tickets: newTickets
        },
        wallet: {
          balance: newBalance
        }
      }),
      { status: 200 }
    );
  } catch (err) {
    await cx.rollback();
    return new Response(
      JSON.stringify({
        success: false,
        error: "DB error",
        detail: String(err)
      }),
      { status: 500 }
    );
  }
};
