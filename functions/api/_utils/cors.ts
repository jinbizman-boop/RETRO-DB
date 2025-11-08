// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\cors.ts

/**
 * Hardened CORS helpers for Cloudflare Workers/Pages.
 * - Keeps original contract:
 *    withCORS(response: Response, origin: string): Response
 *    preflight(origin: string): Response
 * - "origin" policy string:
 *    - "*" : wildcard (credentials=false 강제)
 *    - "https://example.com" : 단일 오리진 (credentials=true 자동 허용)
 *    - 콤마 구분 다중 오리진 문자열도 허용("https://a.com,https://b.com") → 첫 값 사용 (계약 유지 위해 echo 없음)
 *      ※ 다중 오리진 동적 에코가 필요하면 호출측에서 요청 Origin을 골라 넘겨주세요.
 */

const DEFAULT_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_REQ_HEADERS = "Content-Type,Authorization";
const DEFAULT_EXPOSE = "Content-Type,Authorization,ETag,Location,Cache-Control,Content-Length";
const PREFLIGHT_MAX_AGE_SEC = 86400; // 24h

// Chrome Private Network Access preflight opt-in (set to true only if you intend to allow it)
const ALLOW_PRIVATE_NETWORK = false;

function sanitizeOrigin(policy: string): string {
  // 허용 스킴만 통과
  const first = (policy || "").split(",")[0]?.trim();
  if (!first) return "null";
  if (first === "*") return "*";
  try {
    const u = new URL(first);
    if (u.protocol === "https:" || u.protocol === "http:") {
      // 정규화: 소문자 호스트 + 제거 가능한 기본 포트 제거
      const host = u.host.toLowerCase();
      const proto = u.protocol;
      const port = u.port;
      const isDefaultPort = (proto === "https:" && (port === "" || port === "443")) ||
                            (proto === "http:"  && (port === "" || port === "80"));
      const normalized = `${proto}//${isDefaultPort ? u.hostname.toLowerCase() : host}`;
      return normalized;
    }
  } catch { /* fallthrough */ }
  return "null";
}

// Response 헤더 병합 유틸(기존 값 유지 + 필요한 값 설정, 대소문자 정규화)
function setHeader(headers: Headers, key: string, value: string) {
  headers.set(key, value);
}
function appendVary(headers: Headers, field: string) {
  const prev = headers.get("Vary");
  const set = new Set<string>();
  if (prev) prev.split(",").forEach(v => set.add(v.trim()));
  set.add(field);
  headers.set("Vary", Array.from(set).join(", "));
}

export function withCORS(response: Response, origin: string) {
  const headers = new Headers(response.headers);
  const allowOrigin = sanitizeOrigin(origin);
  const allowCreds = allowOrigin !== "*"; // 와일드카드면 자격증명 금지 (표준)

  setHeader(headers, "Access-Control-Allow-Origin", allowOrigin);
  // 표준 CORS 캐싱·분기 안정화
  appendVary(headers, "Origin");

  // 허용 메서드/헤더: 기존 값과 충돌 없이 보수적으로 세팅
  if (!headers.has("Access-Control-Allow-Methods")) {
    setHeader(headers, "Access-Control-Allow-Methods", DEFAULT_METHODS);
  }
  if (!headers.has("Access-Control-Allow-Headers")) {
    setHeader(headers, "Access-Control-Allow-Headers", DEFAULT_REQ_HEADERS);
  }

  // 노출 헤더 기본 세트(필요 시 호출부에서 응답 생성 시 추가도 가능)
  if (!headers.has("Access-Control-Expose-Headers")) {
    setHeader(headers, "Access-Control-Expose-Headers", DEFAULT_EXPOSE);
  }

  // 자격증명은 단일 오리진일 때만 허용
  if (allowCreds) {
    setHeader(headers, "Access-Control-Allow-Credentials", "true");
  } else {
    headers.delete("Access-Control-Allow-Credentials");
  }

  return new Response(response.body, { ...response, headers });
}

export function preflight(origin: string) {
  const allowOrigin = sanitizeOrigin(origin);
  const headers = new Headers();

  setHeader(headers, "Access-Control-Allow-Origin", allowOrigin);
  setHeader(headers, "Access-Control-Allow-Methods", DEFAULT_METHODS);
  setHeader(headers, "Access-Control-Allow-Headers", DEFAULT_REQ_HEADERS);
  setHeader(headers, "Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SEC));
  setHeader(headers, "Access-Control-Expose-Headers", DEFAULT_EXPOSE);

  // Vary 보강: 요청 헤더 기반 캐시 분기
  appendVary(headers, "Origin");
  appendVary(headers, "Access-Control-Request-Method");
  appendVary(headers, "Access-Control-Request-Headers");

  // 단일 오리진만 크리덴셜 허용
  if (allowOrigin !== "*") {
    setHeader(headers, "Access-Control-Allow-Credentials", "true");
  }

  // PNA(Private Network Access) 옵트인(필요 시만 true)
  if (ALLOW_PRIVATE_NETWORK) {
    setHeader(headers, "Access-Control-Allow-Private-Network", "true");
  }

  // 내용 없는 204가 일부 환경에서 이슈가 있을 수 있어, 명시적 본문/길이 제공
  return new Response("", { status: 204, headers });
}
