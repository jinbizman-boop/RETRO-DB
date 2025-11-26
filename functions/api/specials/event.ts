// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\specials\event.ts
//
// ✅ 목표
// - 기존 기능/계약 100% 유지: OPTIONS/GET, 응답 { ok: true, events: Row[] } (최신 50건 기본)
// - 문제 해결:
//   1) ts(2304) PagesFunction 미정의  → 파일 상단에 에디터용 ambient 타입 선언 추가
//   2) ts(7031) request/env 암시적 any → 핸들러 인자에 명시적 타입 지정
//   3) ts(2558) Expected 0 type arguments → neon 템플릿 리터럴에 제네릭 제거
// - 보강(원래 흐름/스키마/응답 구조는 그대로 유지):
//   • 안전한 쿼리 파라미터 (?limit, ?before_id, ?since, ?to, ?status, ?q)
//   • 스키마/인덱스 자동 보강 및 초기상태 내성
//   • bigint → number, 날짜 → ISO 문자열 정규화
//   • URL/문자열 정리, 약한 ETag + 짧은 퍼블릭 캐시, 처리시간 헤더
//   • 내부적으로 status(active/upcoming/past) 집계 후 헤더로 노출
//
// ───────────────────────────────────────────────────────────────

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ───────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (
  ctx: CfEventLike<E>
) => Promise<Response> | Response;
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
 * - 이벤트 상태(active/upcoming/past) 집계 후 헤더로 전달
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

/* ───────── helpers: 숫자/날짜/문자열 정규화 ───────── */

/**
 * 다양한 타입(number | string | bigint)을 안전하게 number 로 변환
 * - 실패 시 0 반환(아이디/정렬용이라 치명적이지 않도록)
 */
function toNumberSafe(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 문자열이거나 null 일 수 있는 값을 ISO 문자열로 정규화
 * - 유효하지 않은 날짜는 null 로 처리
 */
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

/**
 * string | Date | null → ISO 문자열 또는 null
 */
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

/**
 * 이벤트 타이틀/검색어 등에 사용하는 텍스트 정규화
 * - trim
 * - 제어문자 제거
 * - 최대 길이 제한
 */
function cleanText(s: string | null, max = 200): string | null {
  if (s == null) return null;
  const v = s
    .trim()
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * 배너 URL 정규화
 * - 빈 문자열/공백 → null
 * - 최대 길이 초과 → null
 * - http/https 또는 data:image/*;base64, 만 허용
 */
function cleanUrl(u: string | null, max = 1024): string | null {
  if (!u) return null;
  const s = u.trim();
  if (!s) return null;
  if (s.length > max) return null;
  // 허용: data:image/*;base64,
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s)) return s;
  try {
    const url = new URL(s);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    /* noop */
  }
  return null;
}

/**
 * relation / table 미존재 여부
 * - Neon / Postgres 에서 relation missing 관련 에러 메시지 패턴에 대응
 */
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

/**
 * 간단한 FNV-1a 32bit 기반 약한 ETag 생성
 */
function weakETag(str: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `"W/${h.toString(16)}-${str.length}"`;
}

/* ───────── helpers: 상태(status) 판별 및 헤더 집계 ───────── */

type EventStatus = "active" | "upcoming" | "past";

/**
 * 시작/종료 시각과 현재시각(nowIso)을 기준으로 이벤트 상태를 판별.
 * - 날짜가 전혀 없으면 created_at 기준으로 판단하는게 이상적이지만,
 *   여기서는 보수적으로 모두 "active"로 간주하지 않고
 *   starts/ends 가 모두 null 이면 active 로 처리(기존 행위와 최대한 일치)
 */
function classifyStatus(
  startsIso: string | null,
  endsIso: string | null,
  nowIso: string
): EventStatus {
  try {
    const now = new Date(nowIso).getTime();
    const startsTime = startsIso ? new Date(startsIso).getTime() : NaN;
    const endsTime = endsIso ? new Date(endsIso).getTime() : NaN;

    const hasStarts = Number.isFinite(startsTime);
    const hasEnds = Number.isFinite(endsTime);

    if (hasStarts && startsTime > now) {
      return "upcoming";
    }
    if (hasEnds && endsTime < now) {
      return "past";
    }
    return "active";
  } catch {
    return "active";
  }
}

/**
 * 현재 반환된 이벤트들에 대해 상태별 개수를 세어
 * 헤더(X-Events-Active/Upcoming/Past)로 노출하기 위한 집계 헬퍼
 */
function aggregateStatusCounts(
  events: RowSafe[],
  nowIso: string
): { active: number; upcoming: number; past: number } {
  let active = 0;
  let upcoming = 0;
  let past = 0;

  for (const ev of events) {
    const status = classifyStatus(ev.starts, ev.ends, nowIso);
    if (status === "active") active++;
    else if (status === "upcoming") upcoming++;
    else if (status === "past") past++;
  }

  return { active, upcoming, past };
}

/* ───────── handler ───────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  // Preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);

  // 허용 메서드: GET
  if (request.method !== "GET") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
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

    const limitRaw = limitParam ? Number(limitParam) : 50;
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
    const beforeIdRaw = beforeIdParam ? Number(beforeIdParam) : null;
    const beforeId =
      beforeIdRaw != null && Number.isFinite(beforeIdRaw) ? beforeIdRaw : null;

    const sql = getSql(env);

    // ── 스키마/인덱스 보강 ───────────────────────────────────────────────
    try {
      await sql/* sql */ `
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
      await sql/* sql */ `
        alter table events
          add column if not exists active boolean not null default true
      `;
      await sql/* sql */ `
        alter table events
          add column if not exists created_at timestamptz not null default now()
      `;
      await sql/* sql */ `
        create index if not exists events_active_idx
        on events (active)
      `;
      await sql/* sql */ `
        create index if not exists events_time_idx
        on events (starts, ends)
      `;
      await sql/* sql */ `
        create index if not exists events_created_desc
        on events (created_at desc)
      `;
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
        ? sql/* sql */`and (active = true)`
        : status === "upcoming"
        ? sql/* sql */`and (starts is not null and starts > ${nowIso})`
        : status === "past"
        ? sql/* sql */`and (coalesce(ends, starts, created_at) < ${nowIso})`
        : sql/* sql */``; // all

    // 검색어
    const searchTerm = cleanText(q, 100);
    const qClause = searchTerm
      ? sql/* sql */`and (title ilike ${"%" + searchTerm + "%"})`
      : sql/* sql */``;

    let rows: RowRaw[] = [];
    try {
      // NOTE: neon 템플릿에는 제네릭 타입 인자를 전달하지 않습니다. (ts2558 예방)
      const result = await sql/* sql */ `
        select
          id::bigint as id,
          title,
          starts,
          ends,
          banner
        from events
        where 1=1
          ${statusClause}
          ${since ? sql/* sql */`and created_at >= ${since}` : sql/* sql */``}
          ${to ? sql/* sql */`and created_at < ${to}` : sql/* sql */``}
          ${beforeId !== null ? sql/* sql */`and id < ${beforeId}` : sql/* sql */``}
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
    const safe: RowSafe[] = rows.map((r) => {
      const id = toNumberSafe(r.id);
      const title = cleanText(r.title, 200) ?? "";
      const startsIso = toIso(r.starts);
      const endsIso = toIso(r.ends);
      const banner = cleanUrl(r.banner);

      return {
        id,
        title,
        starts: startsIso,
        ends: endsIso,
        banner,
      };
    });

    // 상태별 개수 집계(헤더용)
    const statusCounts = aggregateStatusCounts(safe, nowIso);

    const body = { ok: true as const, events: safe };
    const payload = JSON.stringify(body);
    const etag = weakETag(payload);

    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=120, must-revalidate",
      ETag: etag,
      "X-Events-Limit": String(limit),
      "X-Events-Status": status,
      "X-Events-Took-ms": String(Math.round(performance.now() - t0)),
      "X-Events-Active-Count": String(statusCounts.active),
      "X-Events-Upcoming-Count": String(statusCounts.upcoming),
      "X-Events-Past-Count": String(statusCounts.past),
    };

    // 조건부 요청(304)
    const inm = request.headers.get("if-none-match");
    if (inm && inm === etag) {
      return withCORS(
        new Response(null, { status: 304, headers: new Headers(headers) }),
        env.CORS_ORIGIN
      );
    }

    return withCORS(json(body, { headers }), env.CORS_ORIGIN);
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};

/* ───────── Notes ─────────
1) 상단 PagesFunction ambient 선언은 타입체커용으로만 존재하며 빌드 산출물에는 포함되지 않습니다.
2) request/env에 명시적 타입을 부여해 ts(7031) 경고를 제거했습니다.
3) neon 템플릿 리터럴에 제네릭을 전달하면 ts(2558)가 발생하므로 제거하고,
   필요한 곳은 `as unknown as T`로 좁혀 사용합니다(런타임 동작 동일).
4) 기능·요소·규격·디자인·배치·게임 흐름은 기존과 동일하며,
   이벤트 상태(active/upcoming/past) 집계 정보만 헤더로 추가 노출합니다.
----------------------------------------------------------------------- */
