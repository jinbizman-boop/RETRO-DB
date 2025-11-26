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
//     • user_stats(coins, exp, tickets, games_played, updated_at) 자동 갱신
// - 더 이상 wallet_balances / wallet_tx 별도 테이블 사용 ❌
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

/* ───────── constants / helpers ───────── */

/**
 * users.id = UUID (001_init.sql 기반) 이므로, UUID 강제
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * userId 우선순위
 *  1) X-User-Id / x-user-id 헤더 (미들웨어에서 JWT sub 기반으로 세팅)
 *  2) validateTransaction 이 반환한 body.userId
 */
function resolveUserId(req: Request, bodyUserId: unknown): string {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";

  let candidate = (headerId || String(bodyUserId ?? "")).trim();
  try {
    candidate = candidate.normalize("NFKC");
  } catch {
    // 일부 런타임에서 normalize 미지원 시 조용히 무시
  }

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
 * transactions 테이블 자체가 없는 경우, 혹은 user_stats 가 없는 경우
 * → "Wallet schema is not initialized" 로 통합
 */
function isWalletSchemaMissing(err: any): boolean {
  if (isMissingTable(err)) return true;
  const msg = String(err?.message ?? err).toLowerCase();
  if (msg.includes("apply_wallet_transaction")) return true;
  if (msg.includes("user_stats") && msg.includes("does not exist")) return true;
  return false;
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

    // ──────────────────────────────────────────────────────────
    // 1차: 기존 스키마 검증(계약 유지)
    //     validateTransaction 이 userId / amount / reason / game / meta 등을 1차 정제
    // ──────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────
    // 2차: 서버측 보수적 정규화 (userId/amount/reason/game/ref/meta)
    // ──────────────────────────────────────────────────────────

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
    const txType: "earn" | "spend" =
      amountBig >= 0n ? "earn" : ("spend" as const);

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
        // 환경 힌트 (서비스/스테이징 구분용)
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

    try {
      // ──────────────────────────────────────────────────────────
      // 3) canonical 경로: transactions insert
      //    - BEFORE INSERT 트리거 apply_wallet_transaction 가
      //      user_stats(coins, xp, tickets, games_played)를 갱신
      // ──────────────────────────────────────────────────────────

      if (idem) {
        // 멱등키 기반: 같은 키로 다시 들어오면 double-spend 방지
        const rows = await sql/* sql */ `
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
            ${JSON.stringify(meta)}::jsonb,
            ${note}
          )
          on conflict (idempotency_key) do nothing
          returning balance_after
        `;
        usedIdempotent = true;

        // 새로 insert 된 경우에만 balance_after 반환
        if (rows && rows.length > 0 && rows[0].balance_after != null) {
          balanceAfter = Number(rows[0].balance_after);
        }
        // rows.length === 0 인 경우: 이미 처리된 멱등키 → 재호출을 무시하고 ok: true 반환
      } else {
        const rows = await sql/* sql */ `
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
            ${JSON.stringify(meta)}::jsonb,
            ${note}
          )
          returning balance_after
        `;
        if (rows && rows.length > 0 && rows[0].balance_after != null) {
          balanceAfter = Number(rows[0].balance_after);
        }
      }
      // apply_wallet_transaction BEFORE INSERT 트리거가
      // user_stats(coins, exp, tickets, games_played)를 자동 갱신한다.
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

    // ──────────────────────────────────────────────────────────
    // 4) 응답: 외부 계약 유지 { ok: true } + 보조 헤더들
    // ──────────────────────────────────────────────────────────
    return withCORS(
      json(
        { ok: true },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Wallet-User": userId,
            "X-Wallet-Delta": amountBig.toString(),
            "X-Wallet-Idempotent": String(usedIdempotent),
            ...(balanceAfter !== null
              ? { "X-Wallet-Balance": String(balanceAfter) }
              : {}),
            "X-Wallet-Type": txType,
            "X-Wallet-Game": game || "",
            "X-Wallet-Exp-Delta": String(expDelta),
            "X-Wallet-Tickets-Delta": String(ticketsDelta),
            "X-Wallet-Plays-Delta": String(playsDelta),
            "X-Wallet-Ref-Table": refTable || "",
            "X-Wallet-Ref-Id": refId != null ? String(refId) : "",
            "X-Wallet-Took-ms": String(tookMs),
          },
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
