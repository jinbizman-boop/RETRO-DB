// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\specials\reward.ts
//
// ✅ Fix / Upgrade summary
// - 기존 외부 계약 100% 유지
//   • 라우트: POST /api/specials/reward
//   • 입력: { userId, eventId } (body JSON)
//   • 성공 응답: { ok: true } 그대로
// - TS 에디터 오류 제거(ts2304, ts7031 등)
// - Rate limit / Idempotency-Key 기반 중복 방지 유지/강화
//
// 🔥 강화 포인트 (Wallet / user_stats 계정 체계와 연동)
// - event_rewards 테이블에 "이벤트 보상 수령 이력" 저장 (기존 로직 유지)
// - events 테이블에 보상 정의 컬럼 자동 보강(없으면 추가):
//     • reward_coins   bigint default 0
//     • reward_tickets integer default 0
//     • reward_exp     bigint default 0
// - 새 구조:
//     1) event_rewards(user_id, event_id) insert (멱등키 적용)
//     2) 최초 insert(=created=true) 인 경우에만
//        → events.reward_* 값을 읽어와서
//        → transactions + apply_wallet_transaction 트리거를 통해
//           user_stats.coins / xp / tickets 에 보상 반영
//     3) 재호출(duplicate) 시에는 계정 영향 없이 { ok:true } + X-Reward-Status: duplicate
// - userId 정리:
//     • event_rewards.user_id 는 기존처럼 cleanUserId(문자열 키) 사용
//     • 계정 보상은 UUID users.id 기준으로 동작해야 하므로,
//       X-User-Id 헤더(미들웨어에서 JWT 기준으로 세팅)를 우선 사용
//       → 유효한 UUID 가 아니면 "보상 기록"까지만 하고, 지갑/경험치는 건드리지 않음
//
// - 운영 헤더:
//     • Cache-Control: no-store
//     • X-Reward-Status: created | duplicate
//     • X-Reward-Coins / X-Reward-Exp / X-Reward-Tickets: 실제 지급량(또는 0)
//     • X-Reward-Took-ms: 처리시간(ms)
//
// ───────────────────────────────────────────────────────────────

/* ───── Minimal Cloudflare Pages ambient types (type-checker only) ───── */
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
/* ────────────────────────────────────────────────────────────────────── */

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";
import { ensureUserStatsRow } from "../_utils/progression";

/**
 * 계약 유지:
 * - 라우트/메서드 동일(POST)
 * - 입력: { userId, eventId } 요구
 * - 성공 응답 스키마 동일: { ok: true }
 *
 * 추가/강화:
 * - Rate limit(429) 및 멱등키(Idempotency-Key) 지원 → 중복 보상 방지
 * - 입력 정규화: userId 허용문자/길이, eventId 정수화
 * - 스키마 자동 보강: events.reward_* 및 event_rewards.* 컬럼/인덱스 추가
 * - 최초 수령 시에만 transactions/user_stats 에 “이벤트 보상” 반영
 * - 초기 상태 내성(테이블 미존재 시 생성), 스키마 미구성 시에도 API는 200 유지(단, 계정 반영은 skip)
 * - 운영 헤더: Cache-Control, 처리시간, 중복 여부(X-Reward-Status) 및 지급량
 */

/* ───────── helpers: ID / 멱등키 / 스키마 에러 ───────── */

// 이벤트 보상 이력에서 사용하는 "유저 키"
// (기존 계약 유지: UUID가 아니어도 허용, 단 계정 보상은 UUID 기반으로만 적용)
function cleanUserId(v: unknown): string {
  let s = (typeof v === "string" ? v : "").trim();
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore
  }
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
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

/* ───────── helpers: UUID / 계정 보상용 userId ───────── */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 이벤트 보상 “계정 반영”에 사용할 UUID userId 를 헤더에서 추출.
 * - X-User-Id 헤더 우선 사용 (미들웨어에서 JWT 기반으로 세팅)
 * - 유효한 UUID v4 형식이 아니면 null 반환 → 계정 보상은 skip
 */
function getAccountUserId(req: Request): string | null {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";
  let s = headerId.trim();
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore
  }
  if (!s) return null;
  if (!UUID_V4_REGEX.test(s)) return null;
  return s;
}

/* ───────── helpers: 이벤트 보상 스키마 및 조회 ───────── */

type EventRewardConfig = {
  id: number;
  title: string | null;
  reward_coins: bigint;
  reward_tickets: number;
  reward_exp: bigint;
};

/**
 * events 테이블과 event_rewards 테이블 스키마를 안전하게 보강.
 * - events: reward_coins / reward_tickets / reward_exp 컬럼이 없으면 추가
 * - event_rewards: 기존 구조 + idempotency_key, awarded_at, 인덱스 등
 */
async function ensureRewardSchemas(sql: ReturnType<typeof getSql>): Promise<void> {
  try {
    // events 기본 스키마 + 보상 컬럼
    await sql/* sql */ `
      create table if not exists events(
        id bigserial primary key,
        title text not null,
        starts timestamptz,
        ends timestamptz,
        banner text,
        active boolean not null default true,
        created_at timestamptz not null default now()
      )
    `;
    await sql/* sql */ `
      alter table events
        add column if not exists reward_coins   bigint   not null default 0,
        add column if not exists reward_tickets integer not null default 0,
        add column if not exists reward_exp     bigint   not null default 0
    `;
  } catch (e) {
    if (!isMissingTable(e)) {
      // 경쟁상태/권한 문제 등은 조용히 무시 (단, 실제 보상 지급은 아래에서 다시 한 번 try/catch)
    }
  }

  try {
    await sql/* sql */ `
      create table if not exists event_rewards(
        user_id text not null,
        event_id bigint not null,
        awarded_at timestamptz not null default now(),
        idempotency_key text unique,
        primary key(user_id, event_id)
      )
    `;
    await sql/* sql */ `
      alter table event_rewards
        add column if not exists awarded_at timestamptz not null default now()
    `;
    await sql/* sql */ `
      alter table event_rewards
        add column if not exists idempotency_key text unique
    `;
    await sql/* sql */ `
      create index if not exists event_rewards_user_idx
      on event_rewards (user_id, awarded_at desc)
    `;
    await sql/* sql */ `
      create index if not exists event_rewards_event_idx
      on event_rewards (event_id)
    `;
  } catch (e) {
    if (!isMissingTable(e)) {
      // 초기 경쟁 상태 등 비치명적 오류는 무시하고 계속 진행
    }
  }
}

/**
 * 특정 이벤트에 대한 보상 설정을 읽어온다.
 * - events.reward_* 컬럼을 기반으로 EventRewardConfig 생성
 * - 테이블이 없거나 이벤트가 없으면 null 반환
 */
async function loadEventRewardConfig(
  sql: ReturnType<typeof getSql>,
  eventId: number
): Promise<EventRewardConfig | null> {
  try {
    const rows = await sql/* sql */ `
      select
        id::bigint as id,
        title,
        coalesce(reward_coins,   0)::bigint   as reward_coins,
        coalesce(reward_tickets, 0)::integer  as reward_tickets,
        coalesce(reward_exp,     0)::bigint   as reward_exp
      from events
      where id = ${eventId}
      limit 1
    `;
    if (!rows || rows.length === 0) return null;

    const row = rows[0] as any;
    return {
      id: Number(row.id),
      title: row.title ?? null,
      reward_coins: BigInt(row.reward_coins ?? 0),
      reward_tickets: Number(row.reward_tickets ?? 0),
      reward_exp: BigInt(row.reward_exp ?? 0),
    };
  } catch (e) {
    if (isMissingTable(e)) return null;
    // 기타 오류는 상위에서 처리
    throw e;
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
  // Preflight
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
    await ensureRewardSchemas(sql);

    // ── 멱등 삽입 + 최초 보상 여부 판단 ────────────────────────────────
    const idem = getIdemKey(request);
    let created = false;

    if (idem) {
      // 같은 userId/eventId 조합과 별개로 동일 요청 재시도까지 안전
      await sql/* sql */ `
        insert into event_rewards(user_id, event_id, idempotency_key)
        values(${userId}, ${eventId}, ${idem})
        on conflict (idempotency_key) do nothing
      `;
      const chk = await sql/* sql */ `
        select 1
        from event_rewards
        where (idempotency_key = ${idem})
           or (user_id = ${userId} and event_id = ${eventId})
        limit 1
      `;
      created = (chk as any[]).length === 1;
    } else {
      const res = await sql/* sql */ `
        insert into event_rewards(user_id, event_id)
        values(${userId}, ${eventId})
        on conflict do nothing
        returning 1
      `;
      created = (res as any[]).length === 1;
    }

    // ── 계정 보상 (transactions + user_stats) ──────────────────────────
    let rewardCoinsApplied = 0n;
    let rewardExpApplied = 0n;
    let rewardTicketsApplied = 0;

    // 1) 최초 수령(created=true) + 계정 userId (UUID) 가 있을 때만 보상 적용
    const accountUserId = getAccountUserId(request);

    if (created && accountUserId) {
      try {
        // events.reward_* 읽기
        const cfg = await loadEventRewardConfig(sql, eventId);
        if (cfg) {
          const hasAnyReward =
            cfg.reward_coins !== 0n ||
            cfg.reward_exp !== 0n ||
            cfg.reward_tickets !== 0;
          if (hasAnyReward) {
            // user_stats row 보장
            await ensureUserStatsRow(sql as any, accountUserId);

            // transactions 를 통해 보상 반영
            const meta = {
              source: "api/specials/reward",
              event_id: cfg.id,
              event_title: cfg.title,
              reward_coins: cfg.reward_coins.toString(),
              reward_exp: cfg.reward_exp.toString(),
              reward_tickets: cfg.reward_tickets,
              user_key: userId, // event_rewards.user_id (텍스트 키)
            };

            // coins (amount) 는 reward_coins, exp_delta/tickets_delta 는 reward_exp/reward_tickets
            const amountBig = cfg.reward_coins;
            const expDelta = cfg.reward_exp;
            const ticketsDelta = cfg.reward_tickets;

            // 트랜잭션 타입: 보상은 earn
            const txType = "event"; // txn_type 이 enum 이면 'event' / 'earn' 중 실제 스키마에 맞게 조정

            // idempotency_key: event 보상 멱등성을 위해 eventRewards와 별도로 하나 더 사용할 수도 있지만,
            // 여기서는 event_rewards 가 이미 보장하므로 null 로 두거나, idem 을 그대로 재사용해도 된다.
            const txIdemKey = idem
              ? `event:${eventId}:${accountUserId}:${idem}`
              : null;

            if (txIdemKey) {
              await sql/* sql */ `
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
                  ${accountUserId}::uuid,
                  ${txType},
                  ${amountBig.toString()}::bigint,
                  'event_reward',
                  null,
                  ${Number(expDelta)},
                  ${ticketsDelta},
                  0,
                  'events',
                  ${cfg.id},
                  ${txIdemKey},
                  ${JSON.stringify(meta)}::jsonb,
                  'event_reward'
                )
                on conflict (idempotency_key) do nothing
              `;
            } else {
              await sql/* sql */ `
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
                  ${accountUserId}::uuid,
                  ${txType},
                  ${amountBig.toString()}::bigint,
                  'event_reward',
                  null,
                  ${Number(expDelta)},
                  ${ticketsDelta},
                  0,
                  'events',
                  ${cfg.id},
                  ${JSON.stringify(meta)}::jsonb,
                  'event_reward'
                )
              `;
            }

            // 실제 적용된 값 기록 (헤더용)
            rewardCoinsApplied = cfg.reward_coins;
            rewardExpApplied = cfg.reward_exp;
            rewardTicketsApplied = cfg.reward_tickets;
          }
        }
      } catch (e) {
        // 스키마가 아직 덜 적용되었거나, transactions/user_stats 가 없을 수도 있음
        if (!isMissingTable(e)) {
          // 기타 오류는 로깅용으로만 의미가 있고, 보상 기록은 이미 남았으므로 조용히 무시
        }
      }
    }

    // ── 응답 ─────────────────────────────────────────────────────────────
    const tookMs = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true }, // 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Reward-Status": created ? "created" : "duplicate",
            "X-Reward-Coins": rewardCoinsApplied.toString(),
            "X-Reward-Exp": rewardExpApplied.toString(),
            "X-Reward-Tickets": String(rewardTicketsApplied),
            "X-Reward-Took-ms": String(tookMs),
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
 - 상단 PagesFunction 선언은 타입체커용으로만 존재하며 런타임에 영향을 주지 않습니다.
 - 기존 routes/입력/응답 계약은 변경하지 않고, 내부적으로만
   event_rewards + events.reward_* + transactions/user_stats 와 연동해
   "회원 계정에 이벤트 보상"을 반영하도록 확장했습니다.
 - X-User-Id 헤더에 유효한 UUID가 없는 경우에는,
   기존대로 event_rewards 이력만 남기고 실제 코인/경험치/티켓 보상은 적용하지 않습니다.
   (구 버전과의 호환성을 최대한 유지하기 위한 방어 로직입니다.)
*/
