// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\games.ts

/**
 * Hardened validator for game score submissions.
 * - Keeps original contract: returns { userId: string, game: string, score: number }
 * - (확장) slug/difficulty/mode/playTime/deviceHint/timestamps 등 부가 메타를 함께 정규화
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

// difficulty / mode / device 관련 설정
const DIFFICULTY_VALUES = ["easy", "normal", "hard", "extreme"] as const;
type Difficulty = (typeof DIFFICULTY_VALUES)[number] | null;

const MODE_MAX_LEN = 32;
const DEVICE_MAX_LEN = 64;

// playTime 범위 (ms)
const PLAYTIME_MIN_MS = 0;
const PLAYTIME_MAX_MS = 60 * 60 * 1000; // 최대 1시간

// ───────── Utilities ─────────

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

function normalizeDifficulty(raw: unknown): Difficulty {
  if (typeof raw !== "string") return null;
  let s = cleanString(raw).toLowerCase();
  if (!s) return null;

  if (s === "easy" || s === "e") return "easy";
  if (s === "normal" || s === "n" || s === "medium") return "normal";
  if (s === "hard" || s === "h") return "hard";
  if (s === "extreme" || s === "x") return "extreme";

  return null;
}

function normalizeMode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = cleanString(raw);
  try { s = s.normalize("NFKC"); } catch {}
  if (!s) return null;
  if (s.length > MODE_MAX_LEN) s = s.slice(0, MODE_MAX_LEN);
  // 영숫자/언더스코어/하이픈/스페이스 정도만 허용
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(s)) return null;
  return s;
}

function normalizeDeviceHint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = cleanString(raw);
  try { s = s.normalize("NFKC"); } catch {}
  if (!s) return null;
  if (s.length > DEVICE_MAX_LEN) s = s.slice(0, DEVICE_MAX_LEN);
  return s;
}

function normalizePlayTimeMs(raw: unknown): number | null {
  if (raw == null) return null;

  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    n = parsed;
  } else {
    return null;
  }

  if (!Number.isFinite(n)) return null;
  if (n < PLAYTIME_MIN_MS || n > PLAYTIME_MAX_MS) return null;

  return Math.floor(n);
}

function normalizeTimestamp(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;

  if (typeof raw === "number") {
    // ms 혹은 sec 둘 다 들어올 수 있음 → 대략 10^12 이상이면 ms, 아니면 sec로 가정
    const v = raw > 1e11 ? raw : raw * 1000;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

// ───────── Public API ─────────

export type ValidatedScore = {
  // 원본 계약 필드
  userId: string;
  game: string;
  score: number;

  // 확장 메타
  slug: string;                 // game 과 동일 (alias)
  difficulty: Difficulty;       // 난이도 (없으면 null)
  mode: string | null;          // 게임 모드 (ex. "classic", "timed")
  playTimeMs: number | null;    // 플레이 시간(ms)
  deviceHint: string | null;    // desktop/mobile 등 클라이언트 힌트
  startedAt: Date | null;       // 게임 시작 시각 (가능한 경우)
  finishedAt: Date | null;      // 게임 종료 시각 (가능한 경우)
  raw: any;                     // 원본 payload 스냅샷(디버깅/로깅 용도)
};

/**
 * 원본 계약 유지: { userId, game, score } 를 항상 포함해서 반환.
 * - 문자열은 안전한 정규화(NFKC) 및 공백/제어문자 제거 후 사용
 * - score는 유효 범위/유한성 강제 (정수 강제 X: 기존 규격 유지)
 * - (확장) slug/difficulty/mode/playTime/deviceHint/timestamps 등을 함께 반환
 */
export function validateScore(input: any): ValidatedScore {
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

  // ── game/slug ───────────────────────────────────────────────────────
  const rawGame = input.game ?? input.slug;
  const slug = normalizeGameId(rawGame);
  if (!slug) throw new Error("userId, game, score are required");
  if (slug.length < GAME_MIN_LEN || slug.length > GAME_MAX_LEN) {
    throw new Error(`game must be ${GAME_MIN_LEN}~${GAME_MAX_LEN} chars`);
  }
  if (!GAME_ID_REGEX.test(slug)) {
    throw new Error("invalid game id");
  }

  // ── score ───────────────────────────────────────────────────────────
  const score = input.score;
  if (!isFiniteNumber(score)) throw new Error("userId, game, score are required");

  // 안전 범위(서비스 정책에 맞게 조절 가능 / 기존 스키마는 그대로)
  if (score < SCORE_MIN || score > SCORE_MAX) {
    throw new Error(`score out of range (${SCORE_MIN}..${SCORE_MAX})`);
  }

  // ── 확장 메타 필드들 ────────────────────────────────────────────────
  const difficulty = normalizeDifficulty(input.difficulty ?? input.level);
  const mode = normalizeMode(input.mode ?? input.gameMode);
  const playTimeMs = normalizePlayTimeMs(
    input.playTimeMs ?? input.playtime ?? input.durationMs
  );
  const deviceHint = normalizeDeviceHint(
    input.deviceHint ?? input.device ?? input.client
  );

  const startedAt = normalizeTimestamp(
    input.startedAt ?? input.started_at ?? input.startTime
  );
  const finishedAt = normalizeTimestamp(
    input.finishedAt ?? input.finished_at ?? input.endTime
  );

  // ── 계약 준수 + 확장 필드 반환 ─────────────────────────────────────
  return {
    // 원본 계약 필드
    userId,
    game: slug,
    score,

    // 확장 메타
    slug,
    difficulty,
    mode,
    playTimeMs,
    deviceHint,
    startedAt,
    finishedAt,
    raw: input,
  };
}
