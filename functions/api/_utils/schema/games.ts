// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\games.ts

/**
 * Hardened validator for game score submissions.
 * - Keeps original contract: returns { userId: string, game: string, score: number }
 * - Adds strong normalization, bounds checks, character/length policies, and anti-corruption guards.
 * - No external deps (Edge/Workers friendly).
 */

// ───────── Tunables ─────────
const USERID_MIN_LEN = 3;
const USERID_MAX_LEN = 64;
const USERID_REGEX   = /^[a-zA-Z0-9_\-.:@]+$/; // 유저 ID 허용 문자 집합

const GAME_MIN_LEN = 1;
const GAME_MAX_LEN = 64;
const GAME_ID_REGEX = /^[a-z0-9][a-z0-9_\-.:/]*$/; // 게임 ID: 소문자 시작 + 안전 문자

// score 허용 범위(일반적인 랭킹 점수 가정; 서비스 정책에 맞게 조정 가능)
const SCORE_MIN = -1_000_000_000;
const SCORE_MAX =  1_000_000_000;

// 제어문자 제거(탭/개행 허용), 트림
function cleanString(s: unknown): string {
  if (typeof s !== "string") return "";
  const cleaned = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return cleaned.trim();
}

function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = cleanString(raw);
  try { s = s.normalize("NFKC"); } catch {}
  return s || null;
}

function normalizeGameId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = cleanString(raw);
  try { s = s.normalize("NFKC"); } catch {}
  // 일반적으로 게임 ID는 소문자 사용. (계약 유지 위해 값 자체는 소문자로 정규화)
  s = s.toLowerCase();
  return s || null;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * 원본 계약 유지: { userId, game, score } 그대로 반환
 * - 단, 문자열은 안전한 정규화(NFKC) 및 공백/제어문자 제거 후 사용
 * - score는 유효 범위/유한성만 강제(정수 강제 X: 기존 규격을 해치지 않기 위함)
 */
export function validateScore(input: any) {
  if (!input) throw new Error("userId, game, score are required");

  // ── userId ──────────────────────────────────────────────────────────
  const userId = normalizeUserId(input.userId);
  if (!userId) throw new Error("userId, game, score are required");
  if (userId.length < USERID_MIN_LEN || userId.length > USERID_MAX_LEN) {
    throw new Error(`userId must be ${USERID_MIN_LEN}~${USERID_MAX_LEN} chars`);
  }
  if (!USERID_REGEX.test(userId)) {
    throw new Error("userId has invalid characters");
  }

  // ── game id ─────────────────────────────────────────────────────────
  const game = normalizeGameId(input.game);
  if (!game) throw new Error("userId, game, score are required");
  if (game.length < GAME_MIN_LEN || game.length > GAME_MAX_LEN) {
    throw new Error(`game must be ${GAME_MIN_LEN}~${GAME_MAX_LEN} chars`);
  }
  if (!GAME_ID_REGEX.test(game)) {
    throw new Error("invalid game id");
  }

  // ── score ───────────────────────────────────────────────────────────
  const score = input.score;
  if (!isFiniteNumber(score)) throw new Error("userId, game, score are required");

  // 안전 범위(서비스 정책에 맞게 조절 가능 / 기존 스키마는 그대로)
  if (score < SCORE_MIN || score > SCORE_MAX) {
    throw new Error(`score out of range (${SCORE_MIN}..${SCORE_MAX})`);
  }

  // NaN, Infinity 등은 위 isFiniteNumber로 차단.
  // 정수 강제는 하지 않음(기존 규격 유지). 필요 시 아래 주석 해제:
  // if (!Number.isInteger(score)) throw new Error("score must be an integer");

  // ── 계약 준수 반환 ───────────────────────────────────────────────────
  return { userId, game, score };
}
