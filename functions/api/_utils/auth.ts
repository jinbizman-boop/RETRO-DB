// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\auth.ts

// Minimal (but hardened) JWT HS256 utilities for Cloudflare Workers (Edge)
export type JwtPayload = {
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  aud?: string;
  [k: string]: any;
};

// ───────────────────────── Tunables / Defaults ─────────────────────────
const MAX_TOKEN_LENGTH = 4096;      // 비정상적으로 긴 토큰 차단
const DEFAULT_SKEW_SEC = 60;        // clock skew 허용(초)
const MIN_SECRET_LEN   = 16;        // 너무 짧은 시크릿 차단

// ─────────────────────────── Base64URL Utils ───────────────────────────
function base64urlEncodeBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  // btoa는 ASCII만 처리(헤더/페이로드는 ASCII JSON이므로 OK)
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlEncodeString(s: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(s));
}

function base64urlDecodeToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlDecodeToString(b64url: string): string {
  const bytes = base64urlDecodeToBytes(b64url);
  return new TextDecoder().decode(bytes);
}

// ─────────────────────────── Crypto Helpers ────────────────────────────
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
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ───────────────────────────── Signing (HS256) ─────────────────────────
export async function jwtSign(
  payload: JwtPayload,
  secret: string,
  header: Record<string, string> = {},
  opts?: { /** 만료(초) */ expiresIn?: number; /** 발급 시각 강제 */ iat?: number }
) {
  const now = typeof opts?.iat === "number" ? opts!.iat : Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { iat: now, ...payload };

  if (typeof opts?.expiresIn === "number" && !fullPayload.exp) {
    fullPayload.exp = now + Math.max(1, Math.floor(opts.expiresIn));
  }

  const headerObj = { alg: "HS256", typ: "JWT", ...header };
  const encHeader = base64urlEncodeString(JSON.stringify(headerObj));
  const encPayload = base64urlEncodeString(JSON.stringify(fullPayload));
  const data = `${encHeader}.${encPayload}`;

  const sig = await hmacSignBytes(secret, data);
  const encSig = base64urlEncodeBytes(sig);
  return `${data}.${encSig}`;
}

// ───────────────────────────── Verification ────────────────────────────
type VerifyEnv = {
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUD?: string;
  JWT_CLOCK_SKEW_SEC?: string | number; // 선택: 문자열로 주입되는 경우 고려
};

export async function jwtVerify(
  token: string,
  secret: string,
  opts?: {
    /** 허용 발행자(iss) */
    issuer?: string;
    /** 허용 수신자(aud) */
    audience?: string;
    /** 허용 clock skew (sec) */
    clockSkewSec?: number;
    /** sub 필수 여부 */
    requireSub?: boolean;
  }
): Promise<JwtPayload> {
  if (typeof token !== "string" || token.length === 0) throw new Error("Invalid token");
  if (token.length > MAX_TOKEN_LENGTH) throw new Error("Token too long");

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

  // alg/typ 엄격 검사
  if (!headerObj || headerObj.alg !== "HS256" || headerObj.typ !== "JWT") {
    throw new Error("Unsupported JWT header");
  }

  // 서명 검증 (타이밍 안전 비교)
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

  // 클레임 검증 (시간/iss/aud/sub 등)
  const now = Math.floor(Date.now() / 1000);
  const skew = Math.max(
    0,
    Math.floor(
      opts?.clockSkewSec ??
        DEFAULT_SKEW_SEC
    )
  );

  if (typeof payload.nbf === "number" && now + skew < payload.nbf) {
    throw new Error("Token not yet valid");
  }
  if (typeof payload.exp === "number" && now - skew > payload.exp) {
    throw new Error("Token expired");
  }
  if (opts?.issuer && payload.iss !== opts.issuer) {
    throw new Error("Invalid issuer");
  }
  if (opts?.audience && payload.aud !== opts.audience) {
    throw new Error("Invalid audience");
  }
  if (opts?.requireSub && !payload.sub) {
    throw new Error("Token missing sub");
  }

  return payload as JwtPayload;
}

// ────────────────────────── Bearer Helpers ────────────────────────────
export function parseBearer(req: Request): string | null {
  const auth = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_\-~+/=.+]+)$/i);
  return m ? m[1] : null;
}

// ──────────────────────────── Policy Wrapper ───────────────────────────
/**
 * 기존 계약 유지: requireUser(req, env)
 * - env.JWT_SECRET 필수
 * - env.JWT_ISSUER / env.JWT_AUD / env.JWT_CLOCK_SKEW_SEC 있으면 자동 검증
 * - sub 필수
 */
export async function requireUser(
  req: Request,
  env: { JWT_SECRET?: string } & Partial<VerifyEnv>
) {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET not set");

  const token = parseBearer(req);
  if (!token) throw new Error("Missing bearer token");

  const clockSkew =
    typeof env.JWT_CLOCK_SKEW_SEC === "string"
      ? Number(env.JWT_CLOCK_SKEW_SEC)
      : (env.JWT_CLOCK_SKEW_SEC ?? undefined);

  const payload = await jwtVerify(token, env.JWT_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUD,
    clockSkewSec: typeof clockSkew === "number" && Number.isFinite(clockSkew) ? clockSkew : undefined,
    requireSub: true
  });

  return payload;
}
