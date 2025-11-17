// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\wallet.ts

/**
 * Hardened validator for wallet transactions.
 * - 기존 validateTransaction 계약 유지: { userId: string, amount: number, reason: string }
 * - userId: NFKC 정규화, 길이/허용문자 검증
 * - amount: 유한수/정수 강제, 합리적 범위(데빗/크레딧 모두 허용)
 * - reason: 기본값 "adjust" 유지, 제어문자 제거·허용문자/길이 제한
 * - 의존성 0 (Edge/Workers 호환)
 *
 * 추가:
 * - 계정별 지갑 스키마용 validateWalletDelta:
 *   /api/wallet POST body + 컨텍스트 userId 를 바탕으로
 *   포인트/티켓/경험치/플레이 횟수 변경치를 단일 구조로 정규화.
 */

// ───────── 정책값 (서비스 정책에 맞게 조정 가능) ─────────
const USERID_MIN_LEN = 3;
const USERID_MAX_LEN = 64;
const USERID_REGEX   = /^[a-zA-Z0-9_\-.:@]+$/; // 서비스 전역과 일치

// 금액: 코인/포인트 정수 사용 가정(빅인트 DB와 일관)
const AMOUNT_MIN = -1_000_000_000_000; // -1e12
const AMOUNT_MAX =  1_000_000_000_000; //  1e12

const REASON_MAX_LEN = 120;
// 알파넘/공백/일부 기호만 허용(로그 가독성 + 인젝션 리스크 완화)
const REASON_REGEX = /^[\p{L}\p{N}\s._\-:/@()+#]+$/u;

// 게임 ID / 메타용 정책
const GAMEID_MAX_LEN = 64;
const GAMEID_REGEX   = /^[a-zA-Z0-9_\-.:@]+$/;

// 지갑 델타 범위 (경험치/포인트/티켓 공통)
const DELTA_MIN = -1_000_000_000;
const DELTA_MAX =  1_000_000_000;

// 플레이 카운트 인크리먼트 범위
const PLAYS_MIN = 0;
const PLAYS_MAX = 1_000;

function stripControlExceptWhitespace(s: string): string {
  // 탭/개행/CR 허용, 그 외 제어문자 제거
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
function cleanString(v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v.trim();
  s = stripControlExceptWhitespace(s);
  try { s = s.normalize("NFKC"); } catch {}
  s = s.replace(/\s+/g, " "); // 연속 공백 축약
  return s.trim();
}
function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = cleanString(raw);
  return s || null;
}
function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = cleanString(raw);
  if (!s) return null;
  if (s.length > REASON_MAX_LEN) return s.slice(0, REASON_MAX_LEN) + "…";
  if (!REASON_REGEX.test(s)) return null;
  return s;
}
function normalizeGameId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = cleanString(raw);
  if (!s) return null;
  if (s.length > GAMEID_MAX_LEN) return s.slice(0, GAMEID_MAX_LEN);
  if (!GAMEID_REGEX.test(s)) return null;
  return s;
}
function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function toIntInRange(v: unknown, min: number, max: number): number {
  if (!isFiniteNumber(v)) return 0;
  const n = Math.trunc(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ───────── 기존 Public API (계약 유지) ─────────
export function validateTransaction(input: any) {
  if (!input || typeof input.userId !== "string" || typeof input.amount !== "number") {
    throw new Error("userId and amount are required");
  }

  // userId — 정규화 + 길이/허용문자 검증
  const userId = normalizeUserId(input.userId);
  if (!userId) throw new Error("userId and amount are required");
  if (userId.length < USERID_MIN_LEN || userId.length > USERID_MAX_LEN) {
    throw new Error(`userId must be ${USERID_MIN_LEN}~${USERID_MAX_LEN} chars`);
  }
  if (!USERID_REGEX.test(userId)) {
    throw new Error("userId has invalid characters");
  }

  // amount — 유한수·정수·범위 검증 (데빗/크레딧 모두 허용)
  const amount = input.amount;
  if (!isFiniteNumber(amount)) throw new Error("userId and amount are required");
  if (!Number.isInteger(amount)) throw new Error("amount must be an integer");
  if (amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    throw new Error(`amount out of range (${AMOUNT_MIN}..${AMOUNT_MAX})`);
  }
  if (amount === 0) throw new Error("amount cannot be zero"); // 무의미한 트랜잭션 방지(정책)

  // reason — 선택 입력, 기본값 유지("adjust")
  let reason = "adjust";
  if (typeof input.reason === "string") {
    const r = normalizeReason(input.reason);
    if (r) reason = r;
  }

  // 계약 준수 반환
  return { userId, amount, reason };
}

// ───────── 계정별 지갑 델타용 Public API ─────────

/**
 * /api/wallet POST 에서 사용하는 통합 델타 구조.
 * - userId: 서버 컨텍스트(세션)에서 주입, 클라이언트 값은 신뢰하지 않음
 * - game: 어떤 게임/액션인지(예: "tetris", "today-lucky")
 * - pointsDelta: 포인트(+획득 / -차감)
 * - ticketsDelta: 티켓(+획득 / -소모)
 * - expDelta: 경험치(+만 허용하게 쓰는 것을 권장, 스키마는 음수도 허용)
 * - playsDelta: 플레이 횟수 증가량(0 이상)
 * - reason: 감사로그용 설명 문자열
 * - meta: 부가정보(플랫폼 내부에서만 사용, DB에 JSON 컬럼으로 저장 가능)
 */
export interface WalletDelta {
  userId: string;
  game: string;
  pointsDelta: number;
  ticketsDelta: number;
  expDelta: number;
  playsDelta: number;
  reason: string;
  meta?: Record<string, unknown>;
}

/**
 * validateWalletDelta
 * - 컨트롤러에서는 세션에서 얻은 userId 를 userIdFromContext 로 전달하고,
 *   body 에 들어있는 userId 는 완전히 무시하거나 별도 감사용으로만 사용.
 * - 아무 값도 변하지 않는 경우(모든 델타 0)는 정책상 에러로 본다.
 */
export function validateWalletDelta(
  body: any,
  userIdFromContext: string
): WalletDelta {
  // 1) userId: 항상 서버 컨텍스트 기준
  const normalizedUser = normalizeUserId(userIdFromContext);
  if (!normalizedUser) {
    throw new Error("authenticated userId is required");
  }
  if (normalizedUser.length < USERID_MIN_LEN || normalizedUser.length > USERID_MAX_LEN) {
    throw new Error(`userId must be ${USERID_MIN_LEN}~${USERID_MAX_LEN} chars`);
  }
  if (!USERID_REGEX.test(normalizedUser)) {
    throw new Error("userId has invalid characters");
  }

  // 2) game 식별자 (옵션)
  let game = "unknown";
  if (body && typeof body.game === "string") {
    const g = normalizeGameId(body.game);
    if (g) game = g;
  }

  // 3) 델타 값들
  const pointsDelta  = toIntInRange(body?.pointsEarned ?? 0,  DELTA_MIN, DELTA_MAX);
  const ticketsDelta = toIntInRange(body?.ticketsEarned ?? 0, DELTA_MIN, DELTA_MAX);
  const expDelta     = toIntInRange(body?.expEarned ?? 0,     DELTA_MIN, DELTA_MAX);
  let playsDelta     = toIntInRange(body?.playsIncrement ?? 0, PLAYS_MIN, PLAYS_MAX);
  if (playsDelta < 0) playsDelta = 0; // 음수 플레이 인크리먼트는 허용하지 않음

  // 4) reason / meta
  let reason = "game";
  if (typeof body?.reason === "string") {
    const r = normalizeReason(body.reason);
    if (r) reason = r;
  } else if (typeof body?.action === "string") {
    const r = normalizeReason(body.action);
    if (r) reason = r;
  }

  let meta: Record<string, unknown> | undefined;
  if (body && typeof body.meta === "object" && body.meta !== null) {
    meta = body.meta as Record<string, unknown>;
  }

  // 5) 무의미한 요청 방지: 모든 델타가 0이면 에러
  if (
    pointsDelta === 0 &&
    ticketsDelta === 0 &&
    expDelta === 0 &&
    playsDelta === 0
  ) {
    throw new Error("wallet delta cannot be all zero");
  }

  return {
    userId: normalizedUser,
    game,
    pointsDelta,
    ticketsDelta,
    expDelta,
    playsDelta,
    reason,
    meta,
  };
}
