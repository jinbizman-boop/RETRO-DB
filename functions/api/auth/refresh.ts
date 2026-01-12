// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\refresh.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { type Env } from "../_utils/db";
import { parseBearer, jwtSign, jwtVerify } from "../_utils/auth";
import * as Rate from "../_utils/rate-limit";

/**
 * 에디터 오류 해결 메모
 * - ts(2304) PagesFunction 미정의 → 아래에 최소 ambient 타입 선언
 * - ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
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

function isAuthErrorMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("invalid token") ||
    m.includes("invalid signature") ||
    m.includes("token expired") ||
    m.includes("expired") ||
    m.includes("missing bearer") ||
    m.includes("missing token") ||
    m.includes("unsupported jwt header") ||
    m.includes("jwt secret too short")
  );
}

export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // 과도한 재발급 시도 방지
  if (!(await Rate.allow(request))) {
    return withCORS(
      json({ error: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "60" } }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    if (!env.JWT_SECRET) throw new Error("JWT_SECRET not set");

    let token = parseBearer(request);

    // ✅ Bearer 가 없으면 Cookie(rg_jwt_token)에서 보강
    if (!token) {
      const cookie =
        request.headers.get("Cookie") ||
        request.headers.get("cookie") ||
        "";
      const m = cookie.match(/(?:^|;\s*)rg_jwt_token=([^;]+)/);
      if (m && m[1]) {
        try {
          token = decodeURIComponent(m[1]);
        } catch (_e) {}
      }
    }

    if (!token) throw new Error("Missing token");

    // 발급 시와 동일한 정책으로 엄격 검증(iss/aud/sub)
    const payload = await jwtVerify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUD,
      requireSub: true,
    });

    // 안전한 클레임만 패스스루(역호환 & 최소 권한)
    const passthrough: Record<string, unknown> = {};
    for (const k of ["role", "scope", "permissions"]) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) {
        passthrough[k] = (payload as any)[k];
      }
    }

    // 새 토큰(12시간). 기존 계약 유지: iss/aud 그대로 사용
    const fresh = await jwtSign(
      {
        sub: payload.sub,
        iss: env.JWT_ISSUER,
        aud: env.JWT_AUD,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
        ...passthrough,
      },
      env.JWT_SECRET
    );

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true, token: fresh },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Refresh-Took-ms": String(took),

            // ✅ refresh로 재발급된 토큰도 Cookie 갱신
            "Set-Cookie": `rg_jwt_token=${encodeURIComponent(fresh)}; Path=/; Max-Age=43200; Secure; SameSite=Lax`,
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    const msg = String(e?.message || e);
    const status = isAuthErrorMessage(msg) ? 401 : 400;
    return withCORS(
      json({ error: msg }, { status, headers: { "Cache-Control": "no-store" } }),
      env.CORS_ORIGIN
    );
  }
};
