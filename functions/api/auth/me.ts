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
 *
 * 추가 기능
 * - 계정별 지갑/진행도(포인트, 티켓, 경험치) 요약을 함께 반환
 * - 스키마는 지연 생성(create table if not exists) + 테이블 미존재 시 0으로 응답
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

type ProgressRow = {
  exp: number | string | bigint | null;
  level: number | string | bigint | null;
  tickets: number | string | bigint | null;
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
function toNonNegativeInt(v: unknown): number {
  const n = Math.trunc(toNumberSafe(v));
  return n < 0 ? 0 : n;
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
function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
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
    const numericId = toNumberSafe(r.id);
    const userIdText = String(numericId || payload.sub || "");
    const user = {
      id: numericId,
      email: r.email,
      username: r.username,
      avatar: r.avatar,
      created_at: toIsoString(r.created_at),
    };

    // ───────── 계정별 진행도/지갑 요약(포인트/티켓/경험치) ─────────
    let points = 0;
    let exp = 0;
    let level = 1;
    let tickets = 0;

    if (userIdText) {
      // (1) user_progress: 경험치/레벨/티켓
      try {
        await sql`
          create table if not exists user_progress(
            user_id    text primary key,
            exp        bigint not null default 0,
            level      int    not null default 1,
            tickets    bigint not null default 0,
            updated_at timestamptz not null default now()
          )
        `;
      } catch (e) {
        // 테이블 생성 중 경쟁 상태나 권한 문제 등은 여기서 처리하지 않고
        // 아래 조회 단계에서 다시 한 번 분기한다.
      }

      try {
        const progRows = (await sql`
          select exp, level, tickets
          from user_progress
          where user_id = ${userIdText}
          limit 1
        `) as unknown as ProgressRow[];

        if (progRows && progRows.length > 0) {
          const p = progRows[0];
          exp = toNonNegativeInt(p.exp);
          level = toNonNegativeInt(p.level) || 1;
          tickets = toNonNegativeInt(p.tickets);
        }
      } catch (e) {
        if (!isMissingTable(e)) {
          throw e;
        }
        // user_progress 테이블이 아직 없으면 기본값(0,1,0) 유지
      }

      // (2) wallet_balances: 포인트(지갑 잔액)
      try {
        await sql`
          create table if not exists wallet_balances(
            user_id text primary key,
            balance bigint not null default 0
          )
        `;
      } catch (e) {
        // 다른 워커에서 이미 생성했거나 권한 문제인 경우 — 조회 단계에서 다시 한 번 분기
      }

      try {
        const balRows = (await sql`
          select balance
          from wallet_balances
          where user_id = ${userIdText}
          limit 1
        `) as unknown as { balance: number | string | bigint }[];

        if (balRows && balRows.length > 0) {
          points = toNonNegativeInt(balRows[0].balance);
        }
      } catch (e) {
        if (!isMissingTable(e)) {
          throw e;
        }
        // wallet_balances 테이블이 아직 없으면 기본값(0) 유지
      }
    }

    const took = Math.round(performance.now() - t0);

    return withCORS(
      json(
        {
          ok: true,
          user: {
            ...user,
            stats: {
              points,
              exp,
              level,
              tickets,
            },
          },
        },
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
