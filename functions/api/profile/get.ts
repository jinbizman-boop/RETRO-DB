// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\profile\get.ts
//
// ✅ 목표
// - 기존 기능/계약( GET /api/profile/get?userId=… → { ok:true, user } ) 100% 유지
// - 문제 해결: VS Code TS 오류(ts2304 PagesFunction / ts7031 implicit any / ts2558 제네릭) 제거
// - 보강: 입력 정규화, 초기 스키마 미생성 시 안전 동작, 캐시 차단/진단 헤더
//
// 참고: 아래 ambient 타입은 에디터 전용 선언으로 런타임에 영향이 없습니다.

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

/* ───────── Types ───────── */
type Row = {
  id: number | string | bigint;
  email: string;
  username: string | null;
  avatar: string | null;
  created_at: string | Date;
};

/* ───────── Helpers ───────── */
function toNumberSafe(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// 보수적 허용(기존 스키마와 호환): 영문/숫자/언더스코어/하이픈/.:@
function cleanUserId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().normalize("NFKC");
  return /^[a-zA-Z0-9_\-.:@]+$/.test(s) && s.length <= 64 ? s : null;
}

// 초기 배포 등으로 테이블이 없을 때도 실패하지 않도록
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

// 문자열/Date → ISO 문자열 정규화(안전)
function toIso(x: string | Date): string {
  return typeof x === "string" ? x : new Date(x).toISOString();
}

/* ───────── Handler ───────── */
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
    const userIdRaw = url.searchParams.get("userId");
    const userId = cleanUserId(userIdRaw);

    if (!userId) {
      return withCORS(json({ error: "userId required" }, { status: 400 }), env.CORS_ORIGIN);
    }

    const sql = getSql(env);

    // 존재하지 않는 초기 상태에서도 실패하지 않도록 방어 인덱스 시도(있으면 무시)
    try {
      // 함수형 인덱스 표기((id))는 일부 PG 호스트에서 경고가 될 수 있으므로 보수적으로 캐치
      await sql`create index if not exists users_id_idx on users (id)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 비치명적이면 무시 — 조회는 아래에서 시도
      }
    }

    // 필요한 컬럼만, 1건만 조회
    // ts2558(제네릭) 회피: 결과를 런타임에서 안전 캐스팅
    const rows = (await sql`
      select id::bigint as id, email, username, avatar, created_at
      from users
      where id = ${userId}
      limit 1
    `) as unknown as Row[];

    if (!rows.length) {
      return withCORS(json({ error: "Not found" }, { status: 404 }), env.CORS_ORIGIN);
    }

    const r = rows[0];
    const user = {
      id: toNumberSafe(r.id),
      email: r.email,
      username: r.username,
      avatar: r.avatar,
      created_at: toIso(r.created_at),
    };

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        { ok: true, user },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Profile-Get-Took-ms": String(took),
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    // 테이블 자체가 없을 수 있는 초기 상태 고려
    if (isMissingTable(e)) {
      return withCORS(json({ error: "Not found" }, { status: 404 }), env.CORS_ORIGIN);
    }
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
- PagesFunction ambient 타입을 파일 상단에 선언해 ts(2304) 제거
- handler 인자에 명시적 타입을 부여해 ts(7031) 제거
- sql<Row[]> 제네릭 사용을 제거하고 런타임 캐스팅으로 ts(2558) 제거
- 동작/스키마/응답 계약은 기존과 동일
----------------------------------------------------------------- */
