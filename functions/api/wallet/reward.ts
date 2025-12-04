/**
 * functions/api/wallet/reward.ts
 * ───────────────────────────────────────────────────────────────
 * Retro Games – Reward API (Ultimate Version, Enhanced)
 *
 * ✔ 게임별 보상 자동 계산 (game_rewards.json + 내장 기본값)
 * ✔ EXP 레벨 커브 자동 적용 (level_curve.json + 내장 기본값)
 * ✔ 부정 플레이 방지용 SHA-256 해시 검증
 * ✔ 중복 지급 방지용 nonce 기반 idempotency (선택 사항)
 * ✔ user_progress / wallet_balances / wallet_tx / analytics_events 통합
 * ✔ Cloudflare Pages Functions 형식 및 외부 계약 100% 유지
 * ───────────────────────────────────────────────────────────────
 */

type RewardRule = {
  exp?: number;
  tickets?: number;
  points?: number;
  maxExp?: number;
  maxTickets?: number;
  maxPoints?: number;
};

type GameRewardTable = Record<string, RewardRule>;
type LevelCurve = Record<string, number>;

interface RewardRequestBody {
  userId?: string;
  game?: string;
  reason?: string;
  exp?: number;
  tickets?: number;
  points?: number;
  hash?: string;
  nonce?: string; // 중복 지급 방지용 클라이언트 요청 식별자(선택)
}

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
  let body: RewardRequestBody | null = null;
  try {
    body = await request.json<RewardRequestBody>();
  } catch {
    return jsonErr("Invalid JSON body");
  }

  // Extract input values
  const userId = String(body?.userId || "").trim();
  const gameId = (String(body?.game || "").trim() || "unknown").toLowerCase();
  const reason = String(body?.reason || "reward").trim() || "reward";
  const nonce = body?.nonce ? String(body.nonce).trim() : ""; // 선택 사용

  // Client provided deltas (optional / can be overridden by game rules)
  const clientExp = normalizeNumber(body?.exp);
  const clientTickets = normalizeNumber(body?.tickets);
  const clientPoints = normalizeNumber(body?.points);

  // Anti-Cheat Hash Validation
  const providedHash = String(body?.hash || "");
  const secretKey = env.REWARD_SECRET_KEY || "";

  if (!secretKey) return jsonErr("Missing server REWARD_SECRET_KEY", 500);
  if (!providedHash) return jsonErr("Missing reward hash");

  const rawPayload = [
    userId,
    gameId,
    clientExp,
    clientTickets,
    clientPoints,
    nonce,
    secretKey,
  ].join("|");

  const calculatedHash = await sha256(rawPayload);
  if (providedHash !== calculatedHash) {
    return jsonErr("Hash mismatch – reward rejected (anti-cheat)");
  }

  if (!userId) return jsonErr("Missing userId");
  if (!gameId) return jsonErr("Missing game");

  // Ensure no negative values
  if (clientExp < 0 || clientTickets < 0 || clientPoints < 0) {
    return jsonErr("Values must not be negative");
  }

  // Load Game Reward Table & Level Curve (with safe fallback)
  const gameRewards = await loadGameRewards(env);
  const levelCurve = await loadLevelCurve(env);

  const rule: RewardRule | undefined = gameRewards[gameId];
  if (!rule) {
    return jsonErr(`No reward table defined for game: ${gameId}`);
  }

  // Final reward calculation (rule 우선, 클라이언트 값은 상한선 내에서만 허용)
  const finalExp = clampReward(
    clientExp > 0 ? clientExp : rule.exp || 0,
    rule.maxExp
  );
  const finalTickets = clampReward(
    clientTickets > 0 ? clientTickets : rule.tickets || 0,
    rule.maxTickets
  );
  const finalPoints = clampReward(
    clientPoints > 0 ? clientPoints : rule.points || 0,
    rule.maxPoints
  );

  // 아무 변화도 없으면 굳이 DB 접근 안 하고 바로 반환
  if (finalExp === 0 && finalTickets === 0 && finalPoints === 0) {
    return jsonOK({
      userId,
      game: gameId,
      progress: {
        exp: 0,
        level: 1,
        tickets: 0,
      },
      wallet: {
        balance: 0,
      },
      reward: {
        exp: 0,
        tickets: 0,
        points: 0,
      },
      noop: true,
    });
  }

  // SQL Connection
  const sql = env.DB;
  const cx = await sql.begin();

  try {
    // ───────────────────────────────────────────────
    // 0) 중복 지급 방지용 nonce 처리 (선택)
    //    - 같은 userId + gameId + nonce 조합이 이미 처리됐다면 즉시 반환
    // ───────────────────────────────────────────────
    if (nonce) {
      await cx.run(`
        create table if not exists reward_receipts (
          user_id text not null,
          game_id text not null,
          nonce text not null,
          created_at timestamptz default now(),
          primary key (user_id, game_id, nonce)
        );
      `);

      const existing = await cx.get<{
        user_id: string;
      }>(
        `select user_id from reward_receipts where user_id = ? and game_id = ? and nonce = ?`,
        [userId, gameId, nonce]
      );

      if (existing?.user_id) {
        // 이미 처리된 보상 → 중복 지급 방지
        await cx.rollback();
        return jsonErr("Duplicate reward (nonce already used)", 409);
      }

      await cx.run(
        `
        insert into reward_receipts(user_id, game_id, nonce)
        values(?, ?, ?)
        `,
        [userId, gameId, nonce]
      );
    }

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

    const curProgress = await cx.get<{
      exp: number;
      level: number;
      tickets: number;
    }>(
      `select exp, level, tickets from user_progress where user_id = ?`,
      [userId]
    );

    const prevExp = curProgress?.exp || 0;
    const prevTickets = curProgress?.tickets || 0;

    let newExp = prevExp + finalExp;
    let newTickets = prevTickets + finalTickets;
    if (newExp < 0) newExp = 0;
    if (newTickets < 0) newTickets = 0;

    const newLevel = calcLevel(newExp, levelCurve);

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

    // ───────────────────────────────────────────────
    // 2) wallet_balances 업데이트 (포인트 → balance)
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

    const prevBalance = curBal?.balance || 0;
    let newBalance = prevBalance + finalPoints;
    if (newBalance < 0) newBalance = 0;

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

    if (finalPoints !== 0) {
      await cx.run(
        `
        insert into wallet_tx(user_id, amount, reason, game_id)
        values(?, ?, ?, ?)
        `,
        [userId, finalPoints, reason, gameId]
      );
    }

    // ───────────────────────────────────────────────
    // 4) analytics_events 로그 (선택 기능, UI/통계용)
    // ───────────────────────────────────────────────
    await cx.run(`
      create table if not exists analytics_events (
        id uuid primary key default gen_random_uuid(),
        user_id text,
        game_id text,
        event_type text not null,
        meta_json jsonb,
        created_at timestamptz default now()
      );
    `);

    await cx.run(
      `
      insert into analytics_events(user_id, game_id, event_type, meta_json)
      values(?, ?, 'reward', jsonb_build_object(
        'exp', ?,
        'tickets', ?,
        'points', ?,
        'prevExp', ?,
        'prevTickets', ?,
        'prevBalance', ?,
        'nonce', ?
      ))
      `,
      [
        userId,
        gameId,
        finalExp,
        finalTickets,
        finalPoints,
        prevExp,
        prevTickets,
        prevBalance,
        nonce || null,
      ]
    );

    // ───────────────────────────────────────────────
    // 커밋
    // ───────────────────────────────────────────────
    await cx.commit();

    // Response
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
    return jsonErr("DB Error", 500, err?.message ?? String(err));
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
 * Normalize number (NaN → 0)
 * ───────────────────────────────────────────────*/
function normalizeNumber(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/* ───────────────────────────────────────────────
 * Clamp reward value with optional max cap
 * ───────────────────────────────────────────────*/
function clampReward(value: number, max?: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (typeof max === "number" && Number.isFinite(max) && max >= 0) {
    return Math.min(value, max);
  }
  return value;
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
 * (Cloudflare Pages Assets + 안전한 기본값 제공)
 * ───────────────────────────────────────────────*/
async function loadGameRewards(env: any): Promise<GameRewardTable> {
  const fallback = defaultGameRewards();
  try {
    if (!env.ASSETS) return fallback;
    const res = await env.ASSETS.fetch("/functions/api/_utils/game_rewards.json");
    if (!res.ok) return fallback;
    const json = (await res.json()) as GameRewardTable;
    return json && typeof json === "object" ? json : fallback;
  } catch {
    return fallback;
  }
}

async function loadLevelCurve(env: any): Promise<LevelCurve> {
  const fallback = defaultLevelCurve();
  try {
    if (!env.ASSETS) return fallback;
    const res = await env.ASSETS.fetch("/functions/api/_utils/level_curve.json");
    if (!res.ok) return fallback;
    const json = (await res.json()) as LevelCurve;
    return json && typeof json === "object" ? json : fallback;
  } catch {
    return fallback;
  }
}

/* ───────────────────────────────────────────────
 * Default Game Rewards (내장 기본값)
 * ───────────────────────────────────────────────*/
function defaultGameRewards(): GameRewardTable {
  return {
    "2048": { exp: 20, tickets: 1, points: 5, maxExp: 100, maxTickets: 3, maxPoints: 30 },
    brickbreaker: { exp: 30, tickets: 2, points: 10, maxExp: 150, maxTickets: 3, maxPoints: 50 },
    dino: { exp: 10, tickets: 1, points: 3, maxExp: 80, maxTickets: 2, maxPoints: 20 },
    "lucky-slot": { exp: 5, tickets: 1, points: 2, maxExp: 50, maxTickets: 2, maxPoints: 15 },
    "fruit-ninja": {
      exp: 40,
      tickets: 2,
      points: 15,
      maxExp: 200,
      maxTickets: 4,
      maxPoints: 80,
    },
  };
}

/* ───────────────────────────────────────────────
 * Default Level Curve (내장 기본값)
 * level : required total EXP
 * ───────────────────────────────────────────────*/
function defaultLevelCurve(): LevelCurve {
  return {
    "1": 0,
    "2": 100,
    "3": 300,
    "4": 700,
    "5": 1500,
    "6": 3000,
    "7": 5000,
    "8": 8000,
    "9": 12000,
    "10": 17000,
  };
}

/* ───────────────────────────────────────────────
 * EXP Level Curve 계산
 * level_curve.json 예:
 * {
 *   "1": 0,
 *   "2": 100,
 *   "3": 300,
 *   "4": 700,
 *   "5": 1500
 * }
 * ───────────────────────────────────────────────*/
function calcLevel(exp: number, curve: LevelCurve): number {
  if (!Number.isFinite(exp) || exp <= 0) return 1;

  let level = 1;
  const entries = Object.entries(curve)
    .map(([lv, need]) => [Number(lv), Number(need)] as [number, number])
    .filter(([lv, need]) => Number.isFinite(lv) && Number.isFinite(need))
    .sort((a, b) => a[0] - b[0]);

  for (const [lv, need] of entries) {
    if (exp >= need) level = lv;
    else break;
  }

  if (!Number.isFinite(level) || level < 1) return 1;
  return level;
}
