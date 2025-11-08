// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\auth.ts

/**
 * Hardened auth payload validators.
 * - Keeps original contract: returns { email: string, password: string }
 * - Email: Unicode 안전화(NFKC), 공백/제어문자 제거, 형식/길이 검증, 단순 스푸핑 방지
 * - Password: 길이/구성(문자군 다양성), 제어문자/널문자 차단, 흔한 비밀번호/키보드 패턴 차단
 * - 의존성 0 (Edge/Workers 호환)
 */

// ───────── Tunables (보안 정책) ─────────
const EMAIL_MAX_LEN = 254;          // RFC 가이드 범위
const EMAIL_LOCAL_MAX_LEN = 64;     // local-part 권장 상한
const PASSWORD_MIN_LEN = 8;         // OWASP 권장 최소
const PASSWORD_MAX_LEN = 128;       // 현실적 상한(브루트포스/리소스 보호)
const PASSWORD_MIN_CLASSES = 2;     // 소/대/숫자/기호 네 가지 중 최소 몇 종류

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

// ───────── Public API (계약 유지) ─────────

export function validateSignup(input: any) {
  // 기존 계약: email/password 필수, 반환 { email, password }
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

  // (선택) 이메일 로컬파트/도메인의 혼동 문자열 미세 방지
  // 예: 유사한 유니코드 정규화 차이 등은 운영단(회원가입/중복체크)에서 추가 검증 권장

  return { email, password };
}

export function validateLogin(input: any) {
  // 기존 구현처럼 signup 규칙을 그대로 적용 (동일 계약/동일 보안수준)
  return validateSignup(input);
}
