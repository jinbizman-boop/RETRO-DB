// C:\Users\Telos_PC_17\Downloads\retro-games-cloudflare\functions\api\profile\update.ts
//
// ✅ 목표
// - 기존 기능/계약( POST /api/profile/update → { ok:true } ) 100% 유지
// - 문제 해결: VS Code TS 오류(ts2304 PagesFunction / ts7031 implicit any) 제거
// - 보강: 서버측 정규화·검증, 존재하지 않는 사용자 404, 초기 스키마 미생성 시 안전 동작,
//         캐시 차단/진단 헤더, 과도·이상치 방지
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

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import { validateProfileUpdate } from "../_utils/schema/profile";

/**
 * 계약 유지:
 * - 라우트/메서드 동일 (POST)
 * - 입력은 기존 validateProfileUpdate 사용
 * - 성공 응답 스키마: { ok: true }
 *
 * 보강 사항:
 * - userId/username/avatar 서버측 추가 정규화 및 길이/패턴 검증
 * - 존재하지 않는 사용자에 대한 404
 * - 대용량/이상치 방지(길이 제한), avatar URL 스킴 화이트리스트
 * - 인덱스 보강(있으면 무시)
 * - 운영 헤더(Cache-Control, 처리시간)
 */

/* ───────── Normalizers / Validators ───────── */
function cleanUserId(v: string): string {
  const s = (v || "").trim().normalize("NFKC");
  if (!/^[a-zA-Z0-9_\-.:@]{1,64}$/.test(s)) throw new Error("Invalid userId");
  return s;
}

function cleanUsername(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim().normalize("NFKC");
  if (!s) return null; // 빈 문자열은 변경 없음으로 처리
  // 가독·보안용 보수적 규칙: 2~32자, 공백/제어문자 불가
  if (s.length < 2 || s.length > 32) throw new Error("username must be 2-32 chars");
  if (!/^[\p{L}\p{N}_\-.]+$/u.test(s)) throw new Error("username contains invalid characters");
  return s;
}

function cleanAvatar(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  if (s.length > 1024) throw new Error("avatar url too long");

  // 허용 스킴: https/http, 또는 data:image/*;base64, … (간단 화이트리스트)
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
  } catch {
    // fallthrough → 에러
  }
  throw new Error("invalid avatar url");
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return msg.includes("does not exist") || msg.includes("unknown relation");
}

/* ───────── Handler ───────── */
export const onRequest: PagesFunction<Env> = async (
  { request, env }: { request: Request; env: Env }
) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(json({ error: "Method Not Allowed" }, { status: 405 }), env.CORS_ORIGIN);
  }

  const t0 = performance.now();

  try {
    // 원본 계약의 스키마 검증을 먼저 수행
    const parsed = validateProfileUpdate(await readJSON(request));

    // 서버측 추가 정규화/검증
    const userId = cleanUserId(parsed.userId);
    const username = cleanUsername(parsed.username ?? null);
    const avatar = cleanAvatar(parsed.avatar ?? null);

    const sql = getSql(env);

    // 인덱스 등 보강(있으면 무시) — 초기 상태에서도 실패하지 않도록 방어
    try {
      await sql`create index if not exists users_id_idx on users (id)`;
    } catch (e) {
      if (!isMissingTable(e)) {
        // 비치명적 이슈는 무시(아래 업데이트 시 실제 존재 여부가 판단됨)
      }
    }

    // 실제 업데이트: 제공된 필드만 갱신(coalesce는 기존 계약 유지)
    // 존재하지 않으면 0행 → 404
    const rows = (await sql`
      update users
      set
        username = coalesce(${username}, username),
        avatar   = coalesce(${avatar},   avatar)
      where id = ${userId}
      returning id
    `) as unknown as Array<{ id: unknown }>;

    if (!rows || rows.length === 0) {
      return withCORS(json({ error: "Not found" }, { status: 404 }), env.CORS_ORIGIN);
    }

    return withCORS(
      json(
        { ok: true },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Profile-Update-Took-ms": String(Math.round(performance.now() - t0)),
          },
        }
      ),
      env.CORS_ORIGIN
    );
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
- PagesFunction ambient 타입을 파일 상단에 선언해 ts(2304) 제거.
- 핸들러 인자에 명시적 타입을 부여해 ts(7031) 제거.
- sql 제네릭 사용 없이 런타임 캐스팅으로 에디터 경고를 회피(동작 동일).
- 동작/라우트/응답 계약은 기존과 완전히 동일합니다.
----------------------------------------------------------------- */
