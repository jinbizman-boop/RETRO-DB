// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\analytics\collect.ts

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateEvent } from "../_utils/schema/analytics";
import * as Rate from "../_utils/rate-limit";

/**
 * 문제 증상 (VSCode/tsserver)
 * - ts(2304): `PagesFunction` 타입을 찾지 못함
 * - ts(7031): 구조 분해 매개변수(request/env)가 암시적 any
 *
 * 해결 전략 (계약/기능 100% 유지)
 * - 본 파일에 Cloudflare Pages용 **최소 ambient 타입**을 선언
 * - onRequest 인자 타입을 명시
 * - 런타임/응답 스키마/라우팅은 기존과 동일
 */

/* ────────────────── Minimal Cloudflare Pages ambient types ────────────────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ──────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────── Helpers ─────────────────────────────── */
function getIdemKey(req: Request): string | null {
  return (
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key") ||
    req.headers.get("x-idempotency-key")
  );
}

function headerNoStore(extra: Record<string, string> = {}): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

/**
 * 서버가 보강해서 기록하는 요청 메타 필드
 * - 클라이언트가 보낸 meta와 병합되어 analytics_events.meta에 저장
 */
function makeServerMeta(request: Request) {
  const url = new URL(request.url);
  const h = request.headers;
  return {
    _req: {
      path: url.pathname,
      referer: h.get("referer") || h.get("referrer") || null,
      ua: h.get("user-agent") || null,
      ip: h.get("cf-connecting-ip") || null,
      country: h.get("cf-ipcountry") || null,
      colo: (request as any)?.cf?.colo ?? null, // e.g., ICN/NRT
      ray: h.get("cf-ray") || null,
      ts: Date.now(),
    },
  };
}

/* ─────────────────────────────── Handler ─────────────────────────────── */
/**
 * 계약 유지:
 * - 라우트/메서드: POST /api/analytics/collect
 * - 입력: validateEvent(body) 스키마 준수
 * - 성공 응답: { ok: true }
 * 보강:
 * - Rate Limit, 멱등키(Idempotency-Key), 테이블/인덱스 자동 보강, 운영 헤더
 */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  // ── Rate limit ──────────────────────────────────────────────────────
  if (!(await Rate.allow(request))) {
    return withCORS(
      json({ error: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "60" } }),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    // 1) 입력 파싱 및 검증(계약 유지)
    const body = await readJSON(request);
    const data = validateEvent(body);

    // 2) 서버 측 메타 부가
    const mergedMeta = { ...data.meta, ...makeServerMeta(request) };

    // 3) DB 핸들
    const sql = getSql(env);

    // 4) 스키마/인덱스 보강 (존재 시 무시)
    await sql`
      create table if not exists analytics_events(
        id bigserial primary key,
        event text not null,
        user_id text,
        meta jsonb not null default '{}'::jsonb,
        idempotency_key text unique,
        created_at timestamptz not null default now()
      )
    `;
    await sql`
      create index if not exists analytics_events_event_created_at
      on analytics_events(event, created_at desc)
    `;
    await sql`
      create index if not exists analytics_events_user_created_at
      on analytics_events(user_id, created_at desc)
    `;

    // 5) 멱등키 처리(중복 수집 방지)
    const idem = getIdemKey(request);
    if (idem) {
      await sql`
        insert into analytics_events(event, user_id, meta, idempotency_key)
        values (${data.event}, ${data.userId}, ${JSON.stringify(mergedMeta)}, ${idem})
        on conflict (idempotency_key) do nothing
      `;
    } else {
      await sql`
        insert into analytics_events(event, user_id, meta)
        values (${data.event}, ${data.userId}, ${JSON.stringify(mergedMeta)})
      `;
    }

    // 6) 응답
    const took = Math.round(performance.now() - t0);
    return withCORS(
      json(
        { ok: true },
        { headers: headerNoStore({ "X-Collect-Took-ms": String(took) }) }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    // 입력/DB 에러를 400으로 정규화(계약 유지)
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 400, headers: headerNoStore() }
      ),
      env.CORS_ORIGIN
    );
  }
};
