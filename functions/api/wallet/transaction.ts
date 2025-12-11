// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\transaction.ts
//
// ✅ 목표 / Fix summary
// - 기존 외부 계약 100% 유지
//   • 라우트: POST /api/wallet/transaction
//   • 입력: validateTransaction(body) 사용
//   • 성공 응답: { ok: true }
// - TS 에디터 오류 제거(ts2304, ts7031 등)
// - 레이트리밋, 멱등키(Idempotency-Key) 동작 유지/강화
//
// 🔥 Wallet-C 스키마 / 시스템 정합 강화 (회원별 코인/경험치/티켓 일관 반영)
// - canonical 스키마 (migrations/001_init.sql, 005/006 확장 기준):
//     • transactions 테이블 + apply_wallet_transaction BEFORE INSERT 트리거
//     • user_stats(coins, exp/xp, tickets, games_played, updated_at) 자동 갱신
// - reward.ts / balance.ts 와의 정합:
//     • reward.ts: 게임 보상 → user_progress + wallet_balances 갱신
//     • balance.ts: user_stats(우선) + wallet_balances + user_progress 를 통합 조회
//     • transaction.ts: 상점 결제/직접 코인 조정 → transactions → user_stats 갱신
// - userId 소스 / 정규화:
//     • 1순위: _middleware.ts 가 주입한 X-User-Id 헤더 (UUID users.id)
//     • 2순위: body.userId (validateTransaction 결과)
//     • 최종 UUID 형식 강제 (불일치/누락 시 400)
// - amount 계정 효과:
//     • amount > 0  → type 'earn'  (코인 획득)
//     • amount < 0  → type 'spend' (코인 사용)
//     • amount = 0  → 에러("amount cannot be zero")  (무의미한 트랜잭션 차단)
// - exp / tickets / plays_delta 확장:
//     • body.expDelta / ticketsDelta / playsDelta 로 전달 가능(선택)
//     • toDeltaInt 로 안전 정수화 후, transactions.exp_delta / tickets_delta / plays_delta 에 반영
//     • 트리거가 user_stats.xp / coins / tickets / games_played 에 반영
// - game, reason, meta, ref_table/ref_id 확장:
//     • game: 랭킹 기록/로그 집계용 식별자 (소문자 64자 이내)
//     • reason: 짧은 설명 문자열(120자 이내), 제어문자 제거
//     • ref_table/ref_id: shop_orders, game_runs 등 참조용
//     • meta: JSONB (ip, ua, caller 정보 + 클라이언트가 보내는 추가 필드)
// - progression.ts 와 정합성:
//     • progression 기반 자동 보상과 동일하게 user_stats / transactions 체계 사용
//     • 필요시 ensureUserStatsRow 로 user_stats row 보장
//
// - 멱등키(Idempotency-Key) 지원:
//     • transactions.idempotency_key unique
//     • 같은 키로 재호출 시 on conflict do nothing → double spend 방지
//     • balance_after 를 반환받으면 X-Wallet-Balance 헤더에 노출
//
// - 오류 매핑:
//     • 스키마 미초기화: "Wallet schema is not initialized..." (400)
//     • 잔액 부족: apply_wallet_transaction 에서 던지는 에러 패턴 인식 후,
//                 { error: "insufficient_funds" } (400) 로 통일
//     • 나머지는 { error: message } 400 으로 그대로 전달
//
// - 📊 추가 고도화 (reward.ts / balance.ts 와 동일 철학):
//     • 트랜잭션 실행 후, 최신 user_stats 를 다시 읽어서 요약 헤더 제공
//       - X-Wallet-Stats-Json: { balance, exp, tickets, gamesPlayed }
//     • analytics_events 에 wallet_tx 이벤트 기록(선택적 활용)
//     • X-Wallet-Debug-* 헤더로 디버그 정보(요청/응답 메타) 선택 제공
//
// - 2025-12-11 추가:
//     • transactions.run_id 컬럼을 사용할 수 있도록 확장.
//       - 요청 body 의 runId / run_id 값을 정규화하여 runId 변수로 사용.
//       - INSERT INTO transactions 시 run_id 컬럼/값을 한 칸씩 추가.
//       - 외부 계약/응답 포맷/헤더는 그대로 유지.
//
// ───────────────────────────────────────────────────────────────

// ───── Minimal Cloudflare Pages ambient types (type-checker only) ─────
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
// ──────────────────────────────────────────────────────────────────────

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateTransaction } from "../_utils/schema/wallet";
import * as Rate from "../_utils/rate-limit";
import { ensureUserStatsRow } from "../_utils/progression";

/* ───────── types & constants ───────── */

type TxType = "earn" | "spend";

type UserStatsRow = {
  coins?: number | string | bigint | null;
  exp?: number | string | bigint | null;
  xp?: number | string | bigint | null;
  tickets?: number | string | bigint | null;
  games_played?: number | string | bigint | null;
  last_login_at?: string | Date | null;
  updated_at?: string | Date | null;
};

type TxInsertResultRow = {
  balance_after?: number | string | bigint | null;
};

type AnalyticsRow = {
  id?: string;
};

type SqlClient = ReturnType<typeof getSql>;

/**
 * users.id = UUID (001_init.sql 기반) 이므로, UUID 강제
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ───────── helpers: userId / amount / meta / 정규화 ───────── */

/**
 * 문자열 안전 정규화
 * - trim + NFKC
 */
function safeNormalizeStr(v: string): string {
  const trimmed = v.trim();
  try {
    return trimmed.normalize("NFKC");
  } catch {
    return trimmed;
  }
}

/**
 * userId 우선순위
 *  1) X-User-Id / x-user-id 헤더 (미들웨어가 JWT 기반으로 주입)
 *  2) validateTransaction 이 반환한 body.userId
 */
function resolveUserId(req: Request, bodyUserId: unknown): string {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";

  let candidate = safeNormalizeStr(
    (headerId || String(bodyUserId ?? "")).trim()
  );

  if (!candidate) throw new Error("Missing userId");
  if (!UUID_V4_REGEX.test(candidate)) {
    throw new Error("Invalid userId");
  }
  return candidate;
}

/**
 * 과거 버전과 이름을 맞추기 위해 toBigIntSafe 이름 유지
 * 실제로는 JS number를 bigint 문자열로 안전히 변환하는 역할
 */
function toBigIntSafe(n: any): bigint {
  const x = Number(n);
  if (!Number.isFinite(x)) throw new Error("Invalid amount");
  // 매우 큰 값은 bigint/PG 에서도 다룰 수 있지만, 현실적인 범위로 제한
  const clamped =
    x > Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : x < -Number.MAX_SAFE_INTEGER
      ? -Number.MAX_SAFE_INTEGER
      : x;
  return BigInt(Math.trunc(clamped));
}

/**
 * reason 문자열 정규화
 * - trim + NFKC
 * - 제어문자 제거
 * - 최대 120자 제한
 */
function cleanReason(v: string | undefined): string | null {
  if (!v) return null;
  let s = v.trim();
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore
  }
  // 제어문자 제거
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!s) return null;
  return s.length > 120 ? s.slice(0, 120) : s;
}

/**
 * 게임 ID 정규화
 * - 소문자, 길이 64자 제한
 */
function cleanGameId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

/**
 * 참조 테이블 이름(ref_table) 정규화
 * - 영문 소문자/언더스코어만 허용
 * - 길이 64자 제한
 */
function cleanRefTable(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[^a-z0-9_]/g, "");
  if (!s) return null;
  return s.slice(0, 64);
}

/**
 * 참조 ID(ref_id) 정규화
 * - string | number 허용
 * - 문자열인 경우 길이 제한
 */
function cleanRefId(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 128);
  }
  return null;
}

/**
 * runId 정규화
 * - string 만 허용
 * - 공백 제거 후 128자 제한
 * - 없으면 null
 */
function cleanRunId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

/**
 * 멱등키(Idempotency-Key) 추출
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
 * relation / table 미존재 여부
 */
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist")) ||
    msg.includes("undefined_table")
  );
}

/**
 * exp/tickets/plays_delta 등의 정수 보정
 */
function toDeltaInt(v: any): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  // 너무 큰 값은 안전을 위해 클램프 (임의의 보수적 범위)
  if (i > 1_000_000) return 1_000_000;
  if (i < -1_000_000) return -1_000_000;
  return i;
}

/**
 * meta JSONB 보정
 * - 순수 JSON만 허용
 * - 순환참조/함수 등 있으면 빈 객체로 대체
 */
function sanitizeMeta(meta: any): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  try {
    JSON.stringify(meta);
    return meta as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 클라이언트 메타: ip / user-agent
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

/**
 * apply_wallet_transaction() 트리거가 던지는 "잔액 부족" 에러 판별
 */
function isInsufficientBalanceError(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("insufficient balance") ||
    (msg.includes("insufficient") && msg.includes("balance")) ||
    (msg.includes("not enough") && msg.includes("coins"))
  );
}

/**
 * transactions / user_stats 스키마 미초기화 여부
 * → "Wallet schema is not initialized" 로 통합
 */
function isWalletSchemaMissing(err: any): boolean {
  if (isMissingTable(err)) return true;
  const msg = String(err?.message ?? err).toLowerCase();
  if (msg.includes("apply_wallet_transaction")) return true;
  if (msg.includes("user_stats") && msg.includes("does not exist")) return true;
  if (msg.includes("transactions") && msg.includes("does not exist")) return true;
  return false;
}

/**
 * Date/타임스탬프 컬럼을 ISO 문자열 또는 null 로 변환
 */
function toIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  try {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/* ───────── user_stats 조회 (balance.ts와 정합) ───────── */

async function fetchUserStats(
  sql: SqlClient,
  userId: string
): Promise<{
  found: boolean;
  coins: number;
  exp: number;
  tickets: number;
  gamesPlayed: number;
  lastLoginAt: string | null;
  updatedAt: string | null;
}> {
  try {
    const rows = (await sql/* sql */ `
      select
        coins,
        exp,
        xp,
        tickets,
        games_played,
        last_login_at,
        updated_at
      from user_stats
      where user_id = ${userId}::uuid
      limit 1
    `) as UserStatsRow[];

    if (!rows || rows.length === 0) {
      return {
        found: false,
        coins: 0,
        exp: 0,
        tickets: 0,
        gamesPlayed: 0,
        lastLoginAt: null,
        updatedAt: null,
      };
    }

    const r = rows[0];

    const coins =
      r.coins === undefined || r.coins === null
        ? 0
        : Number(r.coins) || 0;
    const expCandidate = r.exp ?? r.xp ?? 0;
    const exp = Number(expCandidate) || 0;
    const tickets = Number(r.tickets ?? 0) || 0;
    const gamesPlayed = Number(r.games_played ?? 0) || 0;

    const lastLoginAt = toIsoOrNull(r.last_login_at ?? null);
    const updatedAt = toIsoOrNull(r.updated_at ?? null);

    return {
      found: true,
      coins,
      exp,
      tickets,
      gamesPlayed,
      lastLoginAt,
      updatedAt,
    };
  } catch (e) {
    if (isMissingTable(e)) {
      return {
        found: false,
        coins: 0,
        exp: 0,
        tickets: 0,
        gamesPlayed: 0,
        lastLoginAt: null,
        updatedAt: null,
      };
    }
    throw e;
  }
}

/* ───────── analytics_events 로깅 (선택적) ─────────
 * - reward.ts 와 마찬가지로 통계/분석용 로그 남기기
 */

async function logAnalyticsEvent(
  sql: SqlClient,
  userId: string,
  game: string | null,
  type: "wallet_tx",
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await sql/* sql */ `
      create table if not exists analytics_events (
        id uuid primary key default gen_random_uuid(),
        user_id text,
        game_id text,
        event_type text not null,
        meta_json jsonb,
        created_at timestamptz default now()
      )
    `;
    const gameId = game ?? null;
    await sql/* sql */ `
      insert into analytics_events(user_id, game_id, event_type, meta_json)
      values(
        ${userId},
        ${gameId},
        ${type},
        ${JSON.stringify(payload)}::jsonb
      )
    ` as AnalyticsRow[];
  } catch (e) {
    // 분석용이므로 실패해도 트랜잭션에는 영향 주지 않음
  }
}

/* ───────── handler ───────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // CORS preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  // 허용 메서드: POST
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 남용 방지 (토큰 버킷 기반 레이트리밋)
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

    // ─────────────────────────────────────────────
    // 1) 기존 스키마 검증(계약 유지)
    //    validateTransaction 이 userId / amount / reason / game / meta 등을 1차 정제
    // ─────────────────────────────────────────────
    const txInput = validateTransaction(body) as any;

    const {
      userId: rawUser,
      amount: rawAmount,
      reason: rawReason,
      game: rawGame,
      expDelta: rawExpDelta,
      ticketsDelta: rawTicketsDelta,
      playsDelta: rawPlaysDelta,
      refTable: rawRefTable,
      refId: rawRefId,
      meta: rawMeta,
    } = txInput;

    // ─────────────────────────────────────────────
    // 2) 서버측 보수적 정규화 (userId/amount/reason/game/ref/meta/runId)
    // ─────────────────────────────────────────────

    // userId: 헤더(X-User-Id) 우선 → body.userId
    const userId = resolveUserId(request, rawUser);

    // amount: bigint 클램프
    const amountBig = toBigIntSafe(rawAmount);
    if (amountBig === 0n) {
      // 0 금액 트랜잭션은 의미가 없으므로 거부
      throw new Error("amount cannot be zero");
    }

    // reason: 짧은 설명 텍스트(선택)
    const reason = cleanReason(rawReason ?? undefined);

    // txn_type: amount 부호에 따라 earn / spend
    const txType: TxType = amountBig >= 0n ? "earn" : "spend";

    // game: ranking / 로그 집계용 ID (선택)
    const game = cleanGameId(rawGame);

    // delta 계열: exp/tickets/plays
    const expDelta = toDeltaInt(
      rawExpDelta !== undefined ? rawExpDelta : (body as any).expDelta
    );
    const ticketsDelta = toDeltaInt(
      rawTicketsDelta !== undefined
        ? rawTicketsDelta
        : (body as any).ticketsDelta
    );
    const playsDelta = toDeltaInt(
      rawPlaysDelta !== undefined ? rawPlaysDelta : (body as any).playsDelta
    );

    // ref_table/ref_id: shop_orders, game_runs 같은 참조용
    const refTable = cleanRefTable(
      rawRefTable !== undefined ? rawRefTable : (body as any).refTable
    );
    const refId = cleanRefId(
      rawRefId !== undefined ? rawRefId : (body as any).refId
    );

    // runId: 게임 1회 플레이/보상 단위 식별자(선택)
    // - 클라이언트가 body.runId 또는 body.run_id 로 보내는 값을 정규화
    const runId = cleanRunId(
      (body as any).runId !== undefined
        ? (body as any).runId
        : (body as any).run_id
    );

    // meta: 클라이언트 + 서버 합성 메타
    const clientMeta = getClientMeta(request);
    const userMeta = sanitizeMeta(
      rawMeta !== undefined ? rawMeta : (body as any).meta
    );

    const meta = {
      ...userMeta,
      source: "api/wallet/transaction",
      ip: clientMeta.ip,
      ua: clientMeta.ua,
      env: {
        nodeEnv: (env as any).NODE_ENV ?? undefined,
        runtime: "cloudflare-pages",
      },
    };

    const idem = getIdemKey(request);
    const sql = getSql(env);

    // note: transactions.note 는 구버전 reason 대응, 새 reason 컬럼은 text로 확장
    const note = reason;

    let balanceAfter: number | null = null;
    let usedIdempotent = false;

    // user_stats row 가 없으면 생성 (트리거에서 insert 할 수 있지만 선제 보장)
    await ensureUserStatsRow(sql as any, userId);

    // ─────────────────────────────────────────────
    // 3) canonical 경로: transactions insert
    //    - BEFORE INSERT 트리거 apply_wallet_transaction 가
    //      user_stats(coins, exp, tickets, games_played)를 갱신
    //    - 여기서 runId 를 run_id 컬럼에 함께 기록하여
    //      다른 API(/api/games/finish.ts 등)에서 idempotency 에 활용 가능
    // ─────────────────────────────────────────────
    try {
      if (idem) {
        // 멱등키 기반: 같은 키로 다시 들어오면 double-spend 방지
        const rows = (await sql/* sql */ `
          insert into transactions (
            user_id,
            type,
            amount,
            reason,
            game,
            exp_delta,
            tickets_delta,
            plays_delta,
            ref_table,
            ref_id,
            idempotency_key,
            run_id,
            meta,
            note
          )
          values (
            ${userId}::uuid,
            ${txType}::txn_type,
            ${amountBig.toString()}::bigint,
            ${reason},
            ${game},
            ${expDelta},
            ${ticketsDelta},
            ${playsDelta},
            ${refTable},
            ${refId},
            ${idem},
            ${runId},
            ${JSON.stringify(meta)}::jsonb,
            ${note}
          )
          on conflict (idempotency_key) do nothing
          returning balance_after
        `) as TxInsertResultRow[];

        usedIdempotent = true;

        // 새로 insert 된 경우에만 balance_after 반환
        if (rows && rows.length > 0 && rows[0].balance_after != null) {
          balanceAfter = Number(rows[0].balance_after);
        }
        // rows.length === 0 인 경우: 이미 처리된 멱등키 → 재호출을 무시하고 ok: true 반환
      } else {
        const rows = (await sql/* sql */ `
          insert into transactions (
            user_id,
            type,
            amount,
            reason,
            game,
            exp_delta,
            tickets_delta,
            plays_delta,
            ref_table,
            ref_id,
            run_id,
            meta,
            note
          )
          values (
            ${userId}::uuid,
            ${txType}::txn_type,
            ${amountBig.toString()}::bigint,
            ${reason},
            ${game},
            ${expDelta},
            ${ticketsDelta},
            ${playsDelta},
            ${refTable},
            ${refId},
            ${runId},
            ${JSON.stringify(meta)}::jsonb,
            ${note}
          )
          returning balance_after
        `) as TxInsertResultRow[];

        if (rows && rows.length > 0 && rows[0].balance_after != null) {
          balanceAfter = Number(rows[0].balance_after);
        }
      }
      // 여기까지 오면 트리거가 user_stats(coins, exp, tickets, games_played)를 자동 갱신
    } catch (e) {
      // 스키마 문제(테이블/컬럼 없음)면 명시적인 에러 메시지로 반환
      if (isWalletSchemaMissing(e)) {
        return withCORS(
          json(
            {
              error:
                "Wallet schema is not initialized. Run DB migrations for transactions/user_stats.",
            },
            { status: 400, headers: { "Cache-Control": "no-store" } }
          ),
          env.CORS_ORIGIN
        );
      }
      // 잔액 부족 에러는 공통 코드로 매핑
      if (isInsufficientBalanceError(e)) {
        return withCORS(
          json(
            { error: "insufficient_funds" },
            { status: 400, headers: { "Cache-Control": "no-store" } }
          ),
          env.CORS_ORIGIN
        );
      }
      // 그 외 예외(제약조건 위반 등)는 그대로 상위로
      throw e;
    }

    const tookMs = Math.round(performance.now() - t0);

    // ─────────────────────────────────────────────
    // 4) 트랜잭션 이후 최신 user_stats 조회 (balance.ts와 동일 구조)
    //    - 프론트가 즉시 최신 잔액/스탯을 알 수 있도록 헤더로 제공
    // ─────────────────────────────────────────────
    const stats = await fetchUserStats(sql, userId);

    const finalCoins =
      stats.found && Number.isFinite(Number(stats.coins))
        ? Number(stats.coins)
        : balanceAfter ?? 0;
    const finalExp = stats.exp;
    const finalTickets = stats.tickets;
    const finalGames = stats.gamesPlayed;

    const statsSummary = {
      balance: finalCoins,
      exp: finalExp,
      tickets: finalTickets,
      gamesPlayed: finalGames,
    };

    // ─────────────────────────────────────────────
    // 5) analytics_events 에 wallet_tx 로그 남기기 (선택 기능)
    // ─────────────────────────────────────────────
    const analyticsPayload = {
      txType,
      amount: amountBig.toString(),
      reason: reason,
      game,
      expDelta,
      ticketsDelta,
      playsDelta,
      refTable,
      refId,
      idempotencyKey: idem,
      balanceAfter: balanceAfter,
      coinsAfter: finalCoins,
      expAfter: finalExp,
      ticketsAfter: finalTickets,
      gamesAfter: finalGames,
      tookMs,
      // runId 도 메타에 함께 포함 (분석 용도)
      runId,
    };

    // 실패해도 전체 트랜잭션에는 영향 없음 (fire-and-forget 느낌)
    try {
      await logAnalyticsEvent(sql, userId, game, "wallet_tx", analyticsPayload);
    } catch {
      // ignore
    }

    // ─────────────────────────────────────────────
    // 6) 응답: 외부 계약 유지 { ok: true } + 보조 헤더들
    // ─────────────────────────────────────────────
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Wallet-User": userId,
      "X-Wallet-Delta": amountBig.toString(),
      "X-Wallet-Idempotent": String(usedIdempotent),
      "X-Wallet-Type": txType,
      "X-Wallet-Game": game || "",
      "X-Wallet-Exp-Delta": String(expDelta),
      "X-Wallet-Tickets-Delta": String(ticketsDelta),
      "X-Wallet-Plays-Delta": String(playsDelta),
      "X-Wallet-Ref-Table": refTable || "",
      "X-Wallet-Ref-Id": refId != null ? String(refId) : "",
      "X-Wallet-Took-ms": String(tookMs),
    };

    if (balanceAfter !== null) {
      headers["X-Wallet-Balance"] = String(balanceAfter);
    } else if (Number.isFinite(finalCoins)) {
      headers["X-Wallet-Balance"] = String(finalCoins);
    }

    if (stats.lastLoginAt) {
      headers["X-Wallet-Last-Login-At"] = stats.lastLoginAt;
    }
    if (stats.updatedAt) {
      headers["X-Wallet-Stats-Updated-At"] = stats.updatedAt;
    }

    // balance.ts 와 동일 형식의 요약 JSON 헤더
    try {
      headers["X-Wallet-Stats-Json"] = JSON.stringify(statsSummary);
    } catch {
      // stringify 실패는 무시
    }

    // 디버그 용: 원하면 프론트에서 X-Wallet-Debug 를 켜서 확인 가능 (선택)
    const debugRequested =
      request.headers.get("X-Wallet-Debug") === "1" ||
      request.headers.get("x-wallet-debug") === "1";
    if (debugRequested) {
      try {
        headers["X-Wallet-Debug-Meta"] = JSON.stringify({
          userId,
          game,
          txType,
          idem,
          runId,
        });
      } catch {
        // ignore
      }
    }

    return withCORS(
      json(
        { ok: true },
        {
          headers,
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
