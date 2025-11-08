// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\auth\me.ts

import { json } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { requireUser } from "../_utils/auth";

/**
 * 에디터 오류 해결 메모
 * - ts(2304) PagesFunction 미정의 → 최소 ambient 타입을 아래에 선언
 * - ts(7031) request/env 암시적 any → 핸들러 인자 타입 명시
 * - ts(2558) sql<T> 제너릭 사용 불가 → 질의 결과를 런타임에서 안전 캐스팅
 */

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

type Row = {
  id: number | string | bigint;
  email: string;
  username: string | null;
  avatar: string | null;
  created_at: string | Date;
};

function toNumberSafe(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function toIsoString(v: unknown): string {
  if (typeof v === "string") {
    // 문자열이 이미 ISO일 가능성이 높음 — 유효성만 간단히 체크
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date(v).toISOString() : v;
  }
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
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
    // 인증 토큰 검사(필수: sub)
    const payload = await requireUser(request, env);
    const sql = getSql(env);

    // 필요한 컬럼만 조회(민감 정보 최소화)
    // 주의: getSql이 태그드 템플릿 함수이므로 제너릭(<> ) 미지원 → any 캐스팅 후 안전 정규화
    const rows = (await sql`
      select id::bigint as id, email, username, avatar, created_at
      from users
      where id = ${payload.sub}
      limit 1
    `) as unknown as Row[];

    if (!rows || rows.length === 0) {
      return withCORS(json({ error: "Not found" }, { status: 404 }), env.CORS_ORIGIN);
    }

    // 타입 정규화: bigint → number, created_at → ISO 문자열
    const r = rows[0];
    const user = {
      id: toNumberSafe(r.id),
      email: r.email,
      username: r.username,
      avatar: r.avatar,
      created_at: toIsoString(r.created_at),
    };

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true, user },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Me-Took-ms": String(took),
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    // 인증 실패나 기타 오류는 401로 유지
    return withCORS(
      json(
        { error: String(e?.message || e) },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      ),
      env.CORS_ORIGIN
    );
  }
};
