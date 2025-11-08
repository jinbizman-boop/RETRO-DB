// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\oauth\callback.ts

import { json } from "../../_utils/json";
import { withCORS, preflight } from "../../_utils/cors";

/**
 * 문제 증상 (VS Code / tsserver)
 * - ts(2304): `PagesFunction` 타입을 찾지 못함
 * - ts(7031): 구조 분해 매개변수(request/env)가 암시적 any
 *
 * 해결 전략 (계약/기능 100% 유지)
 * - 본 파일 내부에 Cloudflare Pages용 **최소 ambient 타입**을 선언해 에디터 오류 제거
 * - onRequest 인자의 타입을 명시
 * - 런타임 로직/응답 스키마/라우팅은 변경 없이 그대로 유지
 */

/* ────────────────── Minimal Cloudflare Pages ambient types ────────────────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ──────────────────────────────────────────────────────────────────────────── */

type Env = { CORS_ORIGIN: string };

/* ───────────────────────────── 쿠키 & 유틸 ───────────────────────────── */

/**
 * 간단한 쿠키 파서(의존성 0)
 * - 다중 세미콜론 구분
 * - 값은 decodeURIComponent 시도 후 실패 시 원문 사용
 * - 공백 트리밍
 */
function parseCookies(req: Request): Record<string, string> {
  const h = req.headers.get("cookie") || req.headers.get("Cookie");
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const part of h.split(";")) {
    const [k, ...rest] = part.split("=");
    if (!k) continue;
    const key = k.trim();
    const val = rest.join("=").trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

/**
 * 안전한 문자열 정리(제어문자 제거 + 길이 상한)
 * - 타입이 string이 아니면 null
 * - 제어문자(0x00–0x1F, 0x7F) 제거
 * - 트리밍 후 빈 문자열이면 null
 * - 길이 초과 시 말줄임표 추가
 */
function clean(s: unknown, max = 2048): string | null {
  if (typeof s !== "string") return null;
  const v = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max) + "…" : v;
}

/**
 * 요청 URL 경로에서 공급자(provider) 추출
 * - 예상 경로: /api/auth/oauth/<provider>/callback
 * - 일반적인 키(google/kakao/facebook/github/naver)는 화이트리스트로 한 번 더 제한
 * - 그 외 커스텀 프로바이더도 허용
 */
function providerFromPath(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "oauth");
    if (i >= 0 && parts[i + 1]) {
      const p = parts[i + 1].toLowerCase();
      if (["google", "kakao", "facebook", "github", "naver"].includes(p)) return p;
      return p;
    }
  } catch {
    /* noop */
  }
  return null;
}

/**
 * no-store 헤더 합성 도우미
 * - 각 응답에 캐시 차단을 일관되게 부여
 */
function headerNoStore(extra: Record<string, string> = {}): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

/* ───────────────────────────── 핸들러 ───────────────────────────── */
/**
 * 계약 유지:
 * - 라우트/메서드: GET /api/auth/oauth/:provider/callback
 * - 기존 스텁 메시지/구조 유지: { ok: true, message: "OAuth callback stub.", received: {...} }
 * 보강:
 * - 상태(state)/PKCE 쿠키를 정리해서 진단 정보로 제공(강제 검증 실패는 하지 않음)
 * - Cloudflare 헤더/메타를 안전하게 수집
 * - 처리시간/X-헤더, no-store 헤더
 */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);
    const q = url.searchParams;

    // 표준 OAuth 파라미터 수집
    const code = clean(q.get("code"));
    const state = clean(q.get("state"));
    const error = clean(q.get("error"));
    const errorDesc = clean(q.get("error_description"), 4096);
    const provider = providerFromPath(request.url);

    // 쿠키 기반 state/PKCE 점검(있으면 비교만 수행; 강제 실패는 하지 않음 — 스텁 유지)
    const cookies = parseCookies(request);
    const cookieState = clean(cookies["oauth_state"]);
    const pkce = clean(cookies["pkce_verifier"], 4096);
    const stateOk = state && cookieState ? state === cookieState : null;

    // 진단 메타(Cloudflare 헤더/Request.cf)
    const h = request.headers;
    const diag = {
      provider,
      // 민감정보 노출을 피하기 위해 존재 여부/길이만 표기
      code_received: Boolean(code),
      code_len: code ? code.length : 0,
      state_received: Boolean(state),
      state_cookie_present: Boolean(cookieState),
      state_ok: stateOk,
      pkce_present: Boolean(pkce),
      oauth_error: error || null,
      oauth_error_description: errorDesc || null,
      request_id: h.get("cf-ray") || null,
      colo: (request as any)?.cf?.colo ?? null,              // 데이터센터 코드(예: ICN, NRT)
      ip: h.get("cf-connecting-ip") || null,
      country: h.get("cf-ipcountry") || null,
      ua: h.get("user-agent") || null,
      ts: Date.now(),
    };

    /**
     * 여기서부터 실제 토큰 교환/유저 생성 로직을 붙이면 됩니다.
     *
     * 1) 프로바이더 토큰 엔드포인트로 `code`(+ PKCE code_verifier) 교환
     * 2) `id_token` 또는 `userinfo`로 사용자 식별(sub/email 등)
     * 3) Users 테이블 upsert → 세션/JWT 발급 → 프런트 리다이렉트
     *
     * 현재 파일은 계약/스텁을 유지해야 하므로 실제 교환을 수행하지 않습니다.
     */

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        {
          ok: true,
          message: "OAuth callback stub.",
          // 확장 진단 필드(클라이언트/운영에서 문제 파악에 유용)
          received: diag,
        },
        { headers: headerNoStore({ "X-OAuth-Took-ms": String(took) }) }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: headerNoStore() }
      ),
      env.CORS_ORIGIN
    );
  }
};
