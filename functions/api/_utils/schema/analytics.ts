// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\schema\analytics.ts

/**
 * Hardened validator for analytics event payloads.
 * - Keeps original contract: returns { event: string, userId: string|null, meta: object }
 * - Adds normalization, strict type checks, size/depth limits, and JSON-safety.
 */

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonObject = { [k: string]: JsonValue };
type JsonArray = JsonValue[];

// ────────────────────────────── Tunables ──────────────────────────────
const MAX_EVENT_LEN = 64;
const MIN_EVENT_LEN = 1;

const MAX_USERID_LEN = 64;
const MIN_USERID_LEN = 3;
const USERID_REGEX = /^[a-zA-Z0-9_\-.:@]+$/; // 폭넓은 ID 허용(기존 계약 유지)

const MAX_META_DEPTH = 5;
const MAX_META_KEYS_PER_OBJECT = 50;
const MAX_META_ARRAY_LENGTH = 100;
const MAX_META_STRING_LENGTH = 2000; // 긴 문자열은 잘라서 보관
const MAX_META_TOTAL_BYTES = 8 * 1024; // 8KB: 전송/저장 비용 보호

// 제어문자 제거(탭/개행은 허용), 앞뒤 공백 정리
function cleanString(s: unknown): string {
  if (typeof s !== "string") return "";
  // remove control chars except \t\r\n
  const cleaned = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return cleaned.trim();
}

// plain object 판별
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

// JSON 직렬화 안전한 값으로 정리 + 크기/깊이 제한
function sanitizeJson(
  input: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): JsonValue {
  if (input == null) return null;

  // 원시값
  if (typeof input === "string") {
    const s = cleanString(input);
    return s.length > MAX_META_STRING_LENGTH ? (s.slice(0, MAX_META_STRING_LENGTH) + "…") : s;
  }
  if (typeof input === "number") {
    if (Number.isNaN(input) || !Number.isFinite(input)) return null;
    return input;
  }
  if (typeof input === "boolean") return input;

  // 함수/심볼/빅인트/날짜/버퍼 등은 직렬화 가능한 값으로 축약
  if (typeof input === "bigint") return Number(input);
  if (typeof input === "symbol" || typeof input === "function") return null;
  if (input instanceof Date) return input.toISOString();
  if (input instanceof ArrayBuffer) return `ArrayBuffer(${input.byteLength})`;
  if (ArrayBuffer.isView(input as any)) {
    // e.g., Uint8Array
    try {
      const ab = (input as any).buffer as ArrayBuffer;
      return `TypedArray(${ab.byteLength})`;
    } catch {
      return "TypedArray";
    }
  }

  if (depth >= MAX_META_DEPTH) {
    // 깊이 제한 초과 시 요약
    if (Array.isArray(input)) return `[Array(depth>${MAX_META_DEPTH})]` as unknown as JsonValue;
    if (isPlainObject(input)) return `{Object(depth>${MAX_META_DEPTH})}` as unknown as JsonValue;
    return null;
  }

  if (typeof input === "object") {
    if (seen.has(input as object)) return "[Circular]" as unknown as JsonValue;
    seen.add(input as object);

    // 배열
    if (Array.isArray(input)) {
      const out: JsonArray = [];
      for (let i = 0; i < Math.min(input.length, MAX_META_ARRAY_LENGTH); i++) {
        out.push(sanitizeJson(input[i], depth + 1, seen));
      }
      return out;
    }

    // plain object
    if (isPlainObject(input)) {
      const out: JsonObject = {};
      const entries = Object.entries(input);
      let count = 0;
      for (const [rawKey, rawVal] of entries) {
        if (count >= MAX_META_KEYS_PER_OBJECT) {
          out["__truncated__"] = true;
          break;
        }
        const key = cleanString(String(rawKey)).slice(0, 120) || "_";
        const val = sanitizeJson(rawVal, depth + 1, seen);
        if (val !== undefined) {
          out[key] = val;
          count++;
        }
      }
      return out;
    }

    // 그 외 객체는 문자열 요약
    try {
      const tag = Object.prototype.toString.call(input); // [object Map] 등
      return String(tag);
    } catch {
      return "Object";
    }
  }

  // 기타 미지의 타입
  return null;
}

// 총 바이트 제한 적용
function capByBytes(obj: JsonObject): JsonObject {
  let json = "";
  try {
    json = JSON.stringify(obj);
  } catch {
    return { meta: "[Unserializable]" };
  }
  if (new TextEncoder().encode(json).length <= MAX_META_TOTAL_BYTES) {
    return obj;
  }
  // 큰 경우, 얕은 수준의 키를 우선 유지하며 점진적으로 잘라내기
  const shallow: JsonObject = {};
  const keys = Object.keys(obj);
  for (const k of keys) {
    shallow[k] = obj[k];
    const size = new TextEncoder().encode(JSON.stringify(shallow)).length;
    if (size > MAX_META_TOTAL_BYTES) {
      delete shallow[k];
      shallow["__truncated_bytes__"] = true;
      break;
    }
  }
  return shallow;
}

// 선택적 필드를 meta로 보조 병합 (계약은 유지: 반환 필드는 event/userId/meta)
function mergeOptionalIntoMeta(input: any, meta: JsonObject): JsonObject {
  // 클라이언트가 별도로 넘길 수 있는 보조 필드들(있으면 meta에만 흡수)
  const extras: Record<string, unknown> = {};
  if (typeof input.page === "string") extras.page = cleanString(input.page).slice(0, 300);
  if (typeof input.referrer === "string") extras.referrer = cleanString(input.referrer).slice(0, 600);
  if (typeof input.userAgent === "string") extras.userAgent = cleanString(input.userAgent).slice(0, 600);
  if (typeof input.lang === "string") extras.lang = cleanString(input.lang).slice(0, 32);
  if (typeof input.ts === "number" && Number.isFinite(input.ts)) extras.ts = input.ts;

  return capByBytes({ ...meta, ...sanitizeJson(extras) as JsonObject });
}

// ────────────────────────────── Public API ──────────────────────────────
export function validateEvent(input: any) {
  if (!input || typeof input !== "object") {
    throw new Error("invalid payload");
  }

  // event
  const rawEvent = cleanString((input as any).event);
  if (!rawEvent || rawEvent.length < MIN_EVENT_LEN) throw new Error("event is required");
  if (rawEvent.length > MAX_EVENT_LEN) throw new Error(`event must be <= ${MAX_EVENT_LEN} chars`);

  // userId (optional)
  let userId: string | null = null;
  if (typeof (input as any).userId === "string") {
    const uid = cleanString((input as any).userId);
    if (uid) {
      if (uid.length < MIN_USERID_LEN || uid.length > MAX_USERID_LEN) {
        throw new Error(`userId must be ${MIN_USERID_LEN}~${MAX_USERID_LEN} chars`);
      }
      if (!USERID_REGEX.test(uid)) {
        throw new Error("userId has invalid characters");
      }
      userId = uid;
    }
  }

  // meta
  const rawMeta = (input as any).meta;
  const baseMeta: JsonObject = isPlainObject(rawMeta) ? (sanitizeJson(rawMeta) as JsonObject) : {};
  const mergedMeta = mergeOptionalIntoMeta(input, baseMeta);
  const meta = capByBytes(mergedMeta);

  // 계약 유지: event(string), userId(string|null), meta(object)
  return { event: rawEvent, userId, meta };
}
