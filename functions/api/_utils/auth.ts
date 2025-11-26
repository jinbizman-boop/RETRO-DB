// functions/api/_utils/auth.ts
// Hardened JWT HS256 utilities for Cloudflare Workers (Edge)
// Fully upgraded for RETRO GAMES wallet/auth architecture, auth flows, and security
//
// - jwtSign / jwtVerify : 순수 HS256 JWT 유틸
// - parseBearer        : Authorization 헤더에서 Bearer 토큰 추출
// - requireUser        : JWT 검증 + 필수 sub(UUID) 보장
// - optionalUser       : 있으면 검증, 없으면 null
// - hasScope/requireScope : scope 기반 권한 체크
// - getUserIdFromPayload  : sub → userId 문자열 안전 추출
//
// Cloudflare Workers / Pages Functions 런타임 의존성만 사용 (Node 미사용)

/* ──────────────────────────────────────────────────────────────
 * Type Definitions
 * ────────────────────────────────────────────────────────────── */

export type JwtPayload = {
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string;
  jti?: string;              // unique token id
  scope?: string | string[]; // role/scope expansion ("user", "admin", ["user","wallet:write"], ...)
  [k: string]: any;
};

export type VerifyEnv = {
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUD?: string;
  JWT_CLOCK_SKEW_SEC?: string | number;
};

export type AuthEnv = {
  JWT_SECRET?: string;
} & Partial<VerifyEnv>;

/* ───────────────────────── Tunables / Defaults ───────────────────────── */

const MAX_TOKEN_LENGTH = 4096;      // abnormal long token protection
const DEFAULT_SKEW_SEC = 60;        // clock skew tolerance
const MIN_SECRET_LEN   = 16;        // secret length minimum

// optional sub-validator pattern (uuid v4, Neon users.id와 정합)
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ─────────────────────────── Base64URL Utils ─────────────────────────── */

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlEncodeString(s: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(s));
}

function base64urlDecodeToBytes(b64url: string): Uint8Array {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlDecodeToString(b64url: string): string {
  const bytes = base64urlDecodeToBytes(b64url);
  return new TextDecoder().decode(bytes);
}

/* ─────────────────────────── Crypto Helpers ──────────────────────────── */

async function importHmacKey(secret: string) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LEN) {
    throw new Error("JWT secret too short");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function hmacSignBytes(secret: string, data: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ───────────────────────────── Signing (HS256) ───────────────────────── */

export async function jwtSign(
  payload: JwtPayload,
  secret: string,
  header: Record<string, string> = {},
  opts?: {
    expiresIn?: number; // seconds
    iat?: number;       // force issuedAt
    issuer?: string;
    audience?: string;
    jti?: string;
  }
) {
  const now = typeof opts?.iat === "number" ? opts.iat : Math.floor(Date.now() / 1000);

  const fullPayload: JwtPayload = {
    iat: now,
    ...payload,
  };

  if (opts?.expiresIn && !fullPayload.exp) {
    fullPayload.exp = now + Math.max(1, Math.floor(opts.expiresIn));
  }
  if (opts?.issuer) fullPayload.iss = opts.issuer;
  if (opts?.audience) fullPayload.aud = opts.audience;
  if (opts?.jti) fullPayload.jti = opts.jti;

  const headerObj = {
    alg: "HS256",
    typ: "JWT",
    ...header,
  };

  const encHeader = base64urlEncodeString(JSON.stringify(headerObj));
  const encPayload = base64urlEncodeString(JSON.stringify(fullPayload));
  const data = `${encHeader}.${encPayload}`;

  const sig = await hmacSignBytes(secret, data);
  const encSig = base64urlEncodeBytes(sig);

  return `${data}.${encSig}`;
}

/* ───────────────────────────── Verification ──────────────────────────── */

export type VerifyOpts = {
  issuer?: string;
  audience?: string;
  clockSkewSec?: number;
  requireSub?: boolean;
  requireUUIDSub?: boolean; // 강화된 sub 검증
  allowedIssuers?: string[];
  allowedAudiences?: string[];
};

export async function jwtVerify(
  token: string,
  secret: string,
  opts?: VerifyOpts
): Promise<JwtPayload> {
  if (typeof token !== "string" || token.length === 0)
    throw new Error("Invalid token");
  if (token.length > MAX_TOKEN_LENGTH)
    throw new Error("Token too long");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token");

  const [h, p, s] = parts;

  let headerObj: any;
  let payload: any;

  try {
    headerObj = JSON.parse(base64urlDecodeToString(h));
  } catch {
    throw new Error("Invalid header encoding");
  }

  try {
    payload = JSON.parse(base64urlDecodeToString(p));
  } catch {
    throw new Error("Invalid payload encoding");
  }

  // alg / typ strict check
  if (!headerObj || headerObj.alg !== "HS256" || headerObj.typ !== "JWT") {
    throw new Error("Unsupported JWT header");
  }

  // signature verification
  const data = `${h}.${p}`;
  const expected = await hmacSignBytes(secret, data);

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64urlDecodeToBytes(s);
  } catch {
    throw new Error("Invalid signature encoding");
  }

  if (!timingSafeEqual(expected, sigBytes)) {
    throw new Error("Invalid signature");
  }

  // Time & claims check
  const now = Math.floor(Date.now() / 1000);
  const skew = Math.max(
    0,
    Math.floor(opts?.clockSkewSec ?? DEFAULT_SKEW_SEC)
  );

  if (typeof payload.nbf === "number" && now + skew < payload.nbf) {
    throw new Error("Token not yet valid");
  }
  if (typeof payload.exp === "number" && now - skew > payload.exp) {
    throw new Error("Token expired");
  }

  // issuer validation
  if (opts?.issuer && payload.iss !== opts.issuer) {
    throw new Error("Invalid issuer");
  }
  if (opts?.allowedIssuers?.length && !opts.allowedIssuers.includes(payload.iss)) {
    throw new Error("Issuer not allowed");
  }

  // audience validation
  if (opts?.audience && payload.aud !== opts.audience) {
    throw new Error("Invalid audience");
  }
  if (opts?.allowedAudiences?.length && !opts.allowedAudiences.includes(payload.aud)) {
    throw new Error("Audience not allowed");
  }

  // sub validation
  if (opts?.requireSub && !payload.sub) {
    throw new Error("Token missing sub");
  }
  if (opts?.requireUUIDSub && payload.sub && !UUID_V4_REGEX.test(payload.sub)) {
    throw new Error("Invalid sub format");
  }

  return payload;
}

/* ────────────────────────── Bearer Helpers ──────────────────────────── */

export function parseBearer(req: Request): string | null {
  const auth =
    req.headers.get("Authorization") ||
    req.headers.get("authorization");
  if (!auth) return null;

  // allow unicode safe match
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_\-~+/=.+]+)$/i);
  return m ? m[1] : null;
}

/* ─────────────────────── Scope / Role Utilities ─────────────────────── */

function normalizeScopes(scope: string | string[] | undefined | null): string[] {
  if (!scope) return [];
  if (Array.isArray(scope)) {
    return scope
      .map((s) => String(s || "").trim())
      .filter((s) => s.length > 0);
  }
  return String(scope)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * hasScope(payload, required)
 *  - payload.scope 에 required 가 포함되어 있는지 검사
 *  - required 가 배열이면 OR 조건 (하나라도 있으면 true)
 */
export function hasScope(
  payload: JwtPayload,
  required: string | string[]
): boolean {
  const owned = new Set(normalizeScopes(payload.scope));
  if (!owned.size) return false;

  const requiredList = Array.isArray(required) ? required : [required];
  for (const r of requiredList) {
    const key = r.trim();
    if (!key) continue;
    if (owned.has(key)) return true;
  }
  return false;
}

/**
 * requireScope(payload, required)
 *  - hasScope 가 false 면 에러 발생
 *  - API 핸들러에서 권한 체크에 사용
 */
export function requireScope(
  payload: JwtPayload,
  required: string | string[]
): void {
  if (!hasScope(payload, required)) {
    throw new Error("insufficient_scope");
  }
}

/* ─────────────────────── UserId Helper ─────────────────────── */

/**
 * getUserIdFromPayload(payload)
 *  - payload.sub 를 안전하게 텍스트 userId 로 가져오는 헬퍼
 *  - 비어있다면 에러를 던져 requireUser 와 동작을 맞춤
 */
export function getUserIdFromPayload(payload: JwtPayload): string {
  const sub = (payload.sub ?? "").toString().trim();
  if (!sub) throw new Error("Token missing sub");
  return sub;
}

/* ──────────────────────────── Policy Wrapper ─────────────────────────── */

/**
 * 내부용: env 에서 JWT_SECRET 추출 + 기본 검증
 */
function resolveJwtSecret(env: AuthEnv): string {
  if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
    throw new Error("JWT_SECRET not set");
  }
  if (env.JWT_SECRET.length < MIN_SECRET_LEN) {
    throw new Error("JWT_SECRET too short");
  }
  return env.JWT_SECRET;
}

/**
 * requireUser(req, env)
 *   - Validates JWT
 *   - Requires sub (userId, UUIDv4)
 *   - Matches issuer/audience if provided
 *   - Returns decoded payload
 *
 * 사용 예시:
 *   const payload = await requireUser(request, env);
 *   const userId = getUserIdFromPayload(payload);
 */
export async function requireUser(
  req: Request,
  env: AuthEnv
): Promise<JwtPayload> {
  const secret = resolveJwtSecret(env);

  const token = parseBearer(req);
  if (!token) throw new Error("Missing bearer token");

  const clockSkew =
    typeof env.JWT_CLOCK_SKEW_SEC === "string"
      ? Number(env.JWT_CLOCK_SKEW_SEC)
      : (env.JWT_CLOCK_SKEW_SEC ?? undefined);

  const payload = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUD,
    clockSkewSec:
      typeof clockSkew === "number" && Number.isFinite(clockSkew)
        ? clockSkew
        : undefined,
    requireSub: true,
    requireUUIDSub: true, // 강화: userId(sub)는 uuid여야 한다 (Neon users.id와 정합)
    allowedIssuers: env.JWT_ISSUER ? [env.JWT_ISSUER] : undefined,
    allowedAudiences: env.JWT_AUD ? [env.JWT_AUD] : undefined,
  });

  return payload;
}

/**
 * optionalUser(req, env)
 *   - Authorization 헤더가 없으면 null 반환
 *   - 있으면 requireUser 와 동일하게 검증
 *   - 공용(로그인/비로그인 혼합) 엔드포인트에서 사용
 */
export async function optionalUser(
  req: Request,
  env: AuthEnv
): Promise<JwtPayload | null> {
  const token = parseBearer(req);
  if (!token) return null;

  const secret = resolveJwtSecret(env);

  const clockSkew =
    typeof env.JWT_CLOCK_SKEW_SEC === "string"
      ? Number(env.JWT_CLOCK_SKEW_SEC)
      : (env.JWT_CLOCK_SKEW_SEC ?? undefined);

  const payload = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUD,
    clockSkewSec:
      typeof clockSkew === "number" && Number.isFinite(clockSkew)
        ? clockSkew
        : undefined,
    requireSub: true,
    requireUUIDSub: true,
    allowedIssuers: env.JWT_ISSUER ? [env.JWT_ISSUER] : undefined,
    allowedAudiences: env.JWT_AUD ? [env.JWT_AUD] : undefined,
  });

  return payload;
}
