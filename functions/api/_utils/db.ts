// functions/api/_utils/db.ts
/**
 * ✅ 목표
 * - 공개 계약 100% 유지
 *   export type Env
 *   export function getSql(env: Env)
 *   export async function dbHealth(env: Env)
 *
 * 🔧 보강 사항
 * - @neondatabase/serverless 의 **정적 import 제거** → 동적 import("@neondatabase/serverless")
 *   → Cloudflare Pages/Workers 번들에 안전하게 포함되면서도, 타입/에디터 에러 최소화
 * - **재시도 + 지수 백오프 + 타임아웃** 내장
 * - **URL 유효성 검사** 및 **민감정보 마스킹**
 * - **URL 단위 클라이언트 캐시**(프리뷰/프로덕션 동시 대응)
 * - **태그드 템플릿/일반 호출 둘 다** 지원하는 래퍼
 * - **간단 계측/디버그 상태** 도우미
 *
 * 📦 런타임 의존성(배포 환경에 설치 필요)
 *   npm i @neondatabase/serverless
 *
 * ⚠️ 주의
 * - 이 파일은 정적 import 를 사용하지 않습니다. (동적 import 로만 로드)
 * - Cloudflare Workers/Pages 에서 ESM 번들로 배포됩니다.
 */

/* ─────────────────────────────── 공개 타입 ─────────────────────────────── */
export type Env = {
  NEON_DATABASE_URL: string; // postgres:// or postgresql://
  CORS_ORIGIN: string;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUD?: string;
};

/* ─────────────────────────────── 튜너블 상수 ───────────────────────────── */
const DEFAULT_TIMEOUT_MS = 15_000; // 15s
const MAX_RETRIES = 3;             // 0번째 시도 + 3회 재시도 = 최대 4번
const BASE_BACKOFF_MS = 200;       // 200 → 400 → 800
const BACKOFF_FACTOR = 2;
const DEFAULT_HEALTH_SQL = "select 1";

/* ─────────────────────────────── 내부 상태 ─────────────────────────────── */
type NeonTagged = (...a: any[]) => Promise<any>;
type NeonFactory = (url: string) => NeonTagged;

const clientCache = new Map<string, ReturnType<typeof createLazyClient>>();
let _lastImportError: string | null = null;

/* ─────────────────────────────── 유틸 함수 ─────────────────────────────── */
function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    // neon pooler 는 호스트만 보여줘도 충분
    return `${u.protocol}//${u.username ? u.username + "@" : ""}${u.host}${u.pathname}`;
  } catch {
    return "invalid://***";
  }
}

function validateDbUrl(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("NEON_DATABASE_URL is empty");
  }
  const s = url.trim();
  if (!/^postgres(ql)?:\/\//i.test(s)) {
    throw new Error(
      `NEON_DATABASE_URL must start with postgres:// or postgresql:// (got: ${redactDbUrl(s)})`
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(s);
  } catch {
    throw new Error(`Invalid NEON_DATABASE_URL: ${redactDbUrl(s)}`);
  }
  return s;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientError(err: unknown): boolean {
  const m = String((err as any)?.message ?? err ?? "").toLowerCase();
  return (
    m.includes("fetch") ||
    m.includes("network") ||
    m.includes("timeout") ||
    m.includes("temporar") || // temporary
    m.includes("connection") ||
    m.includes("reset") ||
    m.includes("again") ||    // try again
    m.includes("503") ||
    m.includes("502") ||
    m.includes("429")
  );
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: any;
  const killer = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`DB query timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, killer]);
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────── 동적 로더 ──────────────────────────────── */
/**
 * 문자열 리터럴 specifier 로 동적 import → 번들러는 모듈을 포함시키고,
 * 설치가 안 되어 있으면 친절한 메시지로 에러를 던집니다.
 */
async function importNeonOrHint(): Promise<NeonFactory> {
  try {
    // ⚠️ 중요: **문자열 리터럴**로 바로 import 해야
    // Cloudflare/esbuild 번들에 @neondatabase/serverless 가 포함됩니다.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("@neondatabase/serverless");
    const neon: NeonFactory | undefined = mod?.neon ?? mod?.default?.neon;
    if (typeof neon !== "function") {
      throw new Error("neon export missing");
    }
    _lastImportError = null;
    return neon;
  } catch (e) {
    const detail = String((e as any)?.message ?? e);
    _lastImportError = detail;
    throw new Error(
      [
        "Neon driver not found (dynamic import failed).",
        "Install it in your project:",
        "  npm i @neondatabase/serverless",
        "If using Cloudflare Pages/Workers, keep ESM build.",
        `Details: ${detail}`,
      ].join("\n")
    );
  }
}

/* ─────────────────────────────── 계측 도우미 ───────────────────────────── */
type MeterContext = {
  start: number;
  lastError?: unknown;
  sqlPreview?: string;
};
function meterStart(): MeterContext {
  return { start: performance.now() };
}
function meterEnd(m: MeterContext) {
  const took = Math.round(performance.now() - m.start);
  return {
    took,
    ok: !m.lastError,
    error: m.lastError ? String((m.lastError as any).message ?? m.lastError) : undefined,
  };
}
function previewSqlArgs(args: any[]): string {
  // 태그드 템플릿이면 [strings, ...values]
  if (Array.isArray(args) && Array.isArray(args[0])) {
    const strings = args[0] as TemplateStringsArray | string[];
    const vals = args.slice(1);
    // 최대 1줄만 간단히
    let text = "";
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < vals.length) text += "$" + (i + 1);
    }
    return text.replace(/\s+/g, " ").slice(0, 160);
  }
  // 일반 호출(sql("select 1"))
  const t = String(args?.[0] ?? "");
  return t.replace(/\s+/g, " ").slice(0, 160);
}

/* ───────────────────────────── 복원력 래퍼 ────────────────────────────── */
/**
 * neon tagged template 함수를 프록시로 감싸 재시도/타임아웃을 적용합니다.
 * 반환값은 원형과 동일하게 Promise<any>.
 */
function wrapWithResilience<T extends (...a: any[]) => Promise<any>>(lazyClient: T): T {
  const invoke = async (args: any[]) => {
    const m = meterStart();
    m.sqlPreview = previewSqlArgs(args);

    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= MAX_RETRIES) {
      try {
        const out = await withTimeout(
          // @ts-ignore - 템플릿/일반 호출 모두 함수 apply로 처리
          lazyClient.apply(undefined, args),
          DEFAULT_TIMEOUT_MS
        );
        meterEnd(m); // ok
        return out;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_RETRIES || !isTransientError(err)) {
          m.lastError = err;
          meterEnd(m);
          break;
        }
        const backoff = BASE_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, attempt);
        await sleep(backoff);
        attempt++;
      }
    }
    throw lastErr;
  };

  // 함수 자체를 프록시로 감싸 호출 인터셉트
  const proxy = new Proxy(lazyClient as any, {
    apply(_target, _thisArg, args) {
      return invoke(args);
    },
  });

  return proxy as T;
}

/* ───────────────────────────── Lazy Client ───────────────────────────── */
function createLazyClient(url: string): (...a: any[]) => Promise<any> {
  let real: NeonTagged | null = null;

  const lazy: any = async function (...args: any[]) {
    if (!real) {
      const neon = await importNeonOrHint();
      real = neon(url);
    }
    // 템플릿/일반 호출 모두 지원
    // @ts-ignore
    return real.apply(undefined, args);
  };

  return wrapWithResilience(lazy);
}

/* ────────────────────────────── Public API ───────────────────────────── */
export function getSql(env: Env) {
  const url = validateDbUrl(env.NEON_DATABASE_URL);
  let client = clientCache.get(url);
  if (!client) {
    client = createLazyClient(url);
    clientCache.set(url, client);
  }
  return client!;
}

export async function dbHealth(
  env: Env
): Promise<{ ok: true; took_ms: number } | { ok: false; error: string; took_ms: number }> {
  const t0 = performance.now();
  try {
    const sql = getSql(env);
    await sql([DEFAULT_HEALTH_SQL]); // 템플릿이 아닌 일반 호출로도 수행 가능
    return { ok: true, took_ms: Math.round(performance.now() - t0) };
  } catch (e: any) {
    const msg = [
      String(e?.message ?? e),
      _lastImportError ? `(driver: ${_lastImportError})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { ok: false, error: msg, took_ms: Math.round(performance.now() - t0) };
  }
}

/* ────────────────────────────── 디버그 (비 export) ────────────────────── */
function _debugState() {
  return {
    cacheSize: clientCache.size,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: MAX_RETRIES,
    backoff: { base: BASE_BACKOFF_MS, factor: BACKOFF_FACTOR },
    lastImportError: _lastImportError,
    cachedUrls: Array.from(clientCache.keys()).map(redactDbUrl),
  };
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __db_debug__ = _debugState; // 필요 시 브레이크포인트에서 호출
