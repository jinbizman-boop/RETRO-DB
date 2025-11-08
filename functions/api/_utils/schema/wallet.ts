// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\wallet.ts

/**
 * Hardened validator for wallet transactions.
 * - Keeps original contract: returns { userId: string, amount: number, reason: string }
 * - userId: NFKC 정규화, 길이/허용문자 검증
 * - amount: 유한수/정수 강제, 합리적 범위(데빗/크레딧 모두 허용)
 * - reason: 기본값 "adjust" 유지, 제어문자 제거·허용문자/길이 제한
 * - 의존성 0 (Edge/Workers 호환)
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
function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

// ───────── Public API (계약 유지) ─────────
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
