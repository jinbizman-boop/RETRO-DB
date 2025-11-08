// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\profile.ts

/**
 * Hardened validator for profile updates.
 * - Keeps original contract: returns { userId: string, username: string|null, avatar: string|null }
 * - userId: NFKC 정규화, 길이/허용문자 검증
 * - username: 제어문자 제거, 공백 정리, 길이/허용문자 검증(국제어/한글 지원)
 * - avatar: http/https 절대 URL 또는 안전한 상대 경로(/assets/**)만 허용, data URL 제한
 * - 의존성 0 (Edge/Workers 호환)
 */

// ───────── 정책값 (필요시 서비스 정책에 맞게 조정) ─────────
const USERID_MIN_LEN = 3;
const USERID_MAX_LEN = 64;
const USERID_REGEX   = /^[a-zA-Z0-9_\-.:@]+$/; // 서비스 전역과 일치(이전 스키마와 호환)

const USERNAME_MIN_LEN = 2;
const USERNAME_MAX_LEN = 32;
// 국제어/한글/숫자/공백/._- 허용
const USERNAME_REGEX = /^[\p{L}\p{N}\s._-]+$/u;

const AVATAR_MAX_LEN = 1024;             // URL 길이 상한
const DATA_URL_MAX_CHARS = 150_000;      // data:image/* 허용 시 길이 제한(≈100KB 내외)

// ───────── 유틸 ─────────
function stripControlExceptWhitespace(s: string): string {
  // 탭/개행/CR 허용, 나머지 제어문자 제거
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
function cleanString(v: unknown): string {
  if (typeof v !== "string") return "";
  let s = v.trim();
  s = stripControlExceptWhitespace(s);
  try { s = s.normalize("NFKC"); } catch {} // 유니코드 정규화
  // 연속 공백 축약
  s = s.replace(/\s+/g, " ");
  return s.trim();
}
function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = cleanString(raw);
  return s || null;
}
function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = cleanString(raw);
  if (!s) return null;
  return s;
}
function isHttpHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}
function isSafeRelativePath(s: string): boolean {
  // /assets/** 혹은 assets/** 만 허용 (디렉터리 탈출 금지)
  if (/^\/?assets\//.test(s) && !s.includes("..")) return true;
  return false;
}
function isDataImageUrl(s: string): boolean {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s) && s.length <= DATA_URL_MAX_CHARS;
}
function normalizeAvatar(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = cleanString(raw);
  if (!s) return null;
  if (s.length > AVATAR_MAX_LEN) return null;

  // 허용 형태: 절대 http/https, 안전한 상대경로(/assets/**), 제한된 data:image/*
  if (isHttpHttpsUrl(s) || isSafeRelativePath(s) || isDataImageUrl(s)) {
    return s;
  }
  return null; // 허용 범위 외 URL/경로는 무시
}

// ───────── Public API (계약 유지) ─────────
export function validateProfileUpdate(input: any) {
  if (!input || typeof input.userId !== "string") {
    throw new Error("userId required");
  }

  // userId: 정규화 + 길이/허용문자 검증
  const userId = normalizeUserId(input.userId);
  if (!userId) throw new Error("userId required");
  if (userId.length < USERID_MIN_LEN || userId.length > USERID_MAX_LEN) {
    throw new Error(`userId must be ${USERID_MIN_LEN}~${USERID_MAX_LEN} chars`);
  }
  if (!USERID_REGEX.test(userId)) {
    throw new Error("userId has invalid characters");
  }

  // username: 선택 입력 — 정규화 후 허용문자/길이 검증
  let username: string | null = null;
  if (typeof input.username === "string") {
    const u = normalizeUsername(input.username);
    if (u) {
      if (u.length < USERNAME_MIN_LEN || u.length > USERNAME_MAX_LEN) {
        throw new Error(`username must be ${USERNAME_MIN_LEN}~${USERNAME_MAX_LEN} chars`);
      }
      if (!USERNAME_REGEX.test(u)) {
        throw new Error("username has invalid characters");
      }
      username = u;
    } else {
      username = null; // 빈 문자열이면 null 처리(계약 유지)
    }
  }

  // avatar: 선택 입력 — 허용된 스킴/경로만 통과
  let avatar: string | null = null;
  if (typeof input.avatar === "string") {
    const a = normalizeAvatar(input.avatar);
    avatar = a; // 허용 외는 null
  }

  // 원래 계약과 동일한 반환
  return { userId, username, avatar };
}
