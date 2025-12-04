/**
 * functions/api/wallet/reward.ts
 * ───────────────────────────────────────────────────────────────
 * Retro Games – Reward API (Ultimate Version)
 *
 * ✔ 게임별 보상 자동 계산 (game_rewards.json)
 * ✔ EXP 레벨 커브 자동 적용 (level_curve.json)
 * ✔ 부정 플레이 방지용 SHA-256 해시 검증
 * ✔ user_progress / wallet_balances / wallet_tx 완전 통합
 * ✔ Cloudflare Pages Functions 형식 완전 유지
 * ✔ 기존 구성/배치/디자인/기능 100% 보존
 * ───────────────────────────────────────────────────────────────
 */

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env } = ctx;

  // Only POST allowed
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Only POST supported" }),
      { status: 405 }
    );
  }

  // Parse JSON safely
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    return jsonErr("Invalid JSON body");
  }

  // Extract input values
  const userId = String(body.userId || "").trim();
  const gameId = String(body.game || "").trim() || "unknown";
  const reason = String(body.reason || "reward");

  // Client provided deltas (optional / can be overridden by game rules)
  const clientExp = Number(body.exp || 0);
  const clientTickets = Number(body.tickets || 0);
  const clientPoints = Number(body.points || 0);

  // Anti-Cheat Hash Validation
  const providedHash = String(body.hash || "");
  const secretKey = env.REWARD_SECRET_KEY || "";
  const rawPayload = `${userId}|${gameId}|${clientExp}|${clientTickets}|${clientPoints}|${secretKey}`;
  const calculatedHash = await sha256(rawPayload);

  if (!secretKey) {
    return jsonErr("Missing server REWARD_SECRET_KEY", 500);
  }
  if (!providedHash) {
    return jsonErr("Missing reward hash");
  }
  if (providedHash !== calculatedHash) {
    return jsonErr("Hash mismatch – reward rejected (anti-cheat)");
  }

  if (!userId) return jsonErr("Missing userId");
  if (!gameId) return jsonErr("Missing game");

  // Ensure no negative values
  if (clientExp < 0 || clientTickets < 0 || clientPoints < 0) {
    return jsonErr("Values must not be negative");
  }

  // Load Game Reward Table
  const gameRewards = await loadJson(env, "game_rewards.json");
  const levelCurve = await loadJson(env, "level_curve.json");

  if (!gameRewards[gameId]) {
    return jsonErr(`No reward table defined for game: ${gameId}`);
  }

  // Auto-calculated reward from rules + client suggestion
  const rule = gameRewards[gameId];

  // Final reward calculation
  const finalExp = clientExp > 0 ? clientExp : rule.exp || 0;
  const finalTickets = clientTickets > 0 ? clientTickets : rule.tickets || 0;
  const finalPoints = clientPoints > 0 ? clientPoints : rule.points || 0;

  // SQL Connection
  const sql = env.DB;
  const cx = await sql.begin();

  try {
    // Ensure user_progress table
    await cx.run(`
      create table if not exists user_progress (
        user_id text primary key,
        exp bigint default 0,
        level int default 1,
        tickets bigint default 0,
        updated_at timestamptz default now()
      );
    `);

    // Current data
    const cur = await cx.get<{
      exp: number;
      level: number;
      tickets: number;
    }>(`select exp, level, tickets from user_progress where user_id = ?`, [
      userId,
    ]);

    let newExp = (cur?.exp || 0) + finalExp;
    let newTickets = (cur?.tickets || 0) + finalTickets;
    let newLevel = calcLevel(newExp, levelCurve);

    // Upsert user_progress
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
      [userId, newExp, newLevel, newTickets]
    );

    // Wallet balance table
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

    const newBalance = (curBal?.balance || 0) + finalPoints;

    await cx.run(
      `
      insert into wallet_balances(user_id, balance)
      values(?,?)
      on conflict(user_id)
      do update set balance = excluded.balance
      `,
      [userId, newBalance]
    );

    // Wallet TX log
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

    if (finalPoints > 0) {
      await cx.run(
        `
        insert into wallet_tx(user_id, amount, reason, game_id)
        values(?, ?, ?, ?)
        `,
        [userId, finalPoints, reason, gameId]
      );
    }

    await cx.commit();

    return jsonOK({
      userId,
      game: gameId,
      progress: {
        exp: newExp,
        level: newLevel,
        tickets: newTickets,
      },
      wallet: {
        balance: newBalance,
      },
      reward: {
        exp: finalExp,
        tickets: finalTickets,
        points: finalPoints,
      },
    });
  } catch (err: any) {
    await cx.rollback();
    return jsonErr("DB Error", 500, err?.message);
  }
};

/* ───────────────────────────────────────────────
 * Helper: JSON OK Response
 * ───────────────────────────────────────────────*/
function jsonOK(obj: any) {
  return new Response(JSON.stringify({ success: true, ...obj }), {
    headers: { "Content-Type": "application/json" },
  });
}

/* ───────────────────────────────────────────────
 * Helper: JSON Error Response
 * ───────────────────────────────────────────────*/
function jsonErr(msg: string, code: number = 400, detail: any = null) {
  return new Response(
    JSON.stringify({
      success: false,
      error: msg,
      detail,
    }),
    {
      status: code,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/* ───────────────────────────────────────────────
 * SHA-256 Hashing (Anti-Cheat)
 * ───────────────────────────────────────────────*/
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ───────────────────────────────────────────────
 * Load JSON file from the /api/_utils folder
 * ───────────────────────────────────────────────*/
async function loadJson(env: any, file: string) {
  try {
    const data = await env.ASSETS.fetch(`/functions/api/_utils/${file}`);
    return await data.json();
  } catch {
    return {};
  }
}

/* ───────────────────────────────────────────────
 * EXP Level Curve
 * level_curve.json example:
 * {
 *   "1": 0,
 *   "2": 100,
 *   "3": 300,
 *   "4": 700,
 *   "5": 1500
 * }
 * ───────────────────────────────────────────────*/
function calcLevel(exp: number, curve: any) {
  let level = 1;
  for (const lv of Object.keys(curve)) {
    const need = Number(curve[lv]);
    if (exp >= need) level = Number(lv);
  }
  return level;
}
