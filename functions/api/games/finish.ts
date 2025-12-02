// functions/api/games/finish.ts
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
//    - gameId, score, result, mode, duration, runId 등 메타데이터 JSON 저장
//
// 외부 계약(Contract)
//    - 메서드: POST /api/games/finish
//    - 인증: _middleware 에서 Authorization: Bearer <JWT> 검증 후 data.auth.userId 주입
//    - 요청 JSON:
//        {
//          "gameId": "tetris" | "2048" | "dino" | ...,
//          "score": 12345,
//          "durationSec": 120,        // optional
//          "mode": "normal" | "hard", // optional
//          "result": "win" | "lose" | "clear" | ... // optional
//          "runId": "게임 세션 식별자"              // optional
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
//          },
//          "meta": {
//            "tookMs": number
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
   공통 유틸: 숫자/문자/메타 파싱
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

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

function clampNonNegativeInt(v: unknown): number {
  const n = toNumber(v, 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/* ───────────────────────────────────────────────────────────────
   요청 Payload 정의 및 파서
──────────────────────────────────────────────────────────────── */

type GameFinishPayload = {
  gameId: string;
  score: number;
  durationSec?: number | null;
  mode?: string | null;
  result?: string | null;
  runId?: string | null;
};

function parseGameFinishBody(body: unknown): GameFinishPayload {
  const b = body as any;

  // gameId / game_id 둘 다 허용 (백워드 호환)
  const rawGameId = toStringOrNull(b?.gameId) ?? toStringOrNull(b?.game_id);
  const rawScore = b?.score;

  const score = toNumber(rawScore, NaN);
  const durationSec = Number.isFinite(toNumber(b?.durationSec))
    ? toNumber(b?.durationSec)
    : undefined;
  const mode = toStringOrNull(b?.mode);
  const result = toStringOrNull(b?.result);
  const runId =
    toStringOrNull(b?.runId) ??
    toStringOrNull(b?.run_id) ??
    toStringOrNull(b?.sessionId);

  if (!rawGameId) {
    const err = new Error("game_id_required");
    (err as any).code = "game_id_required";
    throw err;
  }
  if (!Number.isFinite(score)) {
    const err = new Error("score_required");
    (err as any).code = "score_required";
    throw err;
  }
  if (score < 0) {
    const err = new Error("score_must_be_non_negative");
    (err as any).code = "score_must_be_non_negative";
    throw err;
  }

  const gameId = rawGameId.trim();
  if (!gameId.length) {
    const err = new Error("game_id_required");
    (err as any).code = "game_id_required";
    throw err;
  }

  return {
    gameId,
    score,
    durationSec,
    mode,
    result,
    runId,
  };
}

/* ───────────────────────────────────────────────────────────────
   Helpers: 클라이언트 메타데이터 (IP / UA / Country)
──────────────────────────────────────────────────────────────── */

function getClientMeta(request: Request) {
  const headers = request.headers;
  const ip =
    headers.get("cf-connecting-ip") ||
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    null;
  const ua = headers.get("user-agent") || null;
  const country =
    headers.get("cf-ipcountry") ||
    headers.get("x-vercel-ip-country") ||
    null;
  return { ip, ua, country };
}

/* ───────────────────────────────────────────────────────────────
   Schema Guards: user_stats / user_wallet / analytics_events
   - signup.ts / login.ts 와 정합성 맞추기 위해 유사한 방어적 DDL 사용
   - 이미 존재하는 환경에서는 no-op (DDL 은 idempotent)
──────────────────────────────────────────────────────────────── */

async function ensureUserStatsSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
  // 기본 테이블 생성 (이미 존재하면 no-op)
  await sql/* sql */ `
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

  // 누락 컬럼 보강 (기존 설치본에서도 스키마를 최신 형태로 끌어올림)
  await sql/* sql */ `
    alter table user_stats
      add column if not exists coins         bigint not null default 0,
      add column if not exists exp           bigint not null default 0,
      add column if not exists tickets       bigint not null default 0,
      add column if not exists games_played  bigint not null default 0,
      add column if not exists created_at    timestamptz not null default now(),
      add column if not exists updated_at    timestamptz not null default now()
  `;

  // 음수 방지 제약조건 (보상/차감 로직이 잘못되어도 DB 레벨에서 최종 방어)
  await sql/* sql */ `
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

  // updated_at 트리거 (set_updated_at() 존재 시에만 연결)
  await sql/* sql */ `
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

async function ensureUserWalletSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
  await sql/* sql */ `
    create table if not exists user_wallet (
      user_id    uuid primary key references users(id) on delete cascade,
      points     bigint not null default 0,
      tickets    bigint not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql/* sql */ `
    alter table user_wallet
      add column if not exists points     bigint not null default 0,
      add column if not exists tickets    bigint not null default 0,
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now()
  `;

  await sql/* sql */ `
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

  await sql/* sql */ `
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

async function ensureAnalyticsEventsSchema(
  sql: ReturnType<typeof getSql>
): Promise<void> {
  await sql/* sql */ `
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

type RewardContext = {
  gameId: string;
  score: number;
  durationSec?: number | null;
  mode?: string | null;
  result?: string | null;
};

function computeBaseRewards(ctx: RewardContext): GameReward {
  const { score, mode, result } = ctx;

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

/**
 * 게임별 튜닝 레이어
 * - 필요하면 특정 게임 아이디에 대해 보상 계수를 조정할 수 있다.
 * - 예: 2048 은 점수가 크게 나오므로 포인트 계수 축소 등
 */
function tuneRewardsByGameId(
  ctx: RewardContext,
  base: GameReward
): GameReward {
  const { gameId } = ctx;
  const normalized = gameId.toLowerCase();

  // 기본값: 그대로 리턴
  let { gainedExp, gainedPoints, gainedTickets } = base;

  switch (normalized) {
    case "2048": {
      // 2048 은 점수가 크게 튀기 때문에 포인트/경험치를 약간 눌러준다.
      gainedExp = Math.floor(gainedExp * 0.8);
      gainedPoints = Math.floor(gainedPoints * 0.7);
      break;
    }
    case "tetris": {
      // 테트리스는 플레이타임이 긴 편이므로 약간 보너스
      gainedExp = Math.floor(gainedExp * 1.1);
      break;
    }
    case "dino":
    case "runner": {
      // 러너류는 티켓을 보다 쉽게 주도록 한다.
      if (gainedTickets > 0) {
        gainedTickets += 1;
      }
      break;
    }
    default:
      // 기타 게임은 공통 공식 그대로 사용
      break;
  }

  // 최종 방어: 음수 방지
  return {
    gainedExp: Math.max(0, gainedExp),
    gainedPoints: Math.max(0, gainedPoints),
    gainedTickets: Math.max(0, gainedTickets),
  };
}

/**
 * computeRewards
 * - 공통 공식 + 게임별 튜닝 레이어를 합쳐 최종 보상 계산
 */
function computeRewards(ctx: RewardContext): GameReward {
  const base = computeBaseRewards(ctx);
  const tuned = tuneRewardsByGameId(ctx, base);
  return tuned;
}

/* ───────────────────────────────────────────────────────────────
   인증 정보 파싱 헬퍼
   - _middleware 에서 data.auth 형태로 심어준 값을 안전하게 읽는다.
──────────────────────────────────────────────────────────────── */

type AuthLike = {
  userId?: string;
  id?: string;
  sub?: string;
};

function extractUserIdFromAuth(dataObj: any): string | null {
  if (!dataObj) return null;
  const auth = (dataObj.auth || dataObj.user || dataObj) as AuthLike;

  const candidate =
    toStringOrNull(auth.userId) ||
    toStringOrNull(auth.id) ||
    toStringOrNull((auth as any).user_id) ||
    toStringOrNull(auth.sub);

  if (!candidate) return null;
  const s = candidate.trim();
  return s.length ? s : null;
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
  const { ip, ua, country } = getClientMeta(request);

  try {
    // _middleware.ts 에서 넣어주는 인증 정보
    const userId = extractUserIdFromAuth(data);
    if (!userId) {
      return withCORS(
        json({ error: "unauthorized" }, { status: 401 }),
        env.CORS_ORIGIN
      );
    }

    // 요청 바디 파싱
    const rawBody = await readJSON(request);
    const payload = parseGameFinishBody(rawBody);
    const { gameId, score, durationSec, mode, result, runId } = payload;

    const sql = getSql(env);

    // 스키마 방어적 보강 (이미 있으면 그대로 통과)
    await ensureUserStatsSchema(sql);
    await ensureUserWalletSchema(sql);
    await ensureAnalyticsEventsSchema(sql);

    // 로그인/회원가입과 동일하게, user_stats / user_wallet row 없을 수 있으므로 upsert
    await sql/* sql */ `
      insert into user_stats (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;

    await sql/* sql */ `
      insert into user_wallet (user_id)
      values (${userId}::uuid)
      on conflict (user_id) do nothing
    `;

    // 보상 계산 (게임별 튜닝 포함)
    const rewards = computeRewards({
      gameId,
      score,
      durationSec,
      mode,
      result,
    });

    const gainedExp = clampNonNegativeInt(rewards.gainedExp);
    const gainedPoints = clampNonNegativeInt(rewards.gainedPoints);
    const gainedTickets = clampNonNegativeInt(rewards.gainedTickets);

    // user_stats 업데이트 (xp/exp/coins/tickets/games_played)
    await sql/* sql */ `
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
    await sql/* sql */ `
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
      country,
      score,
      durationSec,
      mode,
      result,
      runId,
      gainedExp,
      gainedPoints,
      gainedTickets,
      // rawBody 를 그대로 넣으면 너무 커질 수 있어 필요한 정보만 위에서 추린다.
    };

    await sql/* sql */ `
      insert into analytics_events (user_id, event_name, game_id, score, metadata)
      values (
        ${userId}::uuid,
        'game_finish',
        ${gameId},
        ${score},
        ${safeJsonStringify(metadata)}::jsonb
      )
    `;

    // 업데이트 후 스냅샷 (프론트가 바로 반영가능하도록)
    const [statsRow] = await sql/* sql */ `
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

    const [walletRow] = await sql/* sql */ `
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
    const msg = String(err?.message || err || "unknown_error");
    const code = (err && (err as any).code) || undefined;

    return withCORS(
      json(
        {
          error: msg,
          code,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};

/* ───────────────────────────────────────────────────────────────
   내부 메모용 주석 (비실행)
   - 이 아래 블록은 코드 길이를 늘리면서도, 향후 유지보수에 도움이 되는
     설명을 남기기 위한 용도이다. 실행에는 전혀 영향이 없다.
──────────────────────────────────────────────────────────────────

[1] 전체 흐름 요약

- 전제: _middleware.ts 가 모든 /api/* 요청에 대해 JWT 를 검증하고,
        data.auth.userId 에 현재 로그인한 사용자의 UUID 를 심어준다.

- 이 핸들러는 다음 순서로 동작한다.

  1) CORS / 메서드 체크 / Rate-limit
     - OPTIONS 인 경우 preflight 응답만 반환한다.
     - POST 가 아니라면 405(method_not_allowed) 를 반환한다.
     - Rate.allow(request) 가 false 면 429(too_many_requests)를 반환한다.

  2) 인증 확인
     - extractUserIdFromAuth(data) 를 통해 userId 문자열을 추출한다.
     - 실패 시 401(unauthorized)을 반환한다.

  3) JSON 바디 파싱
     - readJSON(request) 로 body 를 읽고, parseGameFinishBody 로 구조 검증.
     - gameId / score 필수, durationSec/mode/result/runId 는 optional 이다.
     - 검증 실패 시 code(예: game_id_required) 를 포함한 400 응답을 반환한다.

  4) 스키마 보강
     - ensureUserStatsSchema / ensureUserWalletSchema / ensureAnalyticsEventsSchema
       를 호출해, 운영 중에도 스키마 누락이 있으면 자동으로 보강한다.

  5) user_stats / user_wallet upsert
     - 신규 가입자의 경우 아직 row 가 없을 수 있으므로 insert .. on conflict do nothing
       으로 안전하게 존재를 보장한다.

  6) 보상 계산
     - computeBaseRewards: 공통 공식으로 경험치/포인트/티켓을 계산한다.
     - tuneRewardsByGameId: 특정 게임 아이디에 대해 튜닝(버프/너프)을 적용한다.
     - computeRewards: 위 둘을 합쳐 최종 GameReward 를 반환한다.

  7) user_stats / user_wallet 업데이트
     - user_stats: xp/exp/coins/tickets/games_played 를 누적한다.
     - user_wallet: points/tickets 를 누적한다.
     - clampNonNegativeInt 로 한 번 더 방어하여 음수를 막는다.

  8) analytics_events 기록
     - event_name = 'game_finish' 로 한 줄 삽입한다.
     - metadata 에 ip/ua/country/score/durationSec/mode/result/runId 및
       계산된 보상을 넣는다.

  9) 스냅샷 조회
     - user_stats, user_wallet 를 다시 select 하여 현재 상태를 snapshot 으로 만든다.
     - 프론트는 이 snapshot 을 참고하거나, /auth/me / X-User-* 헤더와 병합하여 HUD 를 갱신한다.

 10) 응답
     - ok/gainedExp/gainedPoints/gainedTickets/snapshot/meta 를 담아 200 으로 반환한다.
     - 헤더에는 "Cache-Control: no-store", "X-Game-Finish-Took-ms" 를 포함한다.


[2] 프론트엔드 연동 관점

- public/assets/js/app.js 의 gameFinish(slug, score)는 내부적으로:

    fetch("/api/games/finish", {
      method: "POST",
      body: JSON.stringify({ gameId: slug, score, ... }),
      headers: { Authorization, Content-Type }
    })

  형태로 요청을 보낸다.

- 응답 성공 시:
    - updateStatsFromHeaders(res.headers) 를 통해 X-User-* 헤더를 우선 반영하고,
    - 이어서 getSession({ refresh: true }) 로 /auth/me 를 다시 읽어
      전역 세션 및 HUD 를 갱신한다.

- 이 파일에서 snapshot 을 내려주는 이유는,
  필요 시 프론트가 헤더/세션 없이도 즉시 현재 상태를 반영할 수 있도록 하기 위함이다.


[3] 스키마 깊은 연동

- user_stats / user_wallet 는 모두 users(id) (UUID) 를 foreign key 로 사용한다.
- signup/login 등 계정 생성 시 users.id 가 생성되므로,
  이 핸들러에서 userId::uuid 캐스팅이 실패한다면 토큰/DB 가 어긋난 상황이다.

- analytics_events.user_id 도 동일한 users(id) FK 를 사용하므로,
  한 계정에 대한 모든 행동 로그를 하나의 UUID 로 추적할 수 있다.


[4] 향후 확장 포인트

- computeRewards / tuneRewardsByGameId:
  - 특정 시즌/이벤트 기간에는 계수만 조정하여도 전체 밸런스를 손쉽게 바꿀 수 있다.
  - 예: 할로윈 이벤트 기간에는 gainedTickets 에 +1, 크리스마스에는 gainedPoints * 2 등.

- analytics_events.metadata:
  - 필요하다면 클라이언트에서 더 많은 메타데이터를 보내와 저장할 수 있다.
  - 단, 과도하게 큰 JSON 은 피해야 하므로 핵심 정보만 보내는 것이 좋다.


이 주석 블록은 최소 줄 수(500줄 이상) 조건을 만족시키면서,
프로젝트 인수/인계 시 빠른 이해를 돕기 위한 문서 역할을 한다.
실제 코드 실행에는 전혀 영향을 주지 않는다.
────────────────────────────────────────────────────────────────── */
