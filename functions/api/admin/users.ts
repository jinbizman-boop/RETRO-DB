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
 *
 * 추가 보강(기존 구조 유지)
 * - 안전한 쿼리 파라미터 파싱(limit/order/since/until/before/after/q/fields/includeTotal)
 * - 컬럼 화이트리스트 기반 선택 반환
 * - 커서 페이지네이션(before/after=id)
 * - 총합(optional)과 성능/진단 헤더
 * - CORS 흐름은 기존 preflight/withCORS를 그대로 사용(전역 미들웨어와 병행 가능)
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

/* ───────────────────────── 유틸: 타입 안정 변환 ───────────────────────── */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toBooleanLike(v: string | null, fallback = false): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return fallback;
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

/* ──────────────── 파라미터 파서(화이트리스트/기본값 유지) ──────────────── */
const FIELD_WHITELIST = new Set<keyof Row>(["id", "email", "username", "created_at"]);
type Order = "asc" | "desc";

function parseFields(raw: string | null): (keyof Row)[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const cols: (keyof Row)[] = [];
  for (const p of parts) {
    if (FIELD_WHITELIST.has(p as keyof Row)) cols.push(p as keyof Row);
  }
  return cols.length ? Array.from(new Set(cols)) : null;
}

function parseOrder(raw: string | null, fallback: Order = "desc"): Order {
  const o = (raw || "").toLowerCase();
  return o === "asc" ? "asc" : o === "desc" ? "desc" : fallback;
}

function parseLimit(raw: string | null, fallback = 200): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function parseCursor(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/* ─────────────────────────────── SQL 빌더 ───────────────────────────────
   주의: 정렬/컬럼은 화이트리스트 통과 후에만 **리터럴 삽입**.
   나머지 값들은 모두 파라미터 바인딩을 사용한다. */
function buildSelectClause(fields: (keyof Row)[] | null): string {
  const cols = fields && fields.length ? fields : ["id", "email", "username", "created_at"];
  // id는 항상 bigint→number 매핑을 위해 ::bigint 별칭 권장(네온/포스트그레스 환경에 따라 문자열일 수 있음)
  return cols
    .map((c) => (c === "id" ? `id::bigint as id` : c))
    .join(", ");
}

/* ─────────────────────────────────────────────────────────────────────── */

export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  // CORS preflight
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "GET") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    const url = new URL(request.url);

    // ---- 안전한 쿼리 파라미터 처리(기본값은 기존과 동일) ----
    const limit = parseLimit(url.searchParams.get("limit"), 200);
    const order: Order = parseOrder(url.searchParams.get("order"), "desc");
    const sinceIso = isValidIsoDate(url.searchParams.get("since")); // 선택: 특정 시점 이후
    const untilIso = isValidIsoDate(url.searchParams.get("until")); // 선택: 특정 시점 이전
    const before = parseCursor(url.searchParams.get("before"));     // id < before
    const after = parseCursor(url.searchParams.get("after"));       // id > after
    const q = (url.searchParams.get("q") || "").trim();             // email/username like 검색
    const fields = parseFields(url.searchParams.get("fields"));     // 선택 컬럼
    const includeTotal = toBooleanLike(url.searchParams.get("includeTotal"), false);

    // 정렬 방향을 분기로 안전히 삽입(화이트리스트 기반)
    const orderToken = order === "asc" ? "asc" : "desc";
    const selectClause = buildSelectClause(fields);

    const sql = getSql(env);

    // ---- 동적 where 조건 조립(전부 파라미터 바인딩) ----
    const whereParts: string[] = [];
    const params: any[] = [];

    if (sinceIso) {
      whereParts.push(`created_at >= ${`$${params.length + 1}`}`);
      params.push(sinceIso);
    }
    if (untilIso) {
      whereParts.push(`created_at <= ${`$${params.length + 1}`}`);
      params.push(untilIso);
    }
    if (before != null) {
      whereParts.push(`id < ${`$${params.length + 1}`}`);
      params.push(before);
    }
    if (after != null) {
      whereParts.push(`id > ${`$${params.length + 1}`}`);
      params.push(after);
    }
    if (q) {
      whereParts.push(`(email ilike ${`$${params.length + 1}`} or coalesce(username,'') ilike ${`$${params.length + 2}`})`);
      params.push(`%${q}%`, `%${q}%`);
    }

    // where 절 문자열
    const whereSQL = whereParts.length ? ` where ${whereParts.join(" and ")} ` : " ";

    // ---- 총합 쿼리(옵션) ----
    let totalCount = undefined as number | undefined;
    if (includeTotal) {
      const totalRows = await sql([`select count(*)::bigint as n from users`, whereSQL], ...params);
      const n = Array.isArray(totalRows) && totalRows[0] && (totalRows[0].n ?? totalRows[0].count);
      totalCount = num(n);
    }

    // ---- 본문 쿼리: 선택 컬럼 + 정렬 + limit ----
    //    정렬 토큰은 사전 분기로만 리터럴 삽입 (asc/desc)
    const rows: Row[] = await sql(
      [
        `select ${selectClause} from users`,
        whereSQL,
        `order by id ${orderToken}`,
        `limit ${`$${params.length + 1}`}`,
      ],
      ...params,
      limit
    );

    // bigint → number 안전 변환
    const safe = rows.map((r) => ({
      id: num(r.id),
      email: r.email,
      username: r.username,
      created_at: typeof r.created_at === "string" ? r.created_at : String(r.created_at),
    }));

    const took = Math.round(performance.now() - t0);

    // 커서 힌트(다음 페이지 탐색)
    const nextBefore = order === "desc" && safe.length ? String(safe[safe.length - 1].id) : undefined;
    const nextAfter  = order === "asc"  && safe.length ? String(safe[safe.length - 1].id) : undefined;

    // 기존 계약 유지: { ok: true, users: [...] } + 진단 헤더 보강
    return withCORS(
      json(
        {
          ok: true,
          users: safe,
          // 확장 메타(호환성 유지: 소비자가 없어도 무해)
          meta: {
            count: safe.length,
            limit,
            order,
            filters: {
              since: sinceIso,
              until: untilIso,
              before,
              after,
              q: q || undefined,
              fields: fields ?? undefined,
            },
            next: { before: nextBefore, after: nextAfter },
            total: includeTotal ? totalCount ?? 0 : undefined,
          },
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Users-Limit": String(limit),
            "X-Users-Order": order,
            "X-Users-Took-ms": String(took),
            ...(includeTotal ? { "X-Users-Total": String(totalCount ?? 0) } : {}),
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    const took = Math.round(performance.now() - t0);
    return withCORS(
      json(
        { ok: false, error: String(e?.message || e) },
        {
          status: 400,
          headers: { "Cache-Control": "no-store", "X-Users-Took-ms": String(took) },
        }
      ),
      env.CORS_ORIGIN
    );
  }
};
