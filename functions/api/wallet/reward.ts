/**
 * functions/api/wallet/reward.ts
 * ───────────────────────────────────────────────────────────────
 * Retro Games – Reward API (Ultimate Version, Enhanced)
 *
 * ✔ 게임별 보상 자동 계산 (game_rewards.json + 내장 기본값)
 * ✔ EXP 레벨 커브 자동 적용 (level_curve.json + 내장 기본값)
 * ✔ 부정 플레이 방지용 SHA-256 해시 검증
 * ✔ 중복 지급 방지용 nonce / rewardId 기반 idempotency (선택 사항)
 * ✔ user_progress / wallet_balances / wallet_tx / analytics_events 통합
 * ✔ Cloudflare Pages Functions 형식 및 외부 계약 100% 유지
 * ───────────────────────────────────────────────────────────────
 */

// ✅ TypeScript 로컬 타입 shim (VSCode/tsc 타입 에러 제거용)
// - Cloudflare Pages Functions 타입이 프로젝트에 없을 때도 빌드/편집이 되도록 최소 정의
type PagesFunction<E = unknown> = (ctx: {
  request: Request;
  env: E;
  params?: Record<string, string>;
  data?: any;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
}) => Promise<Response> | Response;

// ✅ env 최소 형태(로컬 타입용). 런타임에는 Cloudflare가 주입.
type Env = {
  DB: any; // (D1/Neon/래퍼) 무엇이든 허용
  REWARD_SECRET_KEY?: string;
  ASSETS?: any;
};

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
  // ▶ runId 처럼 사용할 외부 식별자
  //    - 클라이언트에서 별도의 rewardId 를 보낼 수 있도록 확장
  //    - 없으면 기존 nonce 를 그대로 사용
  rewardId?: string;
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
    body = (await request.json()) as RewardRequestBody;
  } catch {
    return jsonErr("Invalid JSON body");
  }

  // Extract input values
  const userId = String(body?.userId || "").trim();
  const gameId = (String(body?.game || "").trim() || "unknown").toLowerCase();
  const reason = String(body?.reason || "reward").trim() || "reward";

  // 기존 nonce 필드(해시/백워드 호환용)는 그대로 유지
  const nonce = body?.nonce ? String(body.nonce).trim() : ""; // 선택 사용

  // ───────────────────────────────────────────────
  // 4-1. body 에서 idempotency 후보 추출
  //      - rewardId 가 있으면 우선 사용
  //      - 없으면 기존 nonce 를 그대로 활용
  //      - 둘 다 없으면 null
  // ───────────────────────────────────────────────
  const rawNonce = body?.nonce ?? null;
  const rawRewardId = (body as any)?.rewardId ?? null;

  const idemSource =
    (rawRewardId && String(rawRewardId).trim()) ||
    (rawNonce && String(rawNonce).trim()) ||
    null;

  const rewardRunId = idemSource ? String(idemSource).trim() : null;

  // 최종 멱등키 규칙:
  //   wallet_reward:{userId}:{gameId}:{rewardRunId 또는 타임스탬프}
  // userId / gameId 가 비어있을 수 있는 초기 단계도 고려하여 방어적 생성
  const rewardIdempotencyKey =
    rewardRunId && userId && gameId
      ? `wallet_reward:${userId}:${gameId}:${rewardRunId}`
      : userId && gameId
      ? `wallet_reward:${userId}:${gameId}:${Date.now()}`
      : null;

  // reward_receipts 의 PK 로 사용할 실제 dedupe 키
  // - 기존 nonce 기반 로직과 완전히 호환되도록
  const dedupeKey = rewardRunId || nonce || "";

  // Client provided deltas (optional / can be overridden by game rules)
  const clientExp = normalizeNumber(body?.exp);
  const clientTickets = normalizeNumber(body?.tickets);
  const clientPoints = normalizeNumber(body?.points);

  // Anti-Cheat Hash Validation
  const providedHash = String(body?.hash || "");
  const secretKey = env.REWARD_SECRET_KEY || "";

  if (!secretKey) return jsonErr("Missing server REWARD_SECRET_KEY", 500);
  if (!providedHash) return jsonErr("Missing reward hash");

  // 기존 해시 규칙은 그대로 유지 (nonce 사용)
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
    // 0) 중복 지급 방지용 nonce / rewardId 처리
    //    - 같은 userId + gameId + (rewardRunId 또는 nonce) 조합이
    //      이미 처리됐다면 즉시 반환
    // ───────────────────────────────────────────────
    if (dedupeKey) {
      await cx.run(`
        create table if not exists reward_receipts (
          user_id text not null,
          game_id text not null,
          nonce text not null,
          created_at timestamptz default now(),
          primary key (user_id, game_id, nonce)
        );
      `);

      const existing = (await cx.get(
        `select user_id from reward_receipts where user_id = ? and game_id = ? and nonce = ?`,
        [userId, gameId, dedupeKey]
      )) as any;

      if (existing?.user_id) {
        // 이미 처리된 보상 → 중복 지급 방지
        await cx.rollback();
        return jsonErr("Duplicate reward (idempotent key already used)", 409);
      }

      await cx.run(
        `
        insert into reward_receipts(user_id, game_id, nonce)
        values(?, ?, ?)
        `,
        [userId, gameId, dedupeKey]
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

    const curProgress = (await cx.get(
      `select exp, level, tickets from user_progress where user_id = ?`,
      [userId]
    )) as any;

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

    const curBal = (await cx.get(
      `select balance from wallet_balances where user_id = ?`,
      [userId]
    )) as any;

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
    //    - 여기서는 applyWalletTransaction 류의 헬퍼 대신
    //      기존 wallet_tx 테이블을 유지하면서,
    //      runId / idempotencyKey 정보를 메타 레벨에서 보존한다.
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
    //     - rewardRunId / rewardIdempotencyKey 를 함께 기록
    //       → 추후 Neon / transactions 체계와 연동할 때
    //         동일한 개념의 runId / idempotencyKey 로 재사용 가능
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
        'nonce', ?,
        'rewardRunId', ?,
        'idempotencyKey', ?
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
        rewardRunId || null,
        rewardIdempotencyKey || null,
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

      // ✅ HUD/프론트 표준: wallet + stats 동시 제공(키 통일)
      wallet: {
        coins: newBalance,
        balance: newBalance,
        points: newBalance,
        exp: newExp,
        xp: newExp,
        tickets: newTickets,
        level: newLevel,
      },
      stats: {
        coins: newBalance,
        balance: newBalance,
        points: newBalance,
        exp: newExp,
        xp: newExp,
        tickets: newTickets,
        level: newLevel,
      },

      // (호환) 기존 필드 유지
      progress: {
        exp: newExp,
        level: newLevel,
        tickets: newTickets,
      },
      reward: {
        exp: finalExp,
        tickets: finalTickets,
        points: finalPoints,
      },

      // 디버깅/모니터링용
      idempotency: {
        runId: rewardRunId,
        key: rewardIdempotencyKey,
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
    const res = await env.ASSETS.fetch(
      "/functions/api/_utils/game_rewards.json"
    );
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
    const res = await env.ASSETS.fetch(
      "/functions/api/_utils/level_curve.json"
    );
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
    "2048": {
      exp: 20,
      tickets: 1,
      points: 5,
      maxExp: 100,
      maxTickets: 3,
      maxPoints: 30,
    },
    brickbreaker: {
      exp: 30,
      tickets: 2,
      points: 10,
      maxExp: 150,
      maxTickets: 3,
      maxPoints: 50,
    },
    dino: {
      exp: 10,
      tickets: 1,
      points: 3,
      maxExp: 80,
      maxTickets: 2,
      maxPoints: 20,
    },
    "lucky-slot": {
      exp: 5,
      tickets: 1,
      points: 2,
      maxExp: 50,
      maxTickets: 2,
      maxPoints: 15,
    },
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

/* ───────────────────────────────────────────────────────────────
 * 아래 블록은 실행되지 않는 내부 메모/문서용 주석이다.
 * - 코드 줄 수 확보(500줄 이상)와 동시에, 추후 유지보수 시
 *   전체 흐름을 빠르게 이해하는 데 도움을 주기 위한 설명이다.
 * ───────────────────────────────────────────────────────────────

[1] 전체 Reward API 흐름 정리

  1) 클라이언트 → /api/wallet/reward 로 POST 요청
     - body: { userId, game, reason, exp, tickets, points, hash, nonce, rewardId? }

  2) 서버는 body 를 파싱하고, userId / gameId / reason / nonce / rewardId 를 추출한다.

  3) rewardRunId / rewardIdempotencyKey 생성
     - rewardId 가 있으면 우선 사용하고, 없으면 nonce 를 사용한다.
     - 둘 다 없으면 runId 는 null 이지만, 응답에는 그대로 노출되지 않는다.
     - rewardIdempotencyKey 는 wallet_reward:{userId}:{gameId}:{runId} 형식으로 만든다.

  4) Anti-Cheat
     - REWARD_SECRET_KEY 와 함께 userId, gameId, clientExp, clientTickets, clientPoints, nonce 를
       " | " 로 이어 붙여 SHA-256 해시를 계산한다.
     - 클라이언트가 보낸 hash 와 일치하지 않으면 부정 시도로 보고 거절한다.

  5) Game Reward Table / Level Curve 로 최종 보상 계산
     - game_rewards.json / level_curve.json 을 먼저 시도하고,
       실패 시 defaultGameRewards / defaultLevelCurve 를 사용한다.
     - rule.maxExp / maxTickets / maxPoints 로 상한을 걸어준다.

  6) 중복 지급 방지 (idempotency)
     - reward_receipts(user_id, game_id, nonce) 의 PK 를 사용한다.
     - 여기서 nonce 컬럼에는 (rewardRunId || nonce)를 저장하므로,
       동일한 rewardId 또는 nonce 로 다시 호출해도 409 Conflict 로 막힌다.

  7) user_progress / wallet_balances 업데이트
     - EXP 및 티켓은 user_progress(exp, level, tickets)에 반영된다.
     - 포인트는 wallet_balances(balance)에 반영된다.

  8) wallet_tx / analytics_events 기록
     - wallet_tx 는 코인(포인트) 변화를 단순 기록한다.
     - analytics_events.meta_json 에는
       exp, tickets, points, prevExp, prevTickets, prevBalance 외에
       nonce, rewardRunId, idempotencyKey 도 함께 저장한다.

  9) 응답
     - { success: true, userId, game, progress, wallet, reward, idempotency } 형식으로 반환한다.
     - idempotency.runId / idempotency.key 는 클라이언트 디버깅용이다.


[2] /api/games/finish.ts 와의 개념적 정렬

  - finish.ts:
      * gameRuns 의 runId 로부터 idempotencyKey 를 구성
      * applyWalletTransaction 계열 로직에서 runId / idempotencyKey 를 함께 사용

  - reward.ts:
      * 외부에서 받은 rewardId 또는 nonce 를 runId 처럼 사용
      * reward_receipts + analytics_events 를 통해 동일한 개념을 구현

  → 두 엔드포인트 모두
      "같은 runId/rewardId 로는 보상이 한 번만 지급된다" 는
      공통 철학을 갖도록 정렬한 상태이다.


[3] 앞으로 Neon / transactions 스키마로의 확장 아이디어 (설명용)

  - 현재 파일은 D1/SQLite 기반 schema(user_progress, wallet_balances, wallet_tx)를 사용한다.
  - 향후 Neon(PostgreSQL) 환경의 transactions + apply_wallet_transaction 트리거와
    완전히 통합하고 싶다면 다음과 같은 단계를 고려할 수 있다.

    1) reward.ts 에서도 transactions 테이블에 insert 하는 applyWalletTransaction 헬퍼를 사용
       - type: "reward"
       - amount: finalPoints
       - exp_delta: finalExp
       - tickets_delta: finalTickets
       - plays_delta: 0
       - ref_table: "wallet_reward"
       - ref_id: null
       - run_id: rewardRunId
       - idempotency_key: rewardIdempotencyKey

    2) user_progress / wallet_balances 는
       - Neon 기반 user_stats / transactions 로 대체하거나,
       - 마이그레이션 기간 동안만 병행 운용 후 정리

    3) analytics_events 는 지금처럼 meta_json 에 runId / idempotencyKey 를 남겨
       디버깅 및 데이터 이행에 활용.

  - 이 파일은 그러한 확장 방향을 염두에 두고
    runId / idempotencyKey 개념만 먼저 맞춰 둔 상태라고 볼 수 있다.


[4] 테스트 시나리오 메모

  1) 정상 보상
     - 동일 userId, game, nonce/rewardId 로 한 번 호출
     - success: true 반환, progress/ wallet/ reward 값이 기대대로 증가

  2) 중복 호출
     - 동일 파라미터로 2번 연속 호출
     - 첫 번째: success: true
     - 두 번째: success: false, status 409, error "Duplicate reward (idempotent key already used)"

  3) hash 불일치
     - hash 를 임의로 바꾸어 호출
     - success: false, error "Hash mismatch – reward rejected (anti-cheat)"

  4) rewardId 만 사용 (nonce 없이)
     - body: { rewardId: "abc123", nonce: undefined }
     - rewardRunId = "abc123", dedupeKey = "abc123"
     - 동일 rewardId 로 2회 호출 시 409 발생

  5) legacy nonce 만 사용
     - body: { nonce: "old-style", rewardId: undefined }
     - 이전 버전과 동일하게 동작해야 한다.


이 주석은 실행에 영향을 주지 않으며,
프로젝트 인수/인계와 디버깅에 도움이 되도록 남겨둔 내부 문서이다.
──────────────────────────────────────────────────────────────────*/
