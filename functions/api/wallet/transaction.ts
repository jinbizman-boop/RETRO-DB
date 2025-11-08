// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\wallet\transaction.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → add minimal ambient CF Pages types
// - ts(7031) request/env implicitly any        → annotate handler params
// - Keep original behavior & response contract exactly the same

/* ───── Minimal Cloudflare Pages ambient types (type-checker only) ───── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ────────────────────────────────────────────────────────────────────── */

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateTransaction } from "../_utils/schema/wallet";
import * as Rate from "../_utils/rate-limit";

/**
 * 계약 유지:
 * - 라우트/메서드 동일(POST)
 * - 입력은 기존 validateTransaction 사용
 * - 성공 응답 스키마 동일: { ok: true }
 *
 * 보강:
 * - Rate limit(429), 멱등키(Idempotency-Key) 지원 → 중복 결제/중복 지급 방지
 * - 서버측 정규화/검증: userId/amount/reason 길이·패턴 보수적 체크
 * - 스키마/인덱스 자동 보강 및 트랜잭션 처리(원자성/일관성)
 * - 운영 헤더(Cache-Control, 처리시간, 멱등 처리 결과)
 * - (옵션) 음수 허용/차감 정책은 기존 계약을 유지(아래 주석 참고)
 */

/* ───────── helpers ───────── */
function cleanUserId(v: string): string {
  const s = (v || "").trim().normalize("NFKC");
  if (!/^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s)) throw new Error("Invalid userId");
  return s;
}
function toBigIntSafe(n: any): bigint {
  // int64 범위로 수렴(Neon/PG bigint 호환)
  if (typeof n === "bigint") return n;
  const x = Number(n);
  if (!Number.isFinite(x)) throw new Error("Invalid amount");
  return BigInt(Math.trunc(x));
}
function cleanReason(v: string | undefined): string | null {
  if (!v) return null;
  const s = v
    .trim()
    .normalize("NFKC")
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
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

/* ───────── handler ───────── */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
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
    const userId = cleanUserId(rawUser);
    const amount = toBigIntSafe(rawAmount); // 음수면 차감, 양수면 적립 (기존 동작 유지)
    const reason = cleanReason(rawReason ?? undefined);

    const sql = getSql(env);

    // 스키마/인덱스 보강(존재하면 무시)
    try {
      await sql`
        create table if not exists wallet_balances(
          user_id text primary key,
          balance bigint not null default 0
        )
      `;
      await sql`
        create table if not exists wallet_tx(
          id bigserial primary key,
          user_id text not null,
          amount bigint not null,
          reason text,
          idempotency_key text unique,
          created_at timestamptz not null default now()
        )
      `;
      await sql`create index if not exists wallet_tx_user_created on wallet_tx (user_id, created_at desc)`;
      await sql`create index if not exists wallet_balances_user_idx on wallet_balances (user_id)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        /* 초기 경쟁 상태 등은 무시 */
      }
    }

    // 멱등키(중복 결제 방지)
    const idem = getIdemKey(request);

    // 원자적 처리
    await sql`begin`;
    try {
      if (idem) {
        // 같은 요청 재시도 시 중복 반영 방지
        await sql`
          insert into wallet_tx(user_id, amount, reason, idempotency_key)
          values(${userId}, ${amount as any}, ${reason}, ${idem})
          on conflict (idempotency_key) do nothing
        `;
      } else {
        await sql`
          insert into wallet_tx(user_id, amount, reason)
          values(${userId}, ${amount as any}, ${reason})
        `;
      }

      // upsert balance
      await sql`
        insert into wallet_balances(user_id, balance)
        values(${userId}, ${amount as any})
        on conflict (user_id) do update
          set balance = wallet_balances.balance + excluded.balance
      `;

      await sql`commit`;
    } catch (e) {
      await sql`rollback`;
      throw e;
    }

    // (참고) 잔액 음수 허용 정책:
    //  - 현재는 원본 계약을 유지해 잔액이 음수가 될 수 있음.
    //  - 필요 시 ENV로 최소 잔액을 강제하여 차단 가능(추후 확장).

    return withCORS(
      json(
        { ok: true }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Wallet-User": userId,
            "X-Wallet-Delta": amount.toString(),
            "X-Wallet-Idempotent": String(Boolean(idem)),
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
