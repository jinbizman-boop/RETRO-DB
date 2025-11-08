// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\json.ts

/**
 * Hardened JSON helpers for API responses and request bodies.
 * - Keeps original contract:
 *    json(data: unknown, init?: ResponseInit): Response
 *    readJSON<T = any>(req: Request): Promise<T>
 *
 * Enhancements:
 * 1) 안전 직렬화:
 *    - 순환 참조 감지 및 요약
 *    - BigInt → 문자열 치환
 *    - Date → ISO 문자열
 *    - 함수/심볼/undefined → 제거
 *    - U+2028/U+2029 이스케이프(</script> 안전성 보강)
 * 2) 응답 헤더 보강:
 *    - Content-Type을 항상 `application/json; charset=utf-8`로 명시(기존 동작 유지)
 *    - JSON 길이(바이트) 자동 계산 후 Content-Length 설정(선택적)
 * 3) 입력 파싱 보강:
 *    - 빈 본문은 기존처럼 `{}` 반환
 *    - Content-Length 사전 점검(기본 1MB 상한)으로 대용량/DoS 방지
 *    - 잘못된 JSON에 대한 명확한 에러 메시지
 */

const READJSON_MAX_BYTES = 1 * 1024 * 1024; // 1MB

// ───────── 내부 유틸 ─────────
function byteLengthUTF8(s: string): number {
  return new TextEncoder().encode(s).length;
}

// 순환/비직렬 타입/BigInt/Date 등을 처리하는 안전한 stringify
function safeJSONStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>();

  const replacer = (_key: string, val: any) => {
    // 순환 참조 방지
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }

    // 타입 정규화
    switch (typeof val) {
      case "bigint":
        return val.toString(); // BigInt → string (JSON 사양 충돌 방지)
      case "function":
      case "symbol":
      case "undefined":
        return undefined; // 제거
      case "number":
        // NaN/Infinity를 null로 처리
        return Number.isFinite(val) ? val : null;
      default:
        break;
    }

    if (val instanceof Date) return val.toISOString();

    // ArrayBuffer/TypedArray 요약
    if (val instanceof ArrayBuffer) return `ArrayBuffer(${val.byteLength})`;
    if (ArrayBuffer.isView(val)) {
      const ab = (val as ArrayBufferView).buffer;
      return `TypedArray(${ab.byteLength})`;
    }

    return val;
  };

  // 기본은 압축형(JSON 전체 길이 최소화)
  const json = JSON.stringify(value, replacer, space);

  // U+2028/U+2029 → JS 파서 이슈 회피(HTML <script> 삽입 등 상황 대비)
  return json
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ───────── 공개 API (계약 유지) ─────────
export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  // 안전 직렬화
  const body = safeJSONStringify(data);

  // Content-Length 설정(캐싱/프록시 호환성 향상; 필요 시 제거 가능)
  if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(byteLengthUTF8(body)));
  }

  return new Response(body, { ...init, headers });
}

export async function readJSON<T = any>(req: Request): Promise<T> {
  // 사전 용량 점검(가능하면 Content-Length를 활용)
  const cl = req.headers.get("Content-Length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > READJSON_MAX_BYTES) {
      throw new Error(`Payload too large (>${READJSON_MAX_BYTES} bytes)`);
    }
  }

  const text = await req.text();
  if (!text) return {} as T;

  // 본문 실제 바이트 길이로도 최종 검증
  if (byteLengthUTF8(text) > READJSON_MAX_BYTES) {
    throw new Error(`Payload too large (>${READJSON_MAX_BYTES} bytes)`);
  }

  try {
    // 표준 JSON 파싱
    return JSON.parse(text) as T;
  } catch (e: any) {
    // 파싱 실패 시 더 명확한 에러 메시지
    const msg = String(e?.message || "Invalid JSON");
    throw new Error(`Invalid JSON: ${msg}`);
  }
}
