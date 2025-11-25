// functions/api/_utils/auth.ts
// Hardened JWT HS256 utilities for Cloudflare Workers (Edge)
// Fully upgraded for RETRO GAMES wallet-C architecture, auth flows, and security

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
  jti?: string;             // unique token id
  scope?: string | string[]; // role/scope expansion
  [k: string]: any;
};

/* ───────────────────────── Tunables / Defaults ───────────────────────── */

const MAX_TOKEN_LENGTH = 4096;      // abnormal long token protection
const DEFAULT_SKEW_SEC = 60;        // clock skew tolerance
const MIN_SECRET_LEN   = 16;        // secret length minimum

// optional sub-validator pattern (uuid v4)
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

type VerifyOpts = {
  issuer?: string;
  audience?: string;
  clockSkewSec?: number;
  requireSub?: boolean;
  requireUUIDSub?: boolean; // 강화된 sub 검증
  allowedIssuers?: string[];
  allowedAudiences?: string[];
};

type VerifyEnv = {
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUD?: string;
  JWT_CLOCK_SKEW_SEC?: string | number;
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

/* ──────────────────────────── Policy Wrapper ─────────────────────────── */

/**
 * requireUser(req, env)
 *   - Validates JWT
 *   - Requires sub (userId)
 *   - Matches issuer/audience if provided
 *   - Returns decoded payload
 */
export async function requireUser(
  req: Request,
  env: { JWT_SECRET?: string } & Partial<VerifyEnv>
): Promise<JwtPayload> {
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
    clockSkewSec: typeof clockSkew === "number" && Number.isFinite(clockSkew)
      ? clockSkew
      : undefined,
    requireSub: true,
    requireUUIDSub: true, // 강화: userId(sub)는 uuid여야 한다
    allowedIssuers: env.JWT_ISSUER ? [env.JWT_ISSUER] : undefined,
    allowedAudiences: env.JWT_AUD ? [env.JWT_AUD] : undefined,
  });

  return payload;
}
