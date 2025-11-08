// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\specials\banner.ts
//
// ✅ 목표
// - 기존 기능/계약 100% 유지: GET /api/specials/banner
//   응답: { ok: true, banners: Array<{ id:number, name:string|null, image:string|null, url:string|null }> }
// - 문제 해결:
//   1) ts(2304) PagesFunction 미정의 → 파일 상단에 에디터용 ambient 타입 선언
//   2) ts(7031) request/env implicit any → 핸들러 인자에 명시적 타입 부여
//   3) ts(2558) "Expected 0 type arguments" (neon 템플릿에 제네릭 전달) → 제네릭 제거 후 런타임 캐스팅
// - 보강:
//   • 스키마/인덱스 자동 보강(있으면 무시)
//   • 문자열/URL 정규화, bigint→number 변환
//   • 선택 파라미터: ?limit=1..50, ?placement=텍스트
//   • 약한 ETag + 짧은 퍼블릭 캐시, 처리시간 헤더
//   • 초기 테이블 미생성 상태에도 안전 동작

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
 * - 라우트/메서드/응답 스키마 동일: { ok: true, banners: Row[] }
 * - 기본 동작: 활성 배너 최신 10개 반환
 *
 * 보강:
 * - 스키마 자동 보강(컬럼/인덱스) 및 초기상태 내성
 * - 선택 파라미터: ?limit=..(1..50), ?placement=..(선택)
 * - URL/문자열 정규화, bigint→number 변환
 * - 짧은 퍼블릭 캐시 + ETag(변경 감지), 처리시간 헤더
 */

type RowRaw = {
  id: number | string | bigint;
  name: string | null;
  image: string | null;
  url: string | null;
};

type RowSafe = {
  id: number;
  name: string | null;
  image: string | null;
  url: string | null;
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
  // 경량 FNV-1a 해시 기반 약한 ETag
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
    const placement = (url.searchParams.get("placement") || "").trim(); // 선택: 위치(홈, 메인배너 등)
    const limit = Math.max(1, Math.min(50, limitParam ? Number(limitParam) : 10));

    const sql = getSql(env);

    // ── 스키마/인덱스 보강 (있으면 무시) ────────────────────────────────
    // placement, created_at을 추가하여 운영/정렬 유연성 강화
    try {
      await sql`
        create table if not exists banners(
          id bigserial primary key,
          name text,
          image text,
          url text,
          placement text,
          active boolean not null default true,
          created_at timestamptz not null default now()
        )
      `;
      await sql`alter table banners add column if not exists placement text`;
      await sql`alter table banners add column if not exists created_at timestamptz not null default now()`;
      await sql`alter table banners alter column active set default true`;
      await sql`create index if not exists banners_active_created_idx on banners (active, created_at desc)`;
      await sql`create index if not exists banners_placement_idx on banners (placement)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 초기 경쟁상태 등은 무시하고 진행
      }
    }

    // ── 조회(활성 배너 최신순): placement가 있으면 필터 적용 ─────────────
    let rows: RowRaw[] = [];
    try {
      // NOTE: neon 템플릿에는 제네릭을 넘기지 않습니다. (ts2558 예방)
      const result = await sql`
        select id::bigint as id, name, image, url
        from banners
        where active = true
          ${placement ? sql`and (placement = ${placement})` : sql``}
        order by created_at desc, id desc
        limit ${limit}
      `;
      rows = result as unknown as RowRaw[];
    } catch (e) {
      if (!isMissingTable(e)) throw e;
      rows = [];
    }

    // ── 정규화/검증: 잘못된 URL/텍스트는 null 처리 ──────────────────────
    const safe: RowSafe[] = rows.map((r) => ({
      id: toNumberSafe(r.id),
      name: cleanText(r.name, 120),
      image: cleanUrl(r.image),
      url: cleanUrl(r.url),
    }));

    const body = { ok: true as const, banners: safe };

    // ETag/짧은 캐시: 배너는 빈번히 바뀔 수 있어 120초로 제한
    const payload = JSON.stringify(body);
    const etag = weakETag(payload);

    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=120, must-revalidate",
      ETag: etag,
      "X-Banners-Limit": String(limit),
      "X-Banners-Placement": placement || "",
      "X-Banners-Took-ms": String(Math.round(performance.now() - t0)),
    };

    // 조건부 요청 처리 (304)
    const inm = request.headers.get("if-none-match");
    if (inm && inm === etag) {
      return withCORS(new Response(null, { status: 304, headers: new Headers(headers) }), env.CORS_ORIGIN);
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
1) 파일 상단의 PagesFunction ambient 선언은 에디터/타입체커 전용이며, 런타임에 코드가 생성되지 않습니다.
2) neon(sql) 템플릿에 제네릭 타입 인자를 넘기면 ts(2558)가 발생하므로 제거하고, 필요 시 `as unknown as T`로
   결과를 좁혀 사용합니다(실행 동작은 동일).
3) 기능·요소·규격·디자인·배치·게임 흐름은 기존과 동일하며, 응답 스키마/쿼리 파라미터 계약도 그대로 유지됩니다.
----------------------------------------------------------------------- */
