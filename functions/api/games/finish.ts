// functions/api/game/finish.ts
// ───────────────────────────────────────────────────────────────
// RETRO-GAMES Cloudflare API: 게임 1판 종료 처리 엔드포인트
//
// ① 회원가입/로그인 기능과 완전 연동
//    - _middleware.ts 에서 검증된 JWT → data.auth.userId 사용
// ② 게임 플레이 후 경험치/포인트/티켓 자동 저장
//    - user_stats: xp/exp/coins/tickets/games_played 누적
//    - user_wallet: points/tickets 누적 (상점 결제용 지갑)
// ③ shop_items / wallet 과 정합성
//    - user_wallet 스키마를 signup/login 과 동일한 형태로 방어적 보강
// ④ analytics_events 자동 기록
//    - event_name = 'game_finish'
//    - gameId, score, result, mode, duration 등 메타데이터 JSON 저장
//
// 외부 계약(Contract)
//    - 메서드: POST /api/game/finish
//    - 인증: _middleware 에서 Authorization: Bearer <JWT> 검증 후 data.auth.userId 주입
//    - 요청 JSON:
//        {
//          "gameId": "tetris" | "2048" | "dino" | ...,
//          "score": 12345,
//          "durationSec": 120,        // optional
//          "mode": "normal" | "hard", // optional
//          "result": "win" | "lose" | "clear" | ... // optional
//        }
//    - 응답 JSON (성공 시):
//        {
//          "ok": true,
//          "gainedExp": number,
//          "gainedPoints": number,
//          "gainedTickets": number,
//          "snapshot": {
//            "stats": { ...user_stats 일부 요약... },
//            "wallet": { "points": number, "tickets": number }
//          }
//        }
//
// CORS / Rate-limit / DB 에러 포맷은 signup.ts / login.ts 와 동일 스타일 유지
// ───────────────────────────────────────────────────────────────

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

/* ───────────────────────────────────────────────────────────────
   Minimal Cloudflare Pages ambient types (VSCode 편의를 위해)
──────────────────────────────────────────────────────────────── */
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

/* ───────────────────────────────────────────────────────────────
   Helpers: 숫자/문자/메타 파싱
──────────────────────────────────────────────────────────────── */

function toNumber(v: unknown, def: number = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  return def;
}

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

type GameFinishPayload = {
  gameId: string;
  score: number;
  durationSec?: number | null;
  mode?: string | null;
  result?: string | null;
};

function parseGameFinishBody(body: unknown): GameFinishPayload {
  const b = body as any;

  const rawGameId = toStringOrNull(b?.gameId) ?? toStringOrNull(b?.game_id);
  const score = toNumber(b?.score, NaN);
  const durationSec = Number.isFinite(toNumber(b?.durationSec)) ? toNumber(b?.durationSec) : undefined;
  const mode = toStringOrNull(b?.mode);
  const result = toStringOrNull(b?.result);

  if (!rawGameId) {
    throw new Error("game_id_required");
  }
  if (!Number.isFinite(score)) {
    throw new Error("score_required");
  }
  if (score < 0) {
    throw new Error("score_must_be_non_negative");
  }

  const gameId = rawGameId.trim();
  if (!gameId.length) {
    throw new Error("game_id_required");
  }

  return {
    gameId,
    score,
    durationSec,
    mode,
    result,
  };
}

/* ───────────────────────────────────────────────────────────────
   Helpers: 클라이언트 메타데이터 (IP / UA)
──────────────────────────────────────────────────────────────── */
function getClientMeta(request: Request) {
  const headers = request.headers;
  const ip =
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    null;
  const ua = headers.get("user-agent") || null;
  return { ip, ua };
}

/* ───────────────────────────────────────────────────────────────
   Schema Guards: user_stats / user_wallet / analytics_events
   - signup.ts / login.ts 와 정합성 맞추기 위해 유사한 방어적 DDL 사용
──────────────────────────────────────────────────────────────── */

async function ensureUserStatsSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  // 기본 테이블 생성 (이미 존재하면 no-op)
  await sql/* sql */`
    create table if not exists user_stats (
      user_id       uuid primary key references users(id) on delete cascade,
      xp            bigint not null default 0,
      level         int generated always as (greatest(1, (xp/1000)::int + 1)) stored,
      coins         bigint not null default 0,
      exp           bigint not null default 0,
      tickets       bigint not null default 0,
      games_played  bigint not null default 0,
      last_login_at timestamptz,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now()
    )
  `;

  // 누락 컬럼 보강
  await sql/* sql */`
    alter table user_stats
      add column if not exists coins         bigint not null default 0,
      add column if not exists exp           bigint not null default 0,
      add column if not exists tickets       bigint not null default 0,
      add column if not exists games_played  bigint not null default 0,
      add column if not exists created_at    timestamptz not null default now(),
      add column if not exists updated_at    timestamptz not null default now()
  `;

  // 음수 방지 제약조건
  await sql/* sql */`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_coins_nonneg'
      ) then
        alter table user_stats
          add constraint user_stats_coins_nonneg check (coins >= 0);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_exp_nonneg'
      ) then
        alter table user_stats
          add constraint user_stats_exp_nonneg check (exp >= 0);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_tickets_nonneg'
      ) then
        alter table user_stats
          add constraint user_stats_tickets_nonneg check (tickets >= 0);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conrelid = 'user_stats'::regclass
          and conname = 'user_stats_games_played_nonneg'
      ) then
        alter table user_stats
          add constraint user_stats_games_played_nonneg check (games_played >= 0);
      end if;
    end
    $$;
  `;

  // updated_at 트리거 (set_updated_at() 존재 시에만)
  await sql/* sql */`
    do $$
    begin
      if exists (
        select 1 from pg_proc where proname = 'set_updated_at'
      ) then
        if not exists (
          select 1 from pg_trigger where tgname = 'user_stats_set_updated_at'
        ) then
          create trigger user_stats_set_updated_at
          before update on user_stats
          for each row execute function set_updated_at();
        end if;
      end if;
    end
    $$;
  `;
}

async function ensureUserWalletSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  await sql/* sql */`
    create table if not exists user_wallet (
      user_id    uuid primary key references users(id) on delete cascade,
      points     bigint not null default 0,
      tickets    bigint not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql/* sql */`
    alter table user_wallet
      add column if not exists points     bigint not null default 0,
      add column if not exists tickets    bigint not null default 0,
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now()
  `;

  await sql/* sql */`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'user_wallet'::regclass
          and conname = 'user_wallet_points_nonneg'
      ) then
        alter table user_wallet
          add constraint user_wallet_points_nonneg check (points >= 0);
      end if;

      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'user_wallet'::regclass
          and conname = 'user_wallet_tickets_nonneg'
      ) then
        alter table user_wallet
          add constraint user_wallet_tickets_nonneg check (tickets >= 0);
      end if;
    end
    $$;
  `;

  await sql/* sql */`
    do $$
    begin
      if exists (
        select 1 from pg_proc where proname = 'set_updated_at'
      ) then
        if not exists (
          select 1 from pg_trigger where tgname = 'user_wallet_set_updated_at'
        ) then
          create trigger user_wallet_set_updated_at
          before update on user_wallet
          for each row execute function set_updated_at();
        end if;
      end if;
    end
    $$;
  `;
}

async function ensureAnalyticsEventsSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  await sql/* sql */`
    create table if not exists analytics_events (
      id         bigserial primary key,
      user_id    uuid references users(id) on delete cascade,
      event_name text not null,
      game_id    text,
      score      bigint,
      metadata   jsonb,
      created_at timestamptz not null default now()
    )
  `;
}

/* ───────────────────────────────────────────────────────────────
   보상 계산 로직
   - 점수(score)를 기반으로 경험치/포인트/티켓 산출
   - 필요 시 여기의 상수/공식만 조정하면 전체 보상 밸런스 변경 가능
──────────────────────────────────────────────────────────────── */

type GameReward = {
  gainedExp: number;
  gainedPoints: number;
  gainedTickets: number;
};

function computeRewards(input: {
  gameId: string;
  score: number;
  durationSec?: number | null;
  mode?: string | null;
  result?: string | null;
}): GameReward {
  const { score, mode, result } = input;

  // 기본 계수 (게임 전체 공통)
  const baseExpFactor = 0.3;
  const basePointFactor = 0.1;

  // 모드/결과에 따른 보정값
  let modeMultiplier = 1;
  if (mode === "hard") modeMultiplier = 1.5;
  if (mode === "easy") modeMultiplier = 0.8;

  let resultBonus = 1;
  if (result === "win" || result === "clear") resultBonus = 1.2;
  if (result === "lose" || result === "fail") resultBonus = 0.9;

  const factor = modeMultiplier * resultBonus;

  const rawExp = score * baseExpFactor * factor;
  const rawPoints = score * basePointFactor * factor;

  // 최소 0 이상 정수로 보정
  const gainedExp = Math.max(0, Math.floor(rawExp));
  const gainedPoints = Math.max(0, Math.floor(rawPoints));

  // 티켓은 특정 기준 이상 점수에서만 1장 지급 (예시)
  const gainedTickets = score >= 1000 ? 1 : 0;

  return { gainedExp, gainedPoints, gainedTickets };
}

/* ───────────────────────────────────────────────────────────────
   메인 핸들러
──────────────────────────────────────────────────────────────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
  data,
}) => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return preflight(env.CORS_ORIGIN);
  }

  // 메서드 제한
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "method_not_allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 레이트 리밋
  if (!(await Rate.allow(request))) {
    return withCORS(
      json(
        { error: "too_many_requests" },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const started = performance.now();
  const { ip, ua } = getClientMeta(request);

  try {
    // _middleware.ts 에서 넣어주는 인증 정보
    const auth = (data?.auth || data?.user || {}) as
      | { userId?: string; id?: string }
      | undefined;

    const userId =
      toStringOrNull((auth as any)?.userId) ||
      toStringOrNull((auth as any)?.id);

    if (!userId) {
      return withCORS(
        json({ error: "unauthorized" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    // 요청 바디 파싱
    const rawBody = await readJSON(request);
    const payload = parseGameFinishBody(rawBody);
    const { gameId, score, durationSec, mode, result } = payload;

    const sql = getSql(env);

    // 스키마 방어적 보강
    await ensureUserStatsSchema(sql);
    await ensureUserWalletSchema(sql);
    await ensureAnalyticsEventsSchema(sql);

    // 로그인/회원가입과 동일하게, user_stats row 없을 수 있으므로 upsert
    await sql/* sql */`
      insert into user_stats (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;

    await sql/* sql */`
      insert into user_wallet (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;

    // 보상 계산
    const { gainedExp, gainedPoints, gainedTickets } = computeRewards({
      gameId,
      score,
      durationSec,
      mode,
      result,
    });

    // user_stats 업데이트 (xp/exp/coins/tickets/games_played)
    await sql/* sql */`
      update user_stats
      set
        xp           = xp + ${gainedExp},
        exp          = exp + ${gainedExp},
        coins        = coins + ${gainedPoints},
        tickets      = tickets + ${gainedTickets},
        games_played = games_played + 1,
        updated_at   = now()
      where user_id = ${userId}::uuid
    `;

    // user_wallet 업데이트 (points/tickets)
    await sql/* sql */`
      update user_wallet
      set
        points     = points + ${gainedPoints},
        tickets    = tickets + ${gainedTickets},
        updated_at = now()
      where user_id = ${userId}::uuid
    `;

    // analytics_events 기록
    const metadata = {
      ip,
      ua,
      score,
      durationSec,
      mode,
      result,
      gainedExp,
      gainedPoints,
      gainedTickets,
    };

    await sql/* sql */`
      insert into analytics_events (user_id, event_name, game_id, score, metadata)
      values (
        ${userId}::uuid,
        'game_finish',
        ${gameId},
        ${score},
        ${JSON.stringify(metadata)}::jsonb
      )
    `;

    // 업데이트 후 스냅샷 (프론트가 바로 반영가능하도록)
    const [statsRow] = await sql/* sql */`
      select
        xp,
        level,
        coins,
        exp,
        tickets,
        games_played
      from user_stats
      where user_id = ${userId}::uuid
    `;

    const [walletRow] = await sql/* sql */`
      select
        points,
        tickets
      from user_wallet
      where user_id = ${userId}::uuid
    `;

    const tookMs = Math.round(performance.now() - started);

    return withCORS(
      json(
        {
          ok: true,
          gainedExp,
          gainedPoints,
          gainedTickets,
          snapshot: {
            stats: statsRow || null,
            wallet: walletRow || null,
          },
          meta: {
            tookMs,
          },
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Game-Finish-Took-ms": String(tookMs),
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (err: any) {
    // 파싱/검증/DB 예외 모두 여기서 캐치
    return withCORS(
      json(
        { error: String(err?.message || err) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
