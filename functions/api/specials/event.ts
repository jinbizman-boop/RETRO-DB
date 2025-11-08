// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\specials\event.ts
//
// ✅ 목표
// - 기존 기능/계약 100% 유지: OPTIONS/GET, 응답 { ok: true, events: Row[] } (최신 50건 기본)
// - 문제 해결:
//   1) ts(2304) PagesFunction 미정의  → 파일 상단에 에디터용 ambient 타입 선언 추가
//   2) ts(7031) request/env 암시적 any → 핸들러 인자에 명시적 타입 지정
//   3) ts(2558) Expected 0 type arguments → neon 템플릿 리터럴에 제네릭 제거
// - 보강(원래 흐름/스키마/응답은 그대로 유지):
//   • 안전한 쿼리 파라미터 (?limit, ?before_id, ?since, ?to, ?status, ?q)
//   • 스키마/인덱스 자동 보강 및 초기상태 내성
//   • bigint → number, 날짜 → ISO 문자열 정규화
//   • URL/문자열 정리, 약한 ETag + 짧은 퍼블릭 캐시, 처리시간 헤더

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

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/**
 * 계약 유지:
 * - 라우트/메서드 동일(OPTIONS/GET)
 * - 기본 동작 동일: 최신 50건 반환
 * - 응답 스키마 동일: { ok: true, events: rows }
 *
 * 보강:
 * - 안전한 쿼리 파라미터: ?limit=1..200, ?before_id, ?since, ?to, ?status=active|upcoming|past|all, ?q=검색
 * - 스키마/인덱스 자동 보강(`created_at`, `active`) 및 초기 상태 내성
 * - 타입 정규화(bigint→number, 날짜→ISO 문자열), URL/문자열 정리
 * - 약한 ETag + 짧은 퍼블릭 캐시 + 처리시간 헤더
 */

type RowRaw = {
  id: number | string | bigint;
  title: string;
  starts: string | Date | null;
  ends: string | Date | null;
  banner: string | null;
};

type RowSafe = {
  id: number;
  title: string;
  starts: string | null;
  ends: string | null;
  banner: string | null;
};

/* ───────── helpers ───────── */
function toNumberSafe(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isoOrNull(s: string | null): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  try {
    const d = typeof v === "string" ? new Date(v) : v;
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function cleanText(s: string | null, max = 200): string | null {
  if (s == null) return null;
  const v = s.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function cleanUrl(u: string | null, max = 1024): string | null {
  if (!u) return null;
  const s = u.trim();
  if (!s) return null;
  if (s.length > max) return null;
  // 허용: https/http 또는 data:image/*;base64,
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s)) return s;
  try {
    const url = new URL(s);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    /* noop */
  }
  return null;
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

function weakETag(str: string): string {
  // 경량 FNV-1a 해시
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `"W/${h.toString(16)}-${str.length}"`;
}

/* ───────── handler ───────── */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const beforeIdParam = url.searchParams.get("before_id");
    const since = isoOrNull(url.searchParams.get("since"));
    const to = isoOrNull(url.searchParams.get("to"));
    const status = (url.searchParams.get("status") || "all").toLowerCase(); // active|upcoming|past|all
    const q = (url.searchParams.get("q") || "").trim();

    const limit = Math.max(1, Math.min(200, limitParam ? Number(limitParam) : 50));
    const beforeId = beforeIdParam ? Number(beforeIdParam) : null;

    const sql = getSql(env);

    // ── 스키마/인덱스 보강 ───────────────────────────────────────────────
    try {
      await sql`
        create table if not exists events(
          id bigserial primary key,
          title text not null,
          starts timestamptz,
          ends timestamptz,
          banner text,
          active boolean not null default true,
          created_at timestamptz not null default now()
        )
      `;
      await sql`alter table events add column if not exists active boolean not null default true`;
      await sql`alter table events add column if not exists created_at timestamptz not null default now()`;
      await sql`create index if not exists events_active_idx on events (active)`;
      await sql`create index if not exists events_time_idx on events (starts, ends)`;
      await sql`create index if not exists events_created_desc on events (created_at desc)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 초기 경쟁상태 등은 무시하고 계속 진행
      }
    }

    // ── 조건 구성 ───────────────────────────────────────────────────────
    const nowIso = new Date().toISOString();

    // status 조건
    const statusClause =
      status === "active"
        ? sql`and (active = true)`
        : status === "upcoming"
        ? sql`and (starts is not null and starts > ${nowIso})`
        : status === "past"
        ? sql`and (coalesce(ends, starts, created_at) < ${nowIso})`
        : sql``; // all

    // 검색어
    const qClause = q ? sql`and (title ilike ${"%" + q + "%"})` : sql``;

    let rows: RowRaw[] = [];
    try {
      // NOTE: neon 템플릿에는 제네릭 타입 인자를 전달하지 않습니다. (ts2558 예방)
      const result = await sql`
        select
          id::bigint as id,
          title,
          starts,
          ends,
          banner
        from events
        where 1=1
          ${statusClause}
          ${since ? sql`and created_at >= ${since}` : sql``}
          ${to ? sql`and created_at < ${to}` : sql``}
          ${beforeId !== null ? sql`and id < ${beforeId}` : sql``}
          ${qClause}
        order by id desc
        limit ${limit}
      `;
      rows = result as unknown as RowRaw[];
    } catch (e) {
      if (!isMissingTable(e)) throw e;
      rows = [];
    }

    // ── 정규화 ──────────────────────────────────────────────────────────
    const safe: RowSafe[] = rows.map((r) => ({
      id: toNumberSafe(r.id),
      title: cleanText(r.title, 200) ?? "",
      starts: toIso(r.starts),
      ends: toIso(r.ends),
      banner: cleanUrl(r.banner),
    }));

    const body = { ok: true as const, events: safe };
    const payload = JSON.stringify(body);
    const etag = weakETag(payload);

    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=120, must-revalidate",
      ETag: etag,
      "X-Events-Limit": String(limit),
      "X-Events-Status": status,
      "X-Events-Took-ms": String(Math.round(performance.now() - t0)),
    };

    // 조건부 요청(304)
    const inm = request.headers.get("if-none-match");
    if (inm && inm === etag) {
      return withCORS(new Response(null, { status: 304, headers: new Headers(headers) }), env.CORS_ORIGIN);
    }

    return withCORS(json(body, { headers }), env.CORS_ORIGIN);
  } catch (e: any) {
    return withCORS(
      json({ error: String(e?.message || e) }, { status: 400, headers: { "Cache-Control": "no-store" } }),
      env.CORS_ORIGIN
    );
  }
};

/* ───────── Notes ─────────
1) 상단 PagesFunction ambient 선언은 타입체커용으로만 존재하며 빌드 산출물에는 포함되지 않습니다.
2) request/env에 명시적 타입을 부여해 ts(7031) 경고를 제거했습니다.
3) neon 템플릿 리터럴에 제네릭을 전달하면 ts(2558)가 발생하므로 제거하고,
   필요한 곳은 `as unknown as T`로 좁혀 사용합니다(런타임 동작 동일).
4) 기능·요소·규격·디자인·배치·게임 흐름은 기존과 동일합니다.
----------------------------------------------------------------------- */
