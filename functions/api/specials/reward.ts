// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\specials\reward.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → add small ambient type (editor-only)
// - ts(7031) request/env implicitly any        → annotate handler params
// - Keep every route/contract/behavior exactly the same
// - Same security/rate-limit/idempotency behavior as before

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
import * as Rate from "../_utils/rate-limit";

/**
 * 계약 유지:
 * - 라우트/메서드 동일(POST)
 * - 입력: { userId, eventId } 요구
 * - 성공 응답 스키마 동일: { ok: true }
 *
 * 보강:
 * - Rate limit(429) 및 멱등키(Idempotency-Key) 지원 → 중복 보상 방지
 * - 입력 정규화: userId 허용문자/길이, eventId 정수화
 * - 스키마 자동 보강: created_at, idempotency_key, 인덱스 추가
 * - 초기 상태 내성(테이블 미존재 시 생성)
 * - 운영 헤더: Cache-Control, 처리시간, 중복 여부(X-Reward-Status)
 */

/* ───────── helpers ───────── */
function cleanUserId(v: unknown): string {
  const s = (typeof v === "string" ? v : "").trim().normalize("NFKC");
  if (!/^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s)) throw new Error("Invalid userId");
  return s;
}
function toEventId(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("Invalid eventId");
  const i = Math.floor(n);
  if (i < 1) throw new Error("Invalid eventId");
  return i;
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
    const userId = cleanUserId((body as any)?.userId);
    const eventId = toEventId((body as any)?.eventId);

    const sql = getSql(env);

    // ── 스키마 보강(존재 시 무시) ───────────────────────────────────────
    try {
      await sql`
        create table if not exists event_rewards(
          user_id text not null,
          event_id bigint not null,
          awarded_at timestamptz not null default now(),
          idempotency_key text unique,
          primary key(user_id, event_id)
        )
      `;
      await sql`alter table event_rewards add column if not exists idempotency_key text unique`;
      await sql`create index if not exists event_rewards_user_idx on event_rewards (user_id, awarded_at desc)`;
      await sql`create index if not exists event_rewards_event_idx on event_rewards (event_id)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 초기 경쟁 상태 등 비치명적 오류는 무시하고 계속 진행
      }
    }

    // ── 멱등 삽입 ───────────────────────────────────────────────────────
    const idem = getIdemKey(request);
    let created = false;

    if (idem) {
      // 같은 userId/eventId 조합과 별개로 동일 요청 재시도까지 안전
      await sql`
        insert into event_rewards(user_id, event_id, idempotency_key)
        values(${userId}, ${eventId}, ${idem})
        on conflict (idempotency_key) do nothing
      `;
      // 상태 파악: 방금 혹은 이전에 이미 지급되었는지
      const chk = await sql`
        select 1
        from event_rewards
        where (idempotency_key = ${idem})
           or (user_id = ${userId} and event_id = ${eventId})
        limit 1
      `;
      created = (chk as any[]).length === 1; // 존재하면 지급 완료 상태
    } else {
      const res = await sql`
        insert into event_rewards(user_id, event_id)
        values(${userId}, ${eventId})
        on conflict do nothing
        returning 1
      `;
      created = (res as any[]).length === 1;
    }

    return withCORS(
      json(
        { ok: true }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Reward-Status": created ? "created" : "duplicate",
            "X-Reward-Took-ms": String(Math.round(performance.now() - t0)),
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

/* Notes
 - The tiny PagesFunction declaration is safe for editors and does not affect runtime.
 - All behavior, inputs, and outputs match your original contract.
 - No generic type arguments are passed to the SQL template (avoids ts(2558) in other files).
*/
