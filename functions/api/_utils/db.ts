// functions/api/_utils/db.ts
// ─────────────────────────────────────────────────────────────────────────────
// Neon(Postgres) 연결 유틸
//
// ✅ 공개 계약(외부에서 사용하는 API)은 반드시 유지
//   - export type Env
//   - export function getSql(env: Env)
//   - export async function dbHealth(env: Env)
//
// 🔧 내부적으로 보강된 기능
//   - @neondatabase/serverless 동적 import (정적 import 없음)
//   - URL 유효성 검사 + 민감 정보 마스킹
//   - URL 단위 클라이언트 캐시 (프리뷰/프로덕션 공통)
//   - 재시도 + 지수 백오프 + 타임아웃
//   - 태그드 템플릿 / 일반 함수 호출 둘 다 지원
//   - 간단 계측/디버그 도우미
//   - dbHealth() 가 *단순 텍스트 쿼리* 만 사용하도록 교정
//     → "bind message supplies N parameters…" 류 오류 방지
//
// 📦 런타임 의존성
//   npm i @neondatabase/serverless
//
// ⚠️ 주의
//   - 이 파일 안에서는 정적 import 를 사용하지 않는다.
//   - Cloudflare Pages/Workers 의 ESM 번들 환경을 기준으로 작성됨.
// ─────────────────────────────────────────────────────────────────────────────

/* ─────────────────────────────── 공개 타입 ─────────────────────────────── */

export type Env = {
  NEON_DATABASE_URL: string;      // postgres:// 또는 postgresql://
  CORS_ORIGIN: string;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUD?: string;
  // 확장 가능: 다른 ENV 를 추가해도 이 파일에서는 사용하지 않으면 무시됨
};

/* ─────────────────────────────── 튜너블 상수 ───────────────────────────── */

const DEFAULT_TIMEOUT_MS = 15_000;   // 쿼리 1회 최대 15초
const MAX_RETRIES = 3;               // 최초 시도 + 3회 재시도 = 최대 4번
const BASE_BACKOFF_MS = 200;         // 200 → 400 → 800 → 1600
const BACKOFF_FACTOR = 2;
const DEFAULT_HEALTH_SQL = "select 1"; // 헬스 체크용 쿼리 (매우 가벼운 것 사용)

/* ─────────────────────────────── 내부 타입/상태 ─────────────────────────── */

type NeonTagged = (...a: any[]) => Promise<any>;
type NeonFactory = (url: string) => NeonTagged;

type LazyClient = (...a: any[]) => Promise<any>;

const clientCache = new Map<string, LazyClient>();
let _lastImportError: string | null = null;

/* ─────────────────────────────── 유틸 함수 ─────────────────────────────── */

/**
 * DB URL 에서 비밀번호만 *** 로 가리고 나머지는 그대로 노출.
 * (로그/에러 메시지에서 사용)
 */
function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return `${u.protocol}//${u.username ? u.username + "@" : ""}${u.host}${u.pathname}`;
  } catch {
    return "invalid://***";
  }
}

/**
 * Env 에 들어 있는 NEON_DATABASE_URL 이 정상적인지 1차 검증.
 * - 비어 있으면 에러
 * - postgres:// 또는 postgresql:// 로 시작하는지 확인
 * - URL 파싱이 가능한지 확인
 */
function validateDbUrl(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("NEON_DATABASE_URL is empty");
  }
  const s = url.trim();

  if (!/^postgres(ql)?:\/\//i.test(s)) {
    throw new Error(
      `NEON_DATABASE_URL must start with postgres:// or postgresql:// (got: ${redactDbUrl(
        s
      )})`
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 재시도해볼 만한 "일시적인" 오류인지 간단히 판별.
 * - 네트워크/타임아웃/연결 오류 등
 */
function isTransientError(err: unknown): boolean {
  const m = String((err as any)?.message ?? err ?? "").toLowerCase();

  return (
    m.includes("fetch") ||
    m.includes("network") ||
    m.includes("timeout") ||
    m.includes("temporar") || // temporary
    m.includes("connection") ||
    m.includes("reset") ||
    m.includes("again") || // try again
    m.includes("503") ||
    m.includes("502") ||
    m.includes("429")
  );
}

/**
 * Promise 에 타임아웃을 건 래퍼.
 */
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
 * @neondatabase/serverless 를 동적으로 import.
 * - 문자열 리터럴 specifier 를 사용해야 번들러가 모듈을 포함해 준다.
 * - 설치가 안 돼 있으면 "npm i @neondatabase/serverless" 안내 메시지와 함께 에러.
 */
async function importNeonOrHint(): Promise<NeonFactory> {
  try {
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
        "If using Cloudflare Pages/Workers, deploy as ESM.",
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
    sql: m.sqlPreview,
  };
}

/**
 * 쿼리 미리 보기를 한 줄짜리 텍스트로 변환.
 * - 태그드 템플릿: `sql\`select * from users where id = \${id}\``
 * - 일반 호출:     `sql("select 1")`
 *
 * 실제 값은 $1, $2 로 치환해서 로그에 민감 정보가 노출되지 않도록 한다.
 */
function previewSqlArgs(args: any[]): string {
  if (Array.isArray(args) && Array.isArray(args[0])) {
    const strings = args[0] as TemplateStringsArray | string[];
    const vals = args.slice(1);

    let text = "";
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < vals.length) text += `$${i + 1}`;
    }

    return text.replace(/\s+/g, " ").slice(0, 160);
  }

  const t = String(args?.[0] ?? "");
  return t.replace(/\s+/g, " ").slice(0, 160);
}

/* ───────────────────────────── 복원력 래퍼 ────────────────────────────── */
/**
 * Neon tagged template 함수를 Proxy 로 감싸서
 * - 재시도
 * - 지수 백오프
 * - 타임아웃
 * 을 적용한다.
 *
 * 사용법(외부에서는 기존과 동일):
 *   const sql = getSql(env);
 *   await sql`select * from users where id = ${id}`;
 *   await sql("select 1");
 */
function wrapWithResilience<T extends (...a: any[]) => Promise<any>>(lazyClient: T): T {
  const invoke = async (args: any[]) => {
    const meter = meterStart();
    meter.sqlPreview = previewSqlArgs(args);

    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= MAX_RETRIES) {
      try {
        const result = await withTimeout(
          // 템플릿/일반 호출 모두 apply 로 통일해서 호출
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          lazyClient.apply(undefined, args),
          DEFAULT_TIMEOUT_MS
        );

        meterEnd(meter); // 성공
        return result;
      } catch (err) {
        lastErr = err;

        // 재시도 한계를 넘겼거나, 일시적 오류로 보이지 않으면 그대로 실패
        if (attempt === MAX_RETRIES || !isTransientError(err)) {
          meter.lastError = err;
          meterEnd(meter);
          break;
        }

        const backoff = BASE_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, attempt);
        await sleep(backoff);
        attempt++;
      }
    }

    throw lastErr;
  };

  const proxy = new Proxy(lazyClient as any, {
    apply(_target, _thisArg, args) {
      return invoke(args);
    },
  });

  return proxy as T;
}

/* ───────────────────────────── Lazy Client ───────────────────────────── */
/**
 * 실제 네온 클라이언트를 처음 사용할 때까지 생성하지 않는
 * "지연 초기화" 래퍼 함수.
 *
 * - 첫 호출 시 importNeonOrHint() 로 드라이버를 로드하고,
 *   neon(connectionString) 으로 진짜 클라이언트 함수를 만든 뒤 캐싱한다.
 */
function createLazyClient(url: string): LazyClient {
  let real: NeonTagged | null = null;

  const lazy: any = async function (...args: any[]) {
    if (!real) {
      const neon = await importNeonOrHint();
      real = neon(url);
    }

    // tagged template / 일반 호출 모두 지원
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return real.apply(undefined, args);
  };

  return wrapWithResilience(lazy);
}

/* ────────────────────────────── Public API ───────────────────────────── */

/**
 * Env 에서 DB URL 을 읽어 Neon 클라이언트를 반환.
 * - URL 별로 1개씩만 생성해서 clientCache 에 보관
 * - 이후 호출은 항상 같은 인스턴스를 재사용
 */
export function getSql(env: Env) {
  const url = validateDbUrl(env.NEON_DATABASE_URL);

  let client = clientCache.get(url);
  if (!client) {
    client = createLazyClient(url);
    clientCache.set(url, client);
  }

  return client!;
}

/**
 * DB 헬스 체크
 * - 매우 가벼운 "select 1" 쿼리를 한 번 실행
 * - 이 함수에서는 *반드시* "일반 호출" 형태만 사용한다:
 *       await sql(DEFAULT_HEALTH_SQL);
 *
 *   이렇게 하면 내부 드라이버가 단순 텍스트 쿼리로 처리하므로
 *   prepared statement / bind 파라미터 개수 불일치 같은
 *   문제를 일으키지 않는다.
 */
export async function dbHealth(
  env: Env
): Promise<{ ok: true; took_ms: number } | { ok: false; error: string; took_ms: number }> {
  const t0 = performance.now();

  try {
    const sql = getSql(env);

    // ⚠️ 중요: 태그드 템플릿이 아니라 *단순 문자열* 로 호출한다.
    //   잘못된 사용 예)  await sql([DEFAULT_HEALTH_SQL]);
    //   올바른 사용 예)  await sql(DEFAULT_HEALTH_SQL);
    await sql(DEFAULT_HEALTH_SQL);

    return { ok: true, took_ms: Math.round(performance.now() - t0) };
  } catch (e: any) {
    const msgParts = [
      String(e?.message ?? e),
      _lastImportError ? `(driver: ${_lastImportError})` : "",
    ].filter(Boolean);

    return {
      ok: false,
      error: msgParts.join(" "),
      took_ms: Math.round(performance.now() - t0),
    };
  }
}

/* ────────────────────────────── 디버그 (비 export) ────────────────────── */
/**
 * 내부 상태를 한 번에 볼 수 있는 디버그용 함수.
 * - 실제 코드에서는 export 하지 않고,
 *   필요하면 브레이크포인트에서 __db_debug__ 를 평가해서 확인.
 */
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
const __db_debug__ = _debugState;
