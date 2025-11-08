// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\oauth\facebook.ts

import { json } from "../../_utils/json";
import { withCORS, preflight } from "../../_utils/cors";

/**
 * 문제 증상
 * - ts(2304): `PagesFunction` 타입 미정의
 * - ts(7031): 구조 분해 매개변수(request/env) 암시적 any
 * - ts(2769): `Object.fromEntries(headers)` 타입 불일치(Headers는 기본적으로
 *   TS의 lib.dom.iterable 설정이 없으면 iterable로 간주되지 않음)
 *
 * 해결
 * - 파일 내부에 Cloudflare Pages용 최소 ambient 타입 선언
 * - onRequest 인자 타입 명시
 * - 응답 헤더 구성 시 `Headers.forEach`로 **plain object**를 만들어
 *   타입 오류 없이 안전하게 합성
 */

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ───────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────── */

type Env = {
  CORS_ORIGIN: string;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_REDIRECT_URI?: string;
  FACEBOOK_SCOPE?: string; // e.g., "public_profile,email"
  OAUTH_PKCE?: string;     // "1" to enable code_challenge
};

const FB_AUTH_URL = "https://www.facebook.com/v19.0/dialog/oauth";

/* ───────────────────────────── helpers ───────────────────────────── */
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randState(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function sha256B64url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64url(new Uint8Array(digest));
}

/** 쿠키 설정 (보안 기본값 강화) */
function setCookie(
  headers: Headers,
  name: string,
  value: string,
  opts?: Partial<{
    path: string;
    maxAge: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "Strict" | "None";
    domain: string;
  }>
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const o = opts || {};
  parts.push(`Path=${o.path ?? "/"}`);
  if (typeof o.maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.httpOnly !== false) parts.push("HttpOnly"); // 기본 HttpOnly
  if (o.secure !== false) parts.push("Secure");     // 기본 Secure
  parts.push(`SameSite=${o.sameSite ?? "Lax"}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  headers.append("Set-Cookie", parts.join("; "));
}

/** Headers → plain object (lib.dom.iterable 없이도 동작) */
function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    // 여러 값이 올 수 있는 헤더도 마지막으로 덮어씀(쿠키는 Set-Cookie로 개별 처리)
    out[k] = v;
  });
  return out;
}

/** 캐시 차단 헤더 합성 */
function noStore(extra: Record<string, string> = {}): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

/* ───────────────────────────── handler ───────────────────────────── */
/**
 * 계약 유지:
 * - 라우트: GET /api/auth/oauth/facebook
 * - 메시지: { ok: true, message: "Provider redirect URL builder stub.", authorize }
 * 강화:
 * - state / (옵션)PKCE 생성 및 진단 쿠키 저장
 * - 보안 기본값(Secure/HttpOnly/SameSite=Lax)
 * - 처리시간 헤더
 */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    const clientId = (env.FACEBOOK_CLIENT_ID || "").trim();
    const redirectUri = (env.FACEBOOK_REDIRECT_URI || "").trim();
    const scope = (env.FACEBOOK_SCOPE || "public_profile,email").trim();

    if (!clientId || !redirectUri) {
      return withCORS(
        json({ error: "Facebook OAuth not configured" }, { status: 500 }),
        env.CORS_ORIGIN
      );
    }

    // ── state & (optional) PKCE ───────────────────────────────────────
    const state = randState(32);
    let codeChallenge: string | null = null;
    let codeVerifier: string | null = null;

    if (env.OAUTH_PKCE === "1") {
      // RFC 7636: code_verifier 43~128 chars (여기선 64바이트 난수 → 86자 b64url)
      codeVerifier = randState(64);
      codeChallenge = await sha256B64url(codeVerifier);
    }

    // ── 인가 URL 구성 ─────────────────────────────────────────────────
    const u = new URL(FB_AUTH_URL);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    if (scope) u.searchParams.set("scope", scope);
    // 재요청 시 퍼미션 재프롬프트가 필요하다면 아래 라인 활성화
    // u.searchParams.set("auth_type", "rerequest");
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }

    // ── 진단/콜백 검증용 쿠키 저장 (5분 TTL) ───────────────────────────
    const cookieHeaders = new Headers();
    setCookie(cookieHeaders, "oauth_state", state, {
      maxAge: 300,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    if (codeVerifier) {
      setCookie(cookieHeaders, "pkce_verifier", codeVerifier, {
        maxAge: 300,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      });
    }
    // 선택: 현재 프로바이더 힌트(프런트 편의용, HttpOnly 아님)
    setCookie(cookieHeaders, "oauth_provider", "facebook", {
      maxAge: 300,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });

    const took = Math.round(performance.now() - t0);

    // 기존 메시지를 유지하면서, 인가 URL을 추가 정보로 제공
    return withCORS(
      json(
        {
          ok: true,
          message: "Provider redirect URL builder stub.",
          authorize: u.toString(), // 프런트에서 이 URL로 리다이렉트
        },
        {
          headers: {
            ...noStore({ "X-OAuth-AuthURL-Took-ms": String(took) }),
            ...headersToObject(cookieHeaders), // ← iterable 이슈 없이 안전하게 병합
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: noStore() }
      ),
      env.CORS_ORIGIN
    );
  }
};
