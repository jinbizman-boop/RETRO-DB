// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\admin\users.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";

/**
 * 오류 원인
 * - ts(2304): Cloudflare Pages ambient 타입 `PagesFunction` 미정의
 * - ts(7031): 구조 분해 매개변수(request/env) 암시적 any
 * - ts(2339): getSql이 반환하는 클라이언트에는 `raw`가 없음 → 정렬 토큰을 안전히 주입해야 함
 *
 * 해결
 * - 파일 내부에 최소한의 `PagesFunction` 타입을 선언(런타임 영향 없음)
 * - onRequest 인자 타입 명시
 * - 정렬 구문은 사전 화이트리스트('asc' | 'desc')로 분기하여 **리터럴**로 삽입
 *   (파라미터 바인딩이 불가능한 위치라 분기 방식이 가장 안전/명확)
 */

/* ─────────────────────── Minimal Cloudflare Pages ambient ─────────────────────── */
type CfEventLike<E> = {
  request: Request;
  env: E;
  params?: Record<string, string>;
  waitUntil?(p: Promise<any>): void;
  next?(): Promise<Response>;
  data?: Record<string, unknown>;
};
type PagesFunction<E = unknown> = (ctx: CfEventLike<E>) => Promise<Response> | Response;
/* ─────────────────────────────────────────────────────────────────────────────── */

type Row = { id: number; email: string; username: string | null; created_at: string };

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isValidIsoDate(s: string | null): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

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

    // ---- 안전한 쿼리 파라미터 처리(기본값은 기존과 동일) ----
    const limitRaw = url.searchParams.get("limit");
    const orderRaw = (url.searchParams.get("order") || "desc").toLowerCase();
    const sinceIso = isValidIsoDate(url.searchParams.get("since")); // 선택: 특정 시점 이후 가입자만

    const limit = Math.max(1, Math.min(500, limitRaw ? Number(limitRaw) : 200));
    const order: "asc" | "desc" = orderRaw === "asc" ? "asc" : "desc"; // asc/desc만 허용

    const sql = getSql(env);

    // ---- 단일 where 절(옵션): created_at 필터 ----
    let rows: Row[];

    if (sinceIso) {
      // 기간 필터 + 정렬 방식을 분기로 안전히 주입
      if (order === "asc") {
        rows = await sql`
          select id::bigint as id, email, username, created_at
          from users
          where created_at >= ${sinceIso}
          order by id asc
          limit ${limit}
        `;
      } else {
        rows = await sql`
          select id::bigint as id, email, username, created_at
          from users
          where created_at >= ${sinceIso}
          order by id desc
          limit ${limit}
        `;
      }
    } else {
      // 기존 동작(전체에서 최신 N명) + 정렬 분기
      if (order === "asc") {
        rows = await sql`
          select id::bigint as id, email, username, created_at
          from users
          order by id asc
          limit ${limit}
        `;
      } else {
        rows = await sql`
          select id::bigint as id, email, username, created_at
          from users
          order by id desc
          limit ${limit}
        `;
      }
    }

    // bigint → number 안전 변환 (created_at은 문자열 그대로 반환)
    const safe = rows.map((r) => ({
      id: num(r.id),
      email: r.email,
      username: r.username,
      created_at: typeof r.created_at === "string" ? r.created_at : String(r.created_at),
    }));

    const took = Math.round(performance.now() - t0);

    // 기존 계약 유지: { ok: true, users: [...] }
    return withCORS(
      json(
        { ok: true, users: safe },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Users-Limit": String(limit),
            "X-Users-Order": order,
            "X-Users-Took-ms": String(took),
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    return withCORS(
      json(
        { error: String(e?.message || e) },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }
      ),
      env.CORS_ORIGIN
    );
  }
};
