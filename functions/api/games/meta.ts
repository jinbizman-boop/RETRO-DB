// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\games\meta.ts
//
// ✅ 목표
// - 기존 기능/응답 계약( { ok:true, games:[{id,name}]} ) 100% 유지
// - TS 편집기 오류(ts2304: PagesFunction / ts7031: implicit any) 제거
// - 운영 편의 헤더/ETag·조건부 응답/언어 선택 등 보강
//
// 주요 보강
// 1) 최소 ambient 타입으로 PagesFunction 정의(에디터 전용, 런타임 영향 없음)
// 2) 핸들러 인자 타입 명시({ request, env })
// 3) Accept-Language 감지 + locale 파라미터 우선
// 4) ids 필터, q 검색, limit, 정렬은 보수적으로 처리
// 5) 5분 캐시 + ETag + 304 응답 지원

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";

/* ───────── Minimal Cloudflare Pages ambient types (editor-only) ─────────
   - @cloudflare/workers-types 없이도 VS Code 경고 없이 개발 가능
   - 런타임 영향 없음(순수 타입 선언) */
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

// 내부 마스터 목록(계약 유지: 최종 응답에는 id, name만 포함)
const GAMES_MASTER: Array<{ id: string; name_en: string; name_ko: string }> = [
  { id: "2048",           name_en: "2048",          name_ko: "2048" },
  { id: "tetris",         name_en: "Tetris",        name_ko: "테트리스" },
  { id: "brick-breaker",  name_en: "Brick Breaker", name_ko: "브릭 브레이커" },
  { id: "brick-match",    name_en: "Brick Match",   name_ko: "브릭 매치" },
  { id: "retro-running",  name_en: "Retro Running", name_ko: "레트로 러닝" },
];

// Accept-Language → "ko"/"en" 간단 매핑
function acceptLangToLocale(h: Headers, fallback = "en"): "en" | "ko" {
  const al = h.get("accept-language") || "";
  const s = al.toLowerCase();
  if (s.includes("ko")) return "ko";
  return fallback === "ko" ? "ko" : "en";
}

// id 파라미터 안전 정리
function cleanId(s: string | null): string | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  return /^[a-z0-9_\-]{1,64}$/.test(v) ? v : null;
}

// 현지화 이름 선택
function pickName(locale: "en" | "ko", item: typeof GAMES_MASTER[number]) {
  return locale === "ko" ? item.name_ko : item.name_en;
}

// 가벼운 ETag 생성(FNV-1a 기반 약식)
function hashETag(payload: string): string {
  let h = 2166136261 >>> 0; // FNV-1a seed
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `"W/${h.toString(16)}-${payload.length}"`;
}

export const onRequest: PagesFunction<{ CORS_ORIGIN: string }> = async (
  { request, env }: { request: Request; env: { CORS_ORIGIN: string } }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);

    // 검색/필터 파라미터
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();        // 부분 일치 검색어
    const localeParam = (url.searchParams.get("locale") || "").trim().toLowerCase();
    const idsParam = (url.searchParams.get("ids") || "").trim();             // 콤마 구분 id 리스트
    const limitParam = url.searchParams.get("limit");

    const limit = Math.max(
      1,
      Math.min(200, limitParam ? Number(limitParam) : GAMES_MASTER.length)
    );

    // locale 우선순위: param → Accept-Language → en
    const locale: "en" | "ko" =
      localeParam === "ko" || localeParam === "en"
        ? (localeParam as "en" | "ko")
        : acceptLangToLocale(request.headers, "en");

    // ids 필터(주어진 순서 유지, 중복 제거)
    let pool = GAMES_MASTER;
    if (idsParam) {
      const want = Array.from(
        new Set(
          idsParam
            .split(",")
            .map((s) => cleanId(s))
            .filter((v): v is string => !!v)
        )
      );
      const dict = new Map(pool.map((it) => [it.id, it]));
      pool = want.map((id) => dict.get(id)).filter((x): x is typeof GAMES_MASTER[number] => !!x);
    }

    // q 검색(영문/국문 제목과 id에서 부분 일치)
    if (q) {
      const ql = q.toLowerCase();
      pool = pool.filter(
        (it) =>
          it.id.includes(ql) ||
          it.name_en.toLowerCase().includes(ql) ||
          it.name_ko.toLowerCase().includes(ql)
      );
    }

    // 안정적인 출력 위해 id 오름차순 정렬
    pool = pool.slice(0).sort((a, b) => a.id.localeCompare(b.id, "en"));

    // 응답 계약 유지: { id, name }
    const games = pool.slice(0, limit).map((it) => ({
      id: it.id,
      name: pickName(locale, it),
    }));

    // ETag/캐시 — 게임 메타는 비교적 정적: 5분 캐시 허용
    const body = { ok: true as const, games };
    const payload = JSON.stringify(body);
    const etag = hashETag(payload);

    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=300, must-revalidate",
      ETag: etag,
      "X-Games-Locale": locale,
      "X-Games-Limit": String(limit),
      "X-Games-Took-ms": String(Math.round(performance.now() - t0)),
    };

    // 조건부 요청 처리(ETag 일치 시 304)
    const inm = request.headers.get("if-none-match");
    if (inm && inm === etag) {
      return withCORS(new Response(null, { status: 304, headers: new Headers(headers) }), env.CORS_ORIGIN);
    }

    return withCORS(json(body, { headers }), env.CORS_ORIGIN);
  } catch (e: any) {
    return withCORS(json({ error: String(e?.message || e) }, { status: 400 }), env.CORS_ORIGIN);
  }
};
