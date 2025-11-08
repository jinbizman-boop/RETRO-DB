// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\oauth\kakao.ts

import { json } from "../../_utils/json";
import { withCORS, preflight } from "../../_utils/cors";

/**
 * 문제 증상
 * - ts(2304): `PagesFunction` 타입 미정의
 * - ts(7031): 구조 분해 매개변수(request/env) 암시적 any
 * - ts(2769): `Object.fromEntries(headers)`에서 Headers가 iterable 아님(lib.dom.iterable 미설정)
 *
 * 해결
 * - 파일 내부에 Cloudflare Pages용 **최소 ambient 타입** 선언
 * - onRequest 인자 타입 명시
 * - Headers 병합은 `headersToObject(headers)`로 안전 변환 후 스프레드
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
  KAKAO_REST_API_KEY?: string;   // Kakao client_id
  KAKAO_REDIRECT_URI?: string;
  KAKAO_SCOPE?: string;          // e.g., "profile_nickname,account_email"
  KAKAO_PROMPT?: string;         // e.g., "login"
  OAUTH_PKCE?: string;           // "1" to enable PKCE
};

const KAKAO_AUTH_URL = "https://kauth.kakao.com/oauth/authorize";

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

/** 보안 기본값으로 쿠키 설정 */
function setCookie(
  headers: Headers,
  name: string,
  value: string,
  opts?: Partial<{
    path: string; maxAge: number; httpOnly: boolean; secure: boolean;
    sameSite: "Lax" | "Strict" | "None"; domain: string;
  }>
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const o = opts || {};
  parts.push(`Path=${o.path ?? "/"}`);
  if (typeof o.maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.httpOnly !== false) parts.push("HttpOnly");
  if (o.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${o.sameSite ?? "Lax"}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  headers.append("Set-Cookie", parts.join("; "));
}

/** Headers → plain object (lib.dom.iterable 없이도 동작) */
function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

/** 캐시 차단 헤더 합성 */
function noStore(extra: Record<string, string> = {}): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

/* ───────────────────────────── handler ───────────────────────────── */
/**
 * 계약 유지:
 * - 라우트: GET /api/auth/oauth/kakao
 * - 메시지: { ok: true, message: "Provider redirect URL builder stub.", authorize }
 * 강화:
 * - state / (옵션)PKCE 생성 및 진단 쿠키 저장
 * - prompt/scope 등 환경변수 기반 확장
 * - 처리시간 헤더 및 no-store
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
    const clientId   = (env.KAKAO_REST_API_KEY || "").trim();
    const redirectUri= (env.KAKAO_REDIRECT_URI || "").trim();
    const scope      = (env.KAKAO_SCOPE || "profile_nickname,account_email").trim();
    const prompt     = (env.KAKAO_PROMPT || "").trim(); // 선택: 강제 로그인 등

    if (!clientId || !redirectUri) {
      return withCORS(
        json({ error: "Kakao OAuth not configured" }, { status: 500 }),
        env.CORS_ORIGIN
      );
    }

    // ── state 및 (옵션)PKCE 생성 ─────────────────────────────────────
    const state = randState(32);
    let codeChallenge: string | null = null;
    let codeVerifier : string | null = null;

    if (env.OAUTH_PKCE === "1") {
      // RFC 7636: 43~128자 → 64바이트 난수 사용
      codeVerifier  = randState(64);
      codeChallenge = await sha256B64url(codeVerifier);
    }

    // ── 인가 URL 구성 ────────────────────────────────────────────────
    const u = new URL(KAKAO_AUTH_URL);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    if (scope)  u.searchParams.set("scope", scope);
    if (prompt) u.searchParams.set("prompt", prompt);
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }

    // ── 콜백 검증용 쿠키 저장(5분 TTL) ───────────────────────────────
    const cookieHeaders = new Headers();
    setCookie(cookieHeaders, "oauth_state", state, {
      maxAge: 300, path: "/", httpOnly: true, secure: true, sameSite: "Lax",
    });
    if (codeVerifier) {
      setCookie(cookieHeaders, "pkce_verifier", codeVerifier, {
        maxAge: 300, path: "/", httpOnly: true, secure: true, sameSite: "Lax",
      });
    }
    // 프런트가 현재 프로바이더를 인지할 수 있도록(진단용, HttpOnly 아님)
    setCookie(cookieHeaders, "oauth_provider", "kakao", {
      maxAge: 300, path: "/", httpOnly: false, secure: true, sameSite: "Lax",
    });

    const took = Math.round(performance.now() - t0);

    // 기존 메시지를 유지하면서 authorize URL 추가 제공
    return withCORS(
      json(
        {
          ok: true,
          message: "Provider redirect URL builder stub.",
          authorize: u.toString(),
        },
        {
          headers: {
            ...noStore({ "X-OAuth-AuthURL-Took-ms": String(took) }),
            ...headersToObject(cookieHeaders), // ← iterable 문제 없이 안전 병합
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
