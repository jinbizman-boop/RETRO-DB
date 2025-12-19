// functions/api/_utils/progression.ts
// ───────────────────────────────────────────────────────────────
// Centralized progression & reward helpers.
//
// 역할:
// 1) 게임/이벤트 등에서 경험치, 포인트(코인), 티켓, 플레이 횟수 등을
//    "델타(증감치)" 단위로 계산/정규화
// 2) 해당 델타를 Neon DB의 user_stats / transactions 에 반영
//
// 설계 원칙:
// - 단일 소스: user_stats + transactions 를 기준으로 계정 상태를 관리
// - points(코인)는 transactions + DB 트리거(apply_wallet_transaction)로만 변경
// - exp/tickets/plays 는 user_stats 를 직접 UPDATE
// - 모든 함수는 순수 유틸: 외부에서는 sql 클라이언트만 주입해서 사용
//   (api 라우트에서는 requireUser 등 인증을 처리한 뒤 userId 를 넘겨줌)

export interface SqlClient {
  // Neon(sql) 스타일 템플릿 태그 클라이언트의 최소 인터페이스
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<{ rows: T[] }>;
}

// 델타 구조: "얼마나 변경할 것인가"
export interface ProgressionDelta {
  userId: string;

  // 포인트(코인) 증감: 양수=적립, 음수=차감
  pointsDelta?: number | bigint;

  // 티켓 증감
  ticketsDelta?: number | bigint;

  // 경험치 증감
  expDelta?: number | bigint;

  // 플레이 횟수 증감 (보통 0 또는 1)
  playsDelta?: number | bigint;

  // 로그/트랜잭션 reason
  reason?: string;

  // 참조 정보 (선택)
  refTable?: string | null;
  refId?: string | number | null;

  // 멱등성 키: 같은 key 로 여러 번 호출되어도 1번만 반영
  idempotencyKey?: string | null;

  // 부가 메타 정보 (JSONB 칼럼 등에 넣고 싶다면 사용)
  meta?: Record<string, unknown> | null;
}

// 게임 플레이 기반 델타 계산 입력 값
export interface GameDeltaInput {
  userId: string;
  game: string;
  score: number;
  meta?: Record<string, unknown>;
}

// 내부용: 숫자/빅인트 정규화
function toBigIntSafe(value: number | bigint | undefined | null): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (!Number.isFinite(value)) return 0n;
  return BigInt(Math.trunc(value));
}

function isNonZeroBigInt(v: bigint): boolean {
  return v !== 0n;
}

// ───────────────────────────────────────────────────────────────
// 1. 게임별 보상 규칙 (임시 기본값)
//    - 필요 시 이 맵만 수정하면 전체 보상 정책이 바뀜
// ───────────────────────────────────────────────────────────────

interface GameRule {
  xpPerScore: number;      // 점수 1점당 경험치
  coinPerScore: number;    // 점수 1점당 코인
  ticketsPerPlay: number;  // 1판당 티켓
  minScoreForReward?: number; // 이 점수 미만이면 보상 없음
}

const DEFAULT_GAME_RULE: GameRule = {
  xpPerScore: 1,
  coinPerScore: 0,
  ticketsPerPlay: 0,
  minScoreForReward: 0,
};

const GAME_RULES: Record<string, GameRule> = {
  // 예시 규칙들 — 필요 시 자유롭게 조정/추가
  "brick-breaker": {
    xpPerScore: 1,
    coinPerScore: 0.01,
    ticketsPerPlay: 1,
    minScoreForReward: 10,
  },
  "tetris": {
    xpPerScore: 0.5,
    coinPerScore: 0.005,
    ticketsPerPlay: 1,
    minScoreForReward: 5,
  },
  "dino-runner": {
    xpPerScore: 0.2,
    coinPerScore: 0.002,
    ticketsPerPlay: 0,
    minScoreForReward: 0,
  },
  // 등록되지 않은 게임들은 DEFAULT_GAME_RULE 사용
};

// ───────────────────────────────────────────────────────────────
// 2. 게임 점수 → ProgressionDelta 계산
// ───────────────────────────────────────────────────────────────

/**
 * 게임 한 판 결과를 기반으로 경험치/티켓/코인 델타를 계산.
 * - 여기서는 "정책"만 정의하고 실제 DB 반영은 applyProgressionDeltaDb 가 담당.
 */
export function computeGameProgressionDelta(input: GameDeltaInput): ProgressionDelta {
  const { userId, game, score, meta } = input;

  const trimmedGame = game.trim().toLowerCase();
  const rule = GAME_RULES[trimmedGame] ?? DEFAULT_GAME_RULE;

  const safeScore = Number.isFinite(score) && score > 0 ? score : 0;
  if (rule.minScoreForReward && safeScore < rule.minScoreForReward) {
    // 최저 점수 미달 → 델타 0 (플레이 횟수만 +1 할 수도 있음)
    return {
      userId,
      pointsDelta: 0n,
      ticketsDelta: 0n,
      expDelta: 0n,
      playsDelta: 1n,
      reason: `play_${trimmedGame}`,
      meta: { ...(meta ?? {}), score: safeScore, noReward: true },
    };
  }

  const expDelta = safeScore * rule.xpPerScore;
  const coinDelta = safeScore * rule.coinPerScore;
  const ticketsDelta = rule.ticketsPerPlay;

  return {
    userId,
    pointsDelta: toBigIntSafe(coinDelta),
    ticketsDelta: toBigIntSafe(ticketsDelta),
    expDelta: toBigIntSafe(expDelta),
    playsDelta: 1n,
    reason: `play_${trimmedGame}`,
    meta: { ...(meta ?? {}), score: safeScore },
  };
}

// ───────────────────────────────────────────────────────────────
// 3. user_stats row 보장
// ───────────────────────────────────────────────────────────────

/**
 * 해당 user_id 에 대한 user_stats row 가 존재하지 않으면 생성.
 * - 다른 엔드포인트에서도 재사용 가능.
 */
export async function ensureUserStatsRow(sql: SqlClient, userId: string): Promise<void> {
  const normalizedId = userId.trim();
  if (!normalizedId) return;

  await sql`
    insert into user_stats (user_id)
    values (${normalizedId}::uuid)
    on conflict (user_id) do nothing
  `;
}

// ───────────────────────────────────────────────────────────────
// 4. 델타를 실제 DB(user_stats + transactions)에 반영
// ───────────────────────────────────────────────────────────────

/**
 * ProgressionDelta 를 DB에 반영.
 *
 * 규칙:
 * - pointsDelta (코인) ≠ 0 → transactions 테이블에 insert
 *   → DB 트리거(apply_wallet_transaction)에서 user_stats.coins 업데이트
 * - expDelta, ticketsDelta, playsDelta → user_stats 를 직접 UPDATE
 * - idempotencyKey 가 있을 경우, transactions.idempotency_key 를 기준으로
 *   같은 델타가 중복 적용되지 않도록 방어
 */
export async function applyProgressionDeltaDb(
  sql: SqlClient,
  rawDelta: ProgressionDelta
): Promise<void> {
  const userId = rawDelta.userId?.trim();
  if (!userId) return;

  // 숫자/빅인트 정규화
  const expDelta = toBigIntSafe(rawDelta.expDelta);
  const ticketsDelta = toBigIntSafe(rawDelta.ticketsDelta);
  const playsDelta = toBigIntSafe(rawDelta.playsDelta);
  const pointsDelta = toBigIntSafe(rawDelta.pointsDelta);

  const reason = (rawDelta.reason ?? "").trim() || null;
  const refTable = rawDelta.refTable ?? null;
  const refId = rawDelta.refId ?? null;
  const idemKey = rawDelta.idempotencyKey ?? null;

  // 아무 변화가 없으면 종료
  if (
    !isNonZeroBigInt(pointsDelta) &&
    !isNonZeroBigInt(expDelta) &&
    !isNonZeroBigInt(ticketsDelta) &&
    !isNonZeroBigInt(playsDelta)
  ) {
    return;
  }

  // user_stats row 보장 (기본값은 DB default)
  await ensureUserStatsRow(sql, userId);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const refIdUuid = typeof refId === "string" && UUID_RE.test(refId) ? refId : null;

  const txType =
    pointsDelta > 0n ? "earn" : pointsDelta < 0n ? "spend" : "reward";

  const metaJson = JSON.stringify(rawDelta.meta ?? {});
  const game =
    (rawDelta.meta &&
      typeof (rawDelta.meta as any).game === "string" &&
      String((rawDelta.meta as any).game).trim().slice(0, 64)) ||
    null;

  if (idemKey && idemKey.trim()) {
    await sql`
      insert into transactions (
        user_id, type, amount, reason, meta, game,
        exp_delta, tickets_delta, plays_delta,
        ref_table, ref_id, idempotency_key
      )
      values (
        ${userId}::uuid, ${txType}, ${pointsDelta}, ${reason}, ${metaJson}, ${game},
        ${expDelta}, ${ticketsDelta}, ${playsDelta},
        ${refTable}, ${refIdUuid}::uuid, ${idemKey}
      )
      on conflict (idempotency_key) do nothing
    `;
  } else {
    await sql`
      insert into transactions (
        user_id, type, amount, reason, meta, game,
        exp_delta, tickets_delta, plays_delta,
        ref_table, ref_id
      )
      values (
        ${userId}::uuid, ${txType}, ${pointsDelta}, ${reason}, ${metaJson}, ${game},
        ${expDelta}, ${ticketsDelta}, ${playsDelta},
        ${refTable}, ${refIdUuid}::uuid
      )
    `;
  }
}

// ───────────────────────────────────────────────────────────────
// 5. 여러 델타를 한 번에 합산해서 적용하고 싶을 때
// ───────────────────────────────────────────────────────────────

/**
 * 여러 ProgressionDelta 를 하나로 합치는 헬퍼.
 * - userId 가 다르면 에러를 던짐.
 * - reason 은 마지막 델타의 값을 사용.
 * - refTable/refId/idempotencyKey 는 직접 지정하는 것을 권장.
 */
export function mergeProgressionDeltas(
  ...deltas: ProgressionDelta[]
): ProgressionDelta {
  if (deltas.length === 0) {
    throw new Error("mergeProgressionDeltas: at least one delta is required");
  }

  const baseUserId = deltas[0].userId?.trim();
  if (!baseUserId) {
    throw new Error("mergeProgressionDeltas: first delta must have userId");
  }

  let points = 0n;
  let tickets = 0n;
  let exp = 0n;
  let plays = 0n;

  let reason: string | undefined;
  let refTable: string | null | undefined;
  let refId: string | number | null | undefined;
  let idempotencyKey: string | null | undefined;
  let meta: Record<string, unknown> | null | undefined = null;

  for (const d of deltas) {
    const uid = d.userId?.trim();
    if (!uid || uid !== baseUserId) {
      throw new Error("mergeProgressionDeltas: all deltas must have the same userId");
    }

    points += toBigIntSafe(d.pointsDelta);
    tickets += toBigIntSafe(d.ticketsDelta);
    exp += toBigIntSafe(d.expDelta);
    plays += toBigIntSafe(d.playsDelta);

    // 마지막 델타의 메타/리즌/참조 정보를 우선
    if (d.reason != null) reason = d.reason;
    if (d.refTable !== undefined) refTable = d.refTable;
    if (d.refId !== undefined) refId = d.refId;
    if (d.idempotencyKey !== undefined) idempotencyKey = d.idempotencyKey;

    if (d.meta) {
      meta = { ...(meta ?? {}), ...d.meta };
    }
  }

  return {
    userId: baseUserId,
    pointsDelta: points,
    ticketsDelta: tickets,
    expDelta: exp,
    playsDelta: plays,
    reason,
    refTable: refTable ?? null,
    refId: refId ?? null,
    idempotencyKey: idempotencyKey ?? null,
    meta: meta ?? null,
  };
}
