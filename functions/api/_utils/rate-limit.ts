// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\_utils\rate-limit.ts

// Hardened, dependency-free rate limiter for Cloudflare Workers/Pages.
// Public contract kept EXACTLY:
//   export async function allow(req: Request): Promise<boolean>

type Bucket = {
  tokens: number;      // 현재 남은 토큰
  lastRefill: number;  // 마지막 리필 시각(unixtime ms)
  limit: number;       // 버킷 용량(=분당 허용 수)
  windowMs: number;    // 윈도우(ms)
};

// ───────────────────── Tunables (서비스 정책에 맞게 조정) ─────────────────────
const DEFAULT_LIMIT_PER_MIN = 60;
const DEFAULT_WINDOW_MS = 60_000;

const ROUTE_LIMITS: Array<{ test: (p: string) => boolean; limit: number; windowMs?: number }> = [
  { test: (p) => p.startsWith("/api/auth/login"),   limit: 5 },      // 로그인 시도는 보수적
  { test: (p) => p.startsWith("/api/auth/signup"),  limit: 10 },     // 회원가입도 보수적
  { test: (p) => p.startsWith("/api/analytics/"),   limit: 120 },    // 이벤트 수집은 관대
  { test: (p) => p.startsWith("/api/games/score"),  limit: 90 },     // 게임 점수 제출
  // 기본값은 아래 DEFAULT_LIMIT_PER_MIN 적용
];

// 메모리 상한 관리: 오래된 버킷 정리 주기/기준
const GC_INTERVAL_MS = 2 * 60_000; // 2분마다
const BUCKET_IDLE_TTL_MS = 5 * 60_000; // 5분간 활동 없으면 버킷 폐기

// ───────────────────── 내부 상태(워커 인스턴스 범위) ─────────────────────
const buckets = new Map<string, Bucket>();
let lastGcAt = Date.now();

// ───────────────────── 유틸 ─────────────────────
function getLimitForPath(path: string): { limit: number; windowMs: number } {
  const rule = ROUTE_LIMITS.find((r) => r.test(path));
  return {
    limit: rule?.limit ?? DEFAULT_LIMIT_PER_MIN,
    windowMs: rule?.windowMs ?? DEFAULT_WINDOW_MS,
  };
}

function parseClientIp(req: Request): string | null {
  const h = req.headers;
  // Cloudflare 표준
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();

  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  const xr = h.get("x-real-ip");
  if (xr) return xr.trim();

  return null;
}

function getAuthToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function clientKey(req: Request): Promise<string> {
  // 1) 토큰이 있으면 토큰 해시로(동일 사용자가 다른 IP여도 동일 키)
  const token = getAuthToken(req);
  if (token) return `tok:${await sha256Hex(token)}`;

  // 2) IP 기반
  const ip = parseClientIp(req);
  if (ip) return `ip:${ip}`;

  // 3) 최후: UA + 경로 (정확도 낮음)
  const ua = (req.headers.get("user-agent") || "ua:unknown").slice(0, 200);
  try {
    const { pathname } = new URL(req.url);
    return `ua:${await sha256Hex(`${ua}#${pathname}`)}`;
  } catch {
    return `ua:${await sha256Hex(ua)}`;
  }
}

function refillAndConsume(bucket: Bucket, now: number): boolean {
  // 경과 시간만큼 토큰 리필 (선형)
  const ratePerMs = bucket.limit / bucket.windowMs; // 분당 limit → ms당 리필량
  if (now > bucket.lastRefill) {
    const refill = (now - bucket.lastRefill) * ratePerMs;
    bucket.tokens = Math.min(bucket.limit, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

function gcBuckets(now: number) {
  if (now - lastGcAt < GC_INTERVAL_MS) return;
  lastGcAt = now;
  for (const [key, b] of buckets) {
    // 활동 없는 버킷은 폐기
    if (now - b.lastRefill > BUCKET_IDLE_TTL_MS) buckets.delete(key);
  }
}

// ───────────────────── 공개 API (계약 유지) ─────────────────────
export async function allow(req: Request): Promise<boolean> {
  // CORS 프리플라이트/헬스체크 등은 우회(필요 시 정책 조정)
  if (req.method === "OPTIONS") return true;

  const now = Date.now();
  gcBuckets(now);

  let path = "/";
  try {
    path = new URL(req.url).pathname || "/";
  } catch {
    // URL 파싱 실패 시 기본값 사용
  }

  const { limit, windowMs } = getLimitForPath(path);
  const key = await clientKey(req);
  const bucketKey = `${limit}:${windowMs}:${key}`;

  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { tokens: limit, lastRefill: now, limit, windowMs };
    buckets.set(bucketKey, bucket);
  }

  return refillAndConsume(bucket, now);
}
