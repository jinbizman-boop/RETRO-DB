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
// 🔥 스키마 / 시스템 정합 강화
// - 더 이상 wallet_balances / wallet_tx 별도 테이블 사용하지 않음
// - migrations/001_init.sql 기준 canonical 스키마 사용:
//     • transactions 테이블 + apply_wallet_transaction BEFORE INSERT 트리거
//     • user_stats(coins, exp, tickets, games_played) 자동 갱신
// - userId 소스:
//     • 1순위: _middleware.ts 가 주입한 X-User-Id 헤더 (UUID users.id)
//     • 2순위: body.userId (백업용, 없어도 헤더만으로 동작)
// - amount > 0 → type 'earn', amount < 0 → type 'spend'
// - tickets / exp / plays_delta 는 기본 0, 필요 시 body에서 확장 가능(옵셔널)


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

/* ───────── helpers ───────── */

// users.id = UUID (001_init.sql 기반) 이므로, UUID 강제
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
  const candidate = (headerId || String(bodyUserId ?? "")).trim().normalize("NFKC");
  if (!candidate) throw new Error("Missing userId");
  if (!UUID_V4_REGEX.test(candidate)) {
    throw new Error("Invalid userId");
  }
  return candidate;
}

// 과거 버전과 이름을 맞추기 위해 toBigIntSafe 이름 유지
// 실제로는 JS number를 bigint 문자열로 안전히 변환하는 역할
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

function cleanReason(v: string | undefined): string | null {
  if (!v) return null;
  const s = v
    .trim()
    .normalize("NFKC")
    // 제어문자 제거
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!s) return null;
  return s.length > 120 ? s.slice(0, 120) : s;
}

function getIdemKey(req: Request): string | null {
  return (
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key") ||
    req.headers.get("x-idempotency-key")
  );
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

// exp/tickets/plays_delta 등의 정수 보정
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

// 간단 meta sanitization
function sanitizeMeta(meta: any): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  try {
    // 순수 JSON 객체만 허용 (순환참조 방지)
    JSON.stringify(meta);
    return meta as Record<string, unknown>;
  } catch {
    return {};
  }
}

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

/* ───────── handler ───────── */
export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 남용 방지
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

    // 1차: 기존 스키마 검증(계약 유지)
    const {
      userId: rawUser,
      amount: rawAmount,
      reason: rawReason,
    } = validateTransaction(body);

    // 2차: 서버측 보수적 정규화
    const userId = resolveUserId(request, rawUser);
    const amountBig = toBigIntSafe(rawAmount); // bigint
    const reason = cleanReason(rawReason ?? undefined);

    // txn_type: amount 부호에 따라 earn / spend
    // (구매 등 특수 케이스는 추후 전용 엔드포인트 사용 권장)
    const txType: "earn" | "spend" =
      amountBig >= 0n ? "earn" : ("spend" as const);

    // 확장 필드 (optional) — 없으면 0 / null 로 처리
    const expDelta = toDeltaInt((body as any).expDelta);
    const ticketsDelta = toDeltaInt((body as any).ticketsDelta);
    const playsDelta = toDeltaInt((body as any).playsDelta);
    const game =
      typeof (body as any).game === "string"
        ? (body as any).game.trim().toLowerCase().slice(0, 64)
        : null;
    const clientMeta = getClientMeta(request);
    const userMeta = sanitizeMeta((body as any).meta);
    const meta = {
      ...userMeta,
      source: "api/wallet/transaction",
      ip: clientMeta.ip,
      ua: clientMeta.ua,
    };

    const idem = getIdemKey(request);
    const sql = getSql(env);

    // note: transactions.note 는 구버전 reason 대응, 새 reason 컬럼은 text로 확장
    const note = reason;

    let balanceAfter: number | null = null;

    try {
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
            null,            -- ref_table (옵션)
            null,            -- ref_id    (옵션)
            ${idem},
            ${JSON.stringify(meta)}::jsonb,
            ${note}
          )
          on conflict (idempotency_key) do nothing
          returning balance_after
        `;
        if (rows && rows.length > 0 && rows[0].balance_after != null) {
          balanceAfter = Number(rows[0].balance_after);
        }
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
            null,
            null,
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
      // 스키마 문제(테이블/컬럼 없음)면 그대로 에러를 던져서 상위 catch → 400
      if (isMissingTable(e)) {
        throw new Error(
          "Wallet schema is not initialized. Run DB migrations for transactions/user_stats."
        );
      }
      // 그 외 예외(잔액 부족 등)는 그대로 상위로 올려서 클라이언트에 메시지 전달
      throw e;
    }

    return withCORS(
      json(
        { ok: true }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Wallet-User": userId,
            "X-Wallet-Delta": amountBig.toString(),
            "X-Wallet-Idempotent": String(Boolean(idem)),
            ...(balanceAfter !== null
              ? { "X-Wallet-Balance": String(balanceAfter) }
              : {}),
            "X-Wallet-Took-ms": String(Math.round(performance.now() - t0)),
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
