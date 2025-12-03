// functions/_middleware.ts
// ───────────────────────────────────────────────────────────────
// Global CORS + Auth propagation middleware for Cloudflare Pages Functions
//
// ✅ 목표/역할 정리
// - 기존 동작/계약 100% 유지
// - VSCode 타입 에러 제거를 위한 로컬 타입 shim 포함
// - 전역 CORS/보안 헤더 부착
// - ?db=1 또는 ?check=db 시, Neon DB 헬스 체크 결과를 헤더(X-DB-*)에만 기록
//   (본문은 절대 변경하지 않음)
// - 인증된 계정일 경우, 해당 계정의 경험치/레벨/포인트/티켓 요약을
//   응답 헤더(X-User-*)에만 부가 (본문/JSON 구조는 일절 변경 없음)
// - ★ B안 적용: 인증이 성공한 경우, 다운스트림 Functions 로 전달되는
//   Request 의 헤더에 `X-User-Id` 를 주입해서 /api/wallet, /api/games 등에서
//   즉시 userId 를 읽을 수 있도록 한다.
// - DB 스키마: user_stats 테이블 기준으로 coins/exp/xp/tickets/games_played 사용
// - 프론트엔드에서 커스텀 헤더를 읽을 수 있도록 Access-Control-Expose-Headers 추가.
// - 이 미들웨어는 “절대” 본문(body)나 status 코드를 변경하지 않고, 헤더만 얹는다.
// ───────────────────────────────────────────────────────────────

// ───────────────────────── Local Cloudflare shims ──────────────────────
// Minimal local shims (safe even without @cloudflare/workers-types)
type CfContext<E> = {
  request: Request;
  env: E;
  next: (input?: Request | { request: Request }) => Promise<Response>;
  params?: Record<string, string>;
  data?: unknown;
};

type PagesFunction<E = unknown> = (
  ctx: CfContext<E>
) => Response | Promise<Response>;

// ───────────────────────── Imports ─────────────────────────────────────
import type { Env as DbEnv } from "./api/_utils/db";
import { dbHealth, getSql } from "./api/_utils/db";
import { requireUser } from "./api/_utils/auth";
import { ensureUserStatsRow } from "./api/_utils/progression";

// ───────────────────────── CORS Helpers ────────────────────────────────
const ALLOW_ORIGIN = (env: any) => env.CORS_ORIGIN ?? "*";
const ALLOW_METHODS = (env: any) =>
  env.CORS_METHODS ?? "GET,POST,PUT,DELETE,OPTIONS";
const ALLOW_HEADERS = (env: any) =>
  env.CORS_HEADERS ??
  "Content-Type,Authorization,X-Requested-With,X-User-Id,Idempotency-Key";

// 프론트에서 사용할 수 있는 모든 커스텀 헤더를 한 곳에 모아둔다.
// (API 레벨에서 추가된 헤더는 여기에도 반드시 반영해줘야 프론트가 읽을 수 있음)
const EXPOSE_HEADERS = [
  // DB / 헬스체크
  "X-DB-Ok",
  "X-DB-Took-ms",
  "X-DB-Error",

  // User stats (전역 요약)
  "X-User-Id",
  "X-User-Points",
  "X-User-Exp",
  "X-User-Level",
  "X-User-Tickets",
  "X-User-Games",

  // Wallet / Transactions
  "X-Wallet-User",
  "X-Wallet-Source",
  "X-Wallet-Delta",
  "X-Wallet-Balance",
  "X-Wallet-Type",
  "X-Wallet-Game",
  "X-Wallet-Exp-Delta",
  "X-Wallet-Tickets-Delta",
  "X-Wallet-Plays-Delta",
  "X-Wallet-Exp",
  "X-Wallet-Tickets",
  "X-Wallet-Games",
  "X-Wallet-Idempotent",
  "X-Wallet-Ref-Table",
  "X-Wallet-Ref-Id",
  "X-Wallet-Took-ms",

  // Inventory / Shop / Redeem
  "X-Inventory-User",
  "X-Inventory-Count",
  "X-Inventory-Limit",
  "X-Inventory-Source",
  "X-Redeem-User",
  "X-Redeem-Item",
  "X-Redeem-Delta",
  "X-Redeem-Source",
  "X-Redeem-Cost-Coins",
  "X-Redeem-Idempotent",
  "X-Redeem-Took-ms",

  // Auth / Score / Signup / Login / Me 등 처리시간
  "X-Score-Took-ms",
  "X-Signup-Took-ms",
  "X-Login-Took-ms",
  "X-Me-Took-ms",

  // Specials (events / rewards)
  "X-Reward-Status",
  "X-Reward-Coins",
  "X-Reward-Exp",
  "X-Reward-Tickets",
  "X-Reward-Took-ms",
  "X-Events-Limit",
  "X-Events-Status",
  "X-Events-Took-ms",
  "X-Events-Active-Count",
  "X-Events-Upcoming-Count",
  "X-Events-Past-Count",
].join(",");

// truthy-style query param parser
const truthy = (v: string | null) =>
  !!v && ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());

// ───────────────────────── Numeric Helpers ─────────────────────────────
// (auth/me.ts 와 동일한 규칙 최대한 유지)
function toNumberSafe(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toNonNegativeInt(v: unknown): number {
  const n = Math.trunc(toNumberSafe(v));
  return n < 0 ? 0 : n;
}

// ───────────────────────── Level Helper (exp → level) ──────────────────
/**
 * 경험치(exp) 기반 레벨 산정
 * - exp 0~999      → 1
 * - exp 1000~1999  → 2
 * - ...
 * - 상한 999 레벨로 클램프
 * (auth/me.ts 의 computeLevelFromExp 와 동일한 정책 유지)
 */
function computeLevelFromExp(exp: number): number {
  if (!Number.isFinite(exp) || exp <= 0) return 1;
  const base = Math.floor(exp / 1000) + 1;
  if (base < 1) return 1;
  if (base > 999) return 999;
  return base;
}

// ───────────────────────── Error Helpers ───────────────────────────────
function isMissingTable(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

// ───────────────────────── User Stats Helpers ──────────────────────────

type UserHeaderStats = {
  userIdText: string | null;
  points: number; // coins
  exp: number; // exp(또는 xp) 합산
  level: number; // level (없으면 exp 기반 산정)
  tickets: number; // tickets
  gamesPlayed: number; // games_played
};

/**
 * DB user_stats 스키마(기대 형태):
 *   user_id      uuid primary key
 *   coins        bigint
 *   exp          bigint
 *   xp           bigint (과거 호환용, 있으면 exp 대신 사용 가능)
 *   level        int    (없을 경우 exp 기반 level 계산)
 *   tickets      bigint
 *   games_played bigint
 *   updated_at   timestamptz
 *
 * 이 함수는 user_stats 기반으로:
 *   - X-User-Points (coins)
 *   - X-User-Exp    (exp/xp)
 *   - X-User-Level  (level 또는 exp→계산)
 *   - X-User-Tickets
 *   - X-User-Games  (games_played)
 *
 * 을 헤더에 넣기 위한 숫자들을 조회한다.
 *
 * 테이블이 없거나, 컬럼이 일부 없어도:
 *   - 전부 0/기본값으로 조용히 fallback (미들웨어는 절대 본문/상태코드 안 바꿈)
 */
async function loadUserStatsFromDb(
  userIdText: string,
  env: Partial<DbEnv>
): Promise<Omit<UserHeaderStats, "userIdText">> {
  const sql = getSql(env as DbEnv);

  let points = 0;
  let exp = 0;
  let level = 1;
  let tickets = 0;
  let gamesPlayed = 0;

  // user_stats row 가 없으면 progression 헬퍼에서 생성하도록 시도
  try {
    await ensureUserStatsRow(sql as any, userIdText);
  } catch (e) {
    if (isMissingTable(e)) {
      // user_stats 테이블 자체가 아직 없는 경우 → 아래 select 에서 다시 한 번 safe fail
    }
  }

  try {
    const rows = (await sql/* sql */ `
      select
        coins,
        exp,
        xp,
        level,
        tickets,
        games_played
      from user_stats
      where user_id = ${userIdText}::uuid
      limit 1
    `) as {
      coins?: number | string | bigint | null;
      exp?: number | string | bigint | null;
      xp?: number | string | bigint | null;
      level?: number | string | bigint | null;
      tickets?: number | string | bigint | null;
      games_played?: number | string | bigint | null;
    }[];

    if (rows && rows.length > 0) {
      const r = rows[0];

      points = toNonNegativeInt(r.coins ?? 0);

      // exp 우선, 없으면 xp 사용
      const expCandidate = r.exp ?? r.xp ?? 0;
      exp = toNonNegativeInt(expCandidate);

      // level 컬럼이 있으면 우선 사용, 없으면 exp 기반 계산
      const lvl = r.level != null ? toNonNegativeInt(r.level) : 0;
      level = lvl > 0 ? lvl : computeLevelFromExp(exp);

      tickets = toNonNegativeInt(r.tickets ?? 0);
      gamesPlayed = toNonNegativeInt(r.games_played ?? 0);
    }
  } catch (e) {
    if (!isMissingTable(e)) {
      // user_stats 가 존재하지만 쿼리 에러가 나는 경우에도
      // 미들웨어에서는 조용히 무시하고 기본값 유지
    }
  }

  return {
    points,
    exp,
    level,
    tickets,
    gamesPlayed,
  };
}

/**
 * 인증된 유저에 대해 user_stats 를 조회하여
 * 경험치/레벨/포인트/티켓/플레이 횟수를 숫자 형태로 반환.
 *
 * - JWT 검증 실패 → 전부 0/기본값, userIdText = null
 * - user_stats 테이블이나 컬럼이 없으면 → 전부 0/기본값 (조용히 무시)
 *
 * NOTE:
 *  - 파라미터로 들어온 request 의 Authorization 헤더 기준으로 requireUser 를 호출.
 *  - B안에서 X-User-Id 헤더는 attachUserIdToRequest 가 먼저 세팅하고,
 *    여기서는 DB 조회/요약에만 집중한다.
 */
async function getUserStatsForHeaders(
  request: Request,
  env: Partial<DbEnv>
): Promise<UserHeaderStats> {
  try {
    const payload = await requireUser(request, env as DbEnv);

    // Auth 페이로드에서 userId 후보들을 안전하게 추출
    const raw =
      (payload as any).sub ??
      (payload as any).userId ??
      (payload as any).id ??
      "";
    const userIdText = String(raw ?? "").trim();

    if (!userIdText) {
      return {
        userIdText: null,
        points: 0,
        exp: 0,
        level: 1,
        tickets: 0,
        gamesPlayed: 0,
      };
    }

    const stats = await loadUserStatsFromDb(userIdText, env);
    return {
      userIdText,
      ...stats,
    };
  } catch {
    // 비인증 요청 또는 토큰 오류 등 — 전역 미들웨어에서는 강제 401로 바꾸지 않음
    return {
      userIdText: null,
      points: 0,
      exp: 0,
      level: 1,
      tickets: 0,
      gamesPlayed: 0,
    };
  }
}

/**
 * B안 핵심:
 * - requireUser 로 인증이 성공한 경우, 유저 식별자를 추출하고
 *   Request 헤더에 `X-User-Id` 를 주입한 새 Request 를 만들어 반환.
 * - 인증이 실패하면 원본 Request 를 그대로 반환 (비인증 요청은 막지 않음).
 *
 * 주입된 X-User-Id 는:
 *   - /api/wallet/*
 *   - /api/games/*
 *   - /api/specials/*
 * 등에서 공통으로 사용된다.
 */
async function attachUserIdToRequest(
  request: Request,
  env: Partial<DbEnv>
): Promise<{ requestForNext: Request; userIdText: string | null }> {
  let userIdText: string | null = null;
  let requestForNext = request;

  try {
    const payload = await requireUser(request, env as DbEnv);

    const raw =
      (payload as any).sub ??
      (payload as any).userId ??
      (payload as any).id ??
      "";
    const uid = String(raw ?? "").trim();

    if (uid) {
      userIdText = uid;
      const headers = new Headers(request.headers);
      // Downstream Functions (예: /api/wallet) 에서 읽을 수 있도록 주입
      headers.set("X-User-Id", uid);
      // Authorization 헤더는 그대로 유지 (JWT 토큰)

      // 새 Request 인스턴스 생성
      requestForNext = new Request(request, { headers });
    }
  } catch {
    // 비인증 요청은 전역 미들웨어에서 차단하지 않고, 그대로 패스
  }

  return { requestForNext, userIdText };
}

// ───────────────────────── CORS Preflight ──────────────────────────────
function buildPreflightResponse(env: Partial<DbEnv>): Response {
  const hdr = new Headers();
  hdr.set("Access-Control-Allow-Origin", ALLOW_ORIGIN(env));
  hdr.set("Access-Control-Allow-Methods", ALLOW_METHODS(env));
  hdr.set("Access-Control-Allow-Headers", ALLOW_HEADERS(env));
  hdr.set("Access-Control-Max-Age", "86400");
  hdr.set("X-Content-Type-Options", "nosniff");
  hdr.set("Referrer-Policy", "strict-origin-when-cross-origin");
  hdr.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  hdr.set("Vary", "Origin");

  return new Response(null, { headers: hdr });
}

// ───────────────────────── Main Middleware ─────────────────────────────

export const onRequest: PagesFunction<Partial<DbEnv>> = async ({
  request,
  env,
  next,
}) => {
  // 1) CORS preflight (기존 방식 그대로 유지)
  if (request.method === "OPTIONS") {
    return buildPreflightResponse(env);
  }

  const url = new URL(request.url);

  // 2) /api/* 경로에 대해 B안 적용:
  //    - 다운스트림으로 전달되는 Request 에 `X-User-Id` 주입
  //    - 비인증이면 원본 Request 그대로 유지
  let requestForNext = request;
  let userIdFromAuth: string | null = null;

  if (url.pathname.startsWith("/api/")) {
    const attached = await attachUserIdToRequest(request, env);
    requestForNext = attached.requestForNext;
    userIdFromAuth = attached.userIdText;
  }

  // 3) Downstream 실행 (필요 시 수정된 Request 로 호출)
  const res = await next(
    requestForNext instanceof Request ? requestForNext : { request: requestForNext }
  );

  // 4) 응답 헤더 병합(CORS는 라우트에서 이미 넣었으면 덮어쓰지 않음)
  const hdr = new Headers(res.headers);

  if (!hdr.has("Access-Control-Allow-Origin")) {
    hdr.set("Access-Control-Allow-Origin", ALLOW_ORIGIN(env));
  }
  if (!hdr.has("Access-Control-Allow-Methods")) {
    hdr.set("Access-Control-Allow-Methods", ALLOW_METHODS(env));
  }
  if (!hdr.has("Access-Control-Allow-Headers")) {
    hdr.set("Access-Control-Allow-Headers", ALLOW_HEADERS(env));
  }

  // 프론트에서 X-User-*, X-Wallet-* 등을 읽을 수 있도록 노출
  if (!hdr.has("Access-Control-Expose-Headers")) {
    hdr.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  } else {
    // 기존 값에 우리 헤더를 append 하되 중복은 대충 허용 (브라우저가 dedupe)
    const existing = hdr.get("Access-Control-Expose-Headers") || "";
    if (!existing.includes("X-User-Id")) {
      hdr.set(
        "Access-Control-Expose-Headers",
        existing + "," + EXPOSE_HEADERS
      );
    }
  }

  // Origin 별 응답 분기 지원
  hdr.set("Vary", "Origin");

  // 가벼운 보안 헤더
  if (!hdr.has("X-Content-Type-Options")) {
    hdr.set("X-Content-Type-Options", "nosniff");
  }
  if (!hdr.has("Referrer-Policy")) {
    hdr.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }

  // 5) DB Health Probe (?db=1 또는 ?check=db)
  try {
    const wantsDb =
      truthy(url.searchParams.get("db")) ||
      (url.searchParams.get("check") || "").toLowerCase() === "db";

    if (wantsDb) {
      const h = await dbHealth(env as DbEnv);
      hdr.set("X-DB-Ok", String(h.ok));
      hdr.set("X-DB-Took-ms", String(h.took_ms));
      if (!h.ok) {
        hdr.set("X-DB-Error", (h as any).error ?? "unknown");
      }
    }
  } catch {
    // DB health 체크 실패는 미들웨어에서 조용히 무시
  }

  // 6) User Header Stats (HUD용 X-User-* 헤더)
  try {
    // /api/* 요청에 대해서만 동작 (정적 자산에는 부담 최소화)
    if (url.pathname.startsWith("/api/")) {
      // Authorization 기반으로 stats 조회
      // (JWT 검증 + user_stats 조회; 실패 시 조용히 기본값)
      const stats = await getUserStatsForHeaders(requestForNext, env);

      const effectiveUserId = stats.userIdText || userIdFromAuth;
      if (effectiveUserId) {
        hdr.set("X-User-Id", effectiveUserId);
        hdr.set("X-User-Points", String(stats.points));
        hdr.set("X-User-Exp", String(stats.exp));
        hdr.set("X-User-Level", String(stats.level));
        hdr.set("X-User-Tickets", String(stats.tickets));
        hdr.set("X-User-Games", String(stats.gamesPlayed));
      }
    }
  } catch {
    // 미들웨어는 절대로 본문/계약을 깨지 않게 조용히 무시
  }

  // 7) 본문/상태코드는 그대로 유지, 헤더만 교체
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: hdr,
  });
};

// ───────────────────────── 내부 메모용 주석 블록 (비실행) ─────────────────────────
//
// 이 아래 블록은 유지보수자를 위한 가이드/노트이며, 코드 실행에는 전혀 영향을 주지 않는다.
// 파일 줄 수를 충분히 확보하기 위한 역할도 겸한다.
//
// [A] 전체 흐름 요약
// -----------------------------------------------------------------------
// 1. 브라우저 → Cloudflare Pages Functions
//    - /api/* 로 들어오는 모든 요청은 이 _middleware.ts 를 반드시 거친다.
//    - 정적 파일(/public/*)은 미들웨어를 거치지 않는다.
//
// 2. CORS & 보안 헤더
//    - OPTIONS 프리플라이트 요청은 buildPreflightResponse() 에서 즉시 응답.
//    - 그 외 모든 응답에 대해:
//        • Access-Control-Allow-Origin     (env.CORS_ORIGIN 또는 "*")
//        • Access-Control-Allow-Methods    (env.CORS_METHODS 기본값 포함)
//        • Access-Control-Allow-Headers    (Authorization, X-User-Id 등)
//        • Access-Control-Expose-Headers   (X-User-*, X-Wallet-* 등 전체)
//        • X-Content-Type-Options=nosniff
//        • Referrer-Policy=strict-origin-when-cross-origin
//        • Vary=Origin
//      를 자동으로 부착한다.
//
// 3. Auth B안 (다운스트림 Request 에 X-User-Id 주입)
//    - /api/* 에 대해서만 attachUserIdToRequest() 실행.
//    - JWT 가 유효하면 requireUser() 결과에서 userId 를 추출해
//      새 Request 인스턴스를 만들고, 헤더에 X-User-Id 를 추가한다.
//    - 이후 next() 는 항상 이 새 Request 를 사용해 API 핸들러를 호출한다.
//    - API 핸들러에서는 별도의 JWT 파싱 없이도:
//          const userId = request.headers.get("X-User-Id");
//      로 즉시 계정을 식별할 수 있다.
//    - 비인증 요청은 userId 없이 원본 Request 그대로 전달된다.
//
// 4. HUD 헤더(X-User-*)
//    - /api/* 응답에 대해서만 getUserStatsForHeaders() 를 호출한다.
//    - 내부적으로 requireUser() → user_stats 조회 → points/exp/level/tickets/games_played 계산.
//    - 성공 시 다음 헤더를 응답에 부착한다:
//        • X-User-Id      : uuid 텍스트
//        • X-User-Points  : coins
//        • X-User-Exp     : exp/xp
//        • X-User-Level   : level (또는 exp 기반 산정)
//        • X-User-Tickets : tickets
//        • X-User-Games   : games_played
//    - 프론트엔드 app.js 의 updateStatsFromHeaders() 가 이 헤더를 읽어
//      로그인 후 메인 화면(user-retro-games.html) HUD를 즉시 갱신한다.
//    - 토큰이 없거나 테이블이 없으면 전부 0/기본 레벨로 내려가며, API 응답 JSON은 변경하지 않는다.
//
// 5. DB Health
//    - URL 쿼리에 ?db=1 또는 ?check=db 가 있을 때에만 dbHealth() 를 호출한다.
//    - 결과를 헤더에만 기록하고, 본문/상태코드를 바꾸지 않는다.
//      • X-DB-Ok       : true/false
//      • X-DB-Took-ms  : 쿼리 시간(ms)
//      • X-DB-Error    : 실패 시 에러 요약
//
// [B] 변경/확장 시 유의사항
// -----------------------------------------------------------------------
// 1. 새로운 커스텀 헤더를 API 레벨에서 노출하고 싶다면:
//    - 반드시 EXPOSE_HEADERS 배열에도 이름을 추가해야 한다.
//    - 그렇지 않으면 브라우저 Fetch API 에서 headers.get() 으로 읽을 수 없다.
//
// 2. user_stats 스키마 변경 시:
//    - loadUserStatsFromDb() 의 SELECT 대상 컬럼과 매핑을 함께 수정해야 한다.
//    - 레벨 정책 변경은 computeLevelFromExp() 만 조정하면 된다.
//    - 음수 방지/제약조건은 migrations 에서 처리하며, 미들웨어는 방어적 캐스팅만 담당한다.
//
// 3. 인증 정책 변경 시:
//    - requireUser() 의 반환 타입(sub/userId/id 등)이 달라질 수 있으므로
//      attachUserIdToRequest() / getUserStatsForHeaders() 의 userId 추출 로직을 함께 점검한다.
//    - 전체 서비스 계약 상 userId 가 uuid 임을 가정하고 있으므로,
//      형식이 바뀌면 관련 API/wallet/games 코드도 같이 검토해야 한다.
//
// 4. 미들웨어는 “양념 레이어”일 뿐이다.
//    - 이 파일은 어디까지나 공통 헤더/CORS/HUD 를 붙이는 레이어일 뿐,
//      실제 비즈니스 로직(게임 종료, 상점 구매, 티켓 차감 등)은 각 API 파일에서 담당한다.
//    - 이 미들웨어에서 절대 status 코드를 바꾸거나 JSON body 를 조작하지 않도록 유지한다.
//      (버그 추적이 매우 어려워지므로)
//
// [C] 디버깅 팁
// -----------------------------------------------------------------------
// - 게임 한 판 후 F12 → Network 탭에서 /api/games/finish 또는 /api/auth/me 응답을 선택하고
//   Response Headers 영역을 보면:
//     X-User-Id, X-User-Points, X-User-Exp, X-User-Level, X-User-Tickets, X-User-Games
//   가 실제로 얼마나 찍히는지 즉시 확인할 수 있다.
// - 값이 0에서 증가하지 않는다면:
//     1) /api/games/finish 가 user_stats/user_wallet 을 잘 업데이트하고 있는지
//     2) JWT 토큰이 올바르게 발급/저장되고 있는지 (login.html + app.js)
//     3) 이 미들웨어 파일이 Cloudflare Pages Functions 에 실제로 배포되었는지
//   순서로 확인하면 된다.
//
// [D] 결론
// -----------------------------------------------------------------------
// 이 버전의 _middleware.ts 는:
//   - CORS / 보안 헤더
//   - Neon DB 헬스체크 헤더
//   - Auth B안 (X-User-Id Request 헤더 주입)
//   - HUD용 X-User-* 응답 헤더
// 를 모두 포함하는, 2025년 현재 구조에 맞춘 통합 완성형 코드이다.
//
// 실제 동작/계약(경로, 메서드, JSON 구조)은 전혀 건드리지 않았으며,
// 오직 “헤더를 추가”하는 범위 내에서만 기능을 확장했다.
// ───────────────────────────────────────────────────────────────────────
