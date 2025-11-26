// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\auth.ts

/**
 * Hardened auth payload validators.
 * - 기본 계약 유지: 항상 { email: string, password: string, ...부가필드 } 반환
 * - Email: Unicode 안전화(NFKC), 공백/제어문자 제거, 형식/길이 검증, 단순 스푸핑 방지
 * - Password: 길이/구성(문자군 다양성), 제어문자/널문자 차단, 흔한 비밀번호/키보드 패턴 차단
 * - 회원가입 추가 정보(username, gender, birth, phone, agree)도 함께 정규화/검증
 * - 의존성 0 (Edge/Workers 호환)
 */

// ───────── Tunables (보안 정책) ─────────
const EMAIL_MAX_LEN = 254;          // RFC 가이드 범위
const EMAIL_LOCAL_MAX_LEN = 64;     // local-part 권장 상한
const PASSWORD_MIN_LEN = 8;         // OWASP 권장 최소
const PASSWORD_MAX_LEN = 128;       // 현실적 상한(브루트포스/리소스 보호)
const PASSWORD_MIN_CLASSES = 2;     // 소/대/숫자/기호 네 가지 중 최소 몇 종류

// username / phone 등 가입정보 기본 정책
const USERNAME_MIN_LEN = 2;
const USERNAME_MAX_LEN = 32;
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 20;

// 매우 흔한 비밀번호/패턴(짧은 샘플; 서버측 추가 블랙리스트 권장)
const COMMON_PASSWORDS = new Set([
  "password","123456","123456789","qwerty","111111","123123",
  "abc123","1q2w3e4r","iloveyou","admin","letmein","welcome",
  "000000","qwerty123","passw0rd"
]);

const KEYBOARD_SEQUENCES = ["qwerty","asdf","zxcv","1q2w3e","qazwsx"];

// ───────── 유틸리티 ─────────
function stripControlExceptWhitespace(s: string): string {
  // 탭/개행/캐리지리턴은 허용, 그 외 제어문자 제거
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // 공백 트림, 제어문자 제거, 유니코드 정규화, 소문자화
  let s = raw.trim();
  s = stripControlExceptWhitespace(s);
  try { s = s.normalize("NFKC"); } catch {}
  s = s.toLowerCase();
  // 연속 공백 제거
  s = s.replace(/\s+/g, " ");
  return s;
}

function isValidEmailFormat(email: string): boolean {
  // 매우 강한 RFC 정규식 대신 현실적으로 안전한 검증(국제화 도메인/서브도메인 허용)
  // - local@domain.tld
  // - local: 영문/숫자/._%+- (유니코드 로컬파트는 실제 운영에서 제한하는 경우 많음)
  // - domain: 유니코드 허용하되 공백/특수 제어 제외, 점 1회 이상
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length === 0 || local.length > EMAIL_LOCAL_MAX_LEN) return false;
  if (domain.length === 0) return false;
  if (email.length > EMAIL_MAX_LEN) return false;

  // local-part: 비교적 관용적(운영 단계에서 추가 제한 가능)
  if (!/^[a-z0-9._%+\-]+$/i.test(local)) return false;

  // domain: 점 포함, 각 라벨은 시작/끝 하이픈 불가, 빈 라벨 불가
  if (!domain.includes(".")) return false;
  const labels = domain.split(".");
  if (labels.some(l => l.length === 0)) return false;
  if (labels.some(l => /^-/.test(l) || /-$/.test(l))) return false;

  return true;
}

function assessPasswordStrength(password: string): { ok: boolean; reason?: string } {
  // 길이
  if (password.length < PASSWORD_MIN_LEN) return { ok: false, reason: `password must be ≥ ${PASSWORD_MIN_LEN} chars` };
  if (password.length > PASSWORD_MAX_LEN) return { ok: false, reason: `password must be ≤ ${PASSWORD_MAX_LEN} chars` };

  // 제어문자/널문자 차단
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(password)) {
    return { ok: false, reason: "password contains control characters" };
  }

  // 공백만으로 구성 금지
  if (!password.trim()) return { ok: false, reason: "password cannot be blank/whitespace only" };

  // 문자군 다양성: 소/대/숫자/기호 4종 중 최소 N종
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes < PASSWORD_MIN_CLASSES) return { ok: false, reason: `password must include at least ${PASSWORD_MIN_CLASSES} character classes` };

  // 흔한 비번/키보드 시퀀스 간단 차단
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return { ok: false, reason: "password is too common" };
  if (KEYBOARD_SEQUENCES.some(seq => lower.includes(seq))) return { ok: false, reason: "password contains an easily guessable sequence" };

  // 연속 또는 반복 패턴(간단 휴리스틱)
  if (/^(.)\1{5,}$/.test(password)) return { ok: false, reason: "password is a trivial repetition" };
  if (/^(?:0123|1234|2345|3456|4567|5678|6789){2,}$/.test(lower)) return { ok: false, reason: "password contains trivial ascending sequence" };

  return { ok: true };
}

// ───────── 회원가입 추가 필드 유틸 ─────────

function normalizeUsername(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;

  let s = stripControlExceptWhitespace(raw).trim();
  if (!s) return null;

  try { s = s.normalize("NFKC"); } catch {}

  // 공백을 하나로 축소
  s = s.replace(/\s+/g, " ");

  // 기본 허용 문자: 한글/영문/숫자/공백/._- (너무 빡세지 않게)
  if (!/^[\p{L}\p{N} ._\-]+$/u.test(s)) {
    // 허용 범위 밖 문자가 섞여 있으면 가입은 가능하게 두되, username 은 무시
    return null;
  }

  if (s.length < USERNAME_MIN_LEN || s.length > USERNAME_MAX_LEN) {
    return null;
  }

  return s;
}

function normalizeGender(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;

  let s = stripControlExceptWhitespace(raw).trim();
  if (!s) return null;
  try { s = s.normalize("NFKC"); } catch {}
  const lower = s.toLowerCase();

  // 간단 매핑 (실제 저장은 원문 그대로 두고 싶다면 s를 쓰면 됨)
  if (["m", "male", "남", "남자"].includes(lower)) return "male";
  if (["f", "female", "여", "여자"].includes(lower)) return "female";
  if (lower === "other" || lower === "기타") return "other";

  // 그 외 값은 free-text 로 허용: 너무 길면 잘라냄
  if (s.length > 32) s = s.slice(0, 32);
  return s;
}

function normalizePhone(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;

  let s = stripControlExceptWhitespace(raw);
  // 숫자/플러스/하이픈/공백만 허용하고 나머지는 제거
  s = s.replace(/[^\d+\- ]+/g, "");
  s = s.trim();
  if (!s) return null;

  // 순수 숫자 길이 기준 검증
  const digits = s.replace(/\D/g, "");
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    return null;
  }

  // 정규화: 앞/뒤 공백 제거, 중복 공백/하이픈 축소
  s = s.replace(/\s+/g, " ");
  return s;
}

function normalizeBirth(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;

  let s = stripControlExceptWhitespace(raw).trim();
  if (!s) return null;
  try { s = s.normalize("NFKC"); } catch {}

  // 허용 포맷 1: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // 허용 포맷 2: YYYY.MM.DD / YYYY/MM/DD / YYYY MM DD 등 → '-'로 변환
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 8) {
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    const iso = `${y}-${m}-${d}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }

  // 그 외는 무시 (가입 자체는 허용, birth만 null)
  return null;
}

function coerceAgree(raw: unknown): boolean {
  // checkbox true/false, "on", "true", "1" 등 폭넓게 처리
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on", "agree"].includes(s)) return true;
    return false;
  }
  return false;
}

// ───────── Public API (계약 유지 + 확장) ─────────

export type SignupPayload = {
  email: string;
  password: string;
  username: string | null;
  gender: string | null;
  birth: string | null;   // ISO YYYY-MM-DD or null
  phone: string | null;
  agree: boolean;         // 이용약관 동의 여부
};

export function validateSignup(input: any): SignupPayload {
  // 기존 계약: email/password 필수
  if (!input || typeof input.email !== "string" || typeof input.password !== "string") {
    throw new Error("email and password are required");
  }

  // Email 정규화 + 형식 검증
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("email is required");
  if (!isValidEmailFormat(email)) throw new Error("invalid email");

  // Password: 원문 그대로 반환(계약 준수)하되, 강력 검증만 수행
  const password: string = input.password;
  const pw = assessPasswordStrength(password);
  if (!pw.ok) throw new Error(pw.reason || "weak password");

  // ── 회원가입 추가 필드 정규화/검증 ──
  const username = normalizeUsername(input.username);
  const gender = normalizeGender(input.gender);
  const birth = normalizeBirth(input.birth);
  const phone = normalizePhone(input.phone);

  // agree/agreements/terms 같은 키들을 최대한 수용
  const agreeRaw =
    input.agree ??
    input.agreed ??
    input.terms ??
    input.termsAgree ??
    input.terms_agree;

  const agree = coerceAgree(agreeRaw);

  // 여기서 agree를 반드시 true로 강제할지 여부는 정책에 따라 다름
  // 가입 자체에 약관 동의 필수라면:
  if (!agree) {
    // 메시지는 프론트에서 한글로 매핑 가능 (백엔드는 키워드 위주)
    throw new Error("terms_not_agreed");
  }

  return {
    email,
    password,
    username,
    gender,
    birth,
    phone,
    agree,
  };
}

export function validateLogin(input: any) {
  // 로그인에서는 email/password만 실제로 사용하지만,
  // signup과 동일한 보안 기준을 재사용 (추가 필드는 무시해도 무방).
  const { email, password } = validateSignup(input);
  return { email, password };
}
