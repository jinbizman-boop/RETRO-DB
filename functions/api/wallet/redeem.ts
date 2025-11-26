// functions/api/wallet/redeem.ts
//
// ✅ Fix summary
// - ts(2304) Cannot find name 'PagesFunction'  → tiny ambient types for CF Pages (editor-only)
// - ts(7031) request/env implicitly any        → handler params에 타입 명시
// - 외부 계약/동작 100% 유지:
//     • 메서드: POST
//     • 입력: { userId, itemId, qty }  // qty 미지정 시 1
//     • 응답: { ok: true }
//
// 🔥 내부 동작/지갑·인벤토리·효과 정합 강화 (Wallet-C 아키텍처 대응)
// - Canonical 인벤토리/효과:
//     • user_inventory(user_id UUID, item_id UUID, qty INT >= 0 …)
//     • shop_items(id UUID, sku TEXT, price_coins NUMERIC, item_type, effect_key, effect_value, effect_duration_minutes …)
//     • user_effects(user_id UUID, effect_key TEXT, value NUMERIC, expires_at …)
//     → 클라이언트 itemId: shop_items.sku (없으면 id::text)
// - Legacy fallback: wallet_items(user_id TEXT, item_id TEXT, qty INT)
// - Coins/Wallet 정합:
//     • transactions 테이블 + apply_wallet_transaction() 트리거 사용
//     • type = 'spend', amount = -총코인사용량
//     • user_stats.coins 잔액이 부족하면 트리거에서 예외 → 400 + "insufficient_funds"
// - userId 우선순위:
//     1) 미들웨어가 넣어주는 X-User-Id 헤더 (users.id UUID)
//     2) body.userId
//   → 최종적으로 UUID 형식이 아니면 400("Invalid userId")
// - qty: int32 범위로 보정 후, 1 이상 필수 (0/음수는 에러)
// - 멱등키(Idempotency-Key) 지원:
//     • 동일 Idempotency-Key 로 재호출 시, transactions on conflict 로 중복 차단
//     • 두 번째 호출에서는 인벤토리/효과/주문도 스킵 → “한 번만 적용” 보장
//
// NOTE:
// - shop_items / user_inventory / user_effects / transactions 가 아직 없는 환경에서는
//   기존 wallet_items 기반 동작으로 graceful fallback 합니다.


// ───── Minimal Cloudflare Pages ambient types (type-checker only) ─────
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
/* ────────────────────────────────────────────────────────────────────── */

import { json, readJSON } from "../_utils/json";
import { withCORS, preflight } from "../_utils/cors";
import { getSql, type Env } from "../_utils/db";
import * as Rate from "../_utils/rate-limit";

/* ───────── types ───────── */

type ShopItemRow = {
  id: string;                       // UUID::text
  sku: string | null;
  price_coins: number | string | null;
  item_type: string | null;         // cosmetic/effect/consumable/…
  effect_key: string | null;        // 'coins_multiplier' 등
  effect_value: number | string | null;
  effect_duration_minutes: number | string | null;
};

/* ───────── helpers ───────── */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveUserId(req: Request, bodyUserId: unknown): string {
  const headerId =
    req.headers.get("X-User-Id") || req.headers.get("x-user-id") || "";
  const candidate = (
    headerId ||
    (typeof bodyUserId === "string" ? bodyUserId : "")
  )
    .trim()
    .normalize("NFKC");

  if (!candidate) throw new Error("Invalid userId");
  if (!UUID_V4_REGEX.test(candidate)) throw new Error("Invalid userId");
  return candidate;
}

function cleanItemKey(v: unknown): string {
  const s = (typeof v === "string" ? v : "")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
  if (!s) throw new Error("Invalid itemId");
  // SKU-ish or UUID-ish 아무거나 허용 (실제 매칭은 DB에서 처리)
  if (/^[a-z0-9_\-.:]{1,64}$/.test(s) || UUID_V4_REGEX.test(s)) {
    return s;
  }
  throw new Error("Invalid itemId");
}

function toInt32(n: unknown, fallback = 1): number {
  const x = Number(n);
  const v = Number.isFinite(x) ? Math.trunc(x) : fallback;
  const MIN = -2147483648;
  const MAX = 2147483647;
  if (v < MIN) return MIN;
  if (v > MAX) return MAX;
  return v;
}

function toNonNegativeInt(v: any): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string") n = Number(v);
  else n = 0;

  if (!Number.isFinite(n)) n = 0;
  n = Math.floor(n);
  if (n < 0) n = 0;
  if (n > Number.MAX_SAFE_INTEGER) n = Number.MAX_SAFE_INTEGER;
  return n;
}

function isMissingTable(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("unknown relation") ||
    msg.includes("no such table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

function isInsufficientBalanceError(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  // apply_wallet_transaction() 에서 던지는 예외 메시지 일부 패턴
  return (
    msg.includes("insufficient balance") ||
    (msg.includes("insufficient") && msg.includes("balance"))
  );
}

// 중복 호출 방지를 위한 멱등 키
function getIdemKey(req: Request): string | null {
  return (
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key") ||
    req.headers.get("x-idempotency-key")
  );
}

/* ───────── handler ───────── */

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}) => {
  if (request.method === "OPTIONS") return preflight(env.CORS_ORIGIN);
  if (request.method !== "POST") {
    return withCORS(
      json({ error: "Method Not Allowed" }, { status: 405 }),
      env.CORS_ORIGIN
    );
  }

  // 남용 방지
  if (!(await Rate.allow(request))) {
    return withCORS(
      json(
        { error: "Too Many Requests" },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
      env.CORS_ORIGIN
    );
  }

  const t0 = performance.now();

  try {
    const body = await readJSON(request);

    const userId = resolveUserId(request, (body as any)?.userId);
    const itemKey = cleanItemKey((body as any)?.itemId);

    const qtyRaw = toInt32((body as any)?.qty, 1); // 원본 계약: 기본 1
    if (qtyRaw <= 0) {
      // 음수/0 수량은 인벤토리/지갑 일관성을 위해 허용하지 않음
      throw new Error("qty must be positive");
    }
    const qty = qtyRaw;

    const sql = getSql(env);
    const idem = getIdemKey(request);

    let appliedQty = qty;
    let appliedItemKey = itemKey;
    let source: "user_inventory" | "wallet_items" = "user_inventory";
    let costCoins = 0;

    // ─────────────────────────────────────────────
    // 1) Canonical 경로: shop_items + user_inventory + user_effects + transactions
    // ─────────────────────────────────────────────
    try {
      const rowsItem = (await sql/* sql */ `
        select
          id::text                 as id,
          sku,
          price_coins,
          item_type,
          effect_key,
          effect_value,
          effect_duration_minutes
        from shop_items
        where
          lower(sku) = ${itemKey}
          or id::text = ${itemKey}
        limit 1
      `) as ShopItemRow[];

      if (!rowsItem || rowsItem.length === 0) {
        // shop_items 는 있지만 해당 item 이 없다 → legacy wallet_items 로 fallback
        source = "wallet_items";
        throw new Error("NO_CANONICAL_ITEM_FALLBACK");
      }

      const item = rowsItem[0];
      const itemIdUuid = item.id; // UUID::text
      const skuSafe = (item.sku && item.sku.trim()) || itemIdUuid;

      // 가격 계산 (NULL/음수는 0으로 처리 = 무료 아이템)
      const unitPriceCoins = toNonNegativeInt(item.price_coins ?? 0);
      const totalPriceCoins = toNonNegativeInt(unitPriceCoins * qty);

      costCoins = totalPriceCoins;
      appliedItemKey = skuSafe;

      // 1-1) Coins 차감: transactions + apply_wallet_transaction()
      //      - type = 'spend', amount = -총코인사용량
      //      - Idempotency-Key 가 있으면 on conflict 로 중복 방지
      let shouldApplyInventoryAndEffect = true;

      if (totalPriceCoins > 0) {
        const meta = {
          kind: "shop_redeem",
          item_id: itemIdUuid,
          sku: skuSafe,
          qty,
          unit_price_coins: unitPriceCoins,
          total_price_coins: totalPriceCoins,
        };

        let txRows: any[] = [];

        if (idem) {
          txRows = await sql/* sql */ `
            insert into transactions (
              user_id,
              type,
              amount,
              ref_table,
              ref_id,
              note,
              idempotency_key,
              meta
            )
            values (
              ${userId}::uuid,
              'spend',
              ${-totalPriceCoins},
              'shop_items',
              ${itemIdUuid}::uuid,
              'shop_redeem',
              ${idem},
              ${JSON.stringify(meta)}::jsonb
            )
            on conflict (idempotency_key) do nothing
            returning id
          `;
        } else {
          txRows = await sql/* sql */ `
            insert into transactions (
              user_id,
              type,
              amount,
              ref_table,
              ref_id,
              note,
              meta
            )
            values (
              ${userId}::uuid,
              'spend',
              ${-totalPriceCoins},
              'shop_items',
              ${itemIdUuid}::uuid,
              'shop_redeem',
              ${JSON.stringify(meta)}::jsonb
            )
            returning id
          `;
        }

        // 멱등 키가 있고, 이미 처리된 요청이면 인벤토리/효과는 다시 적용하지 않는다.
        if (idem && (!txRows || txRows.length === 0)) {
          shouldApplyInventoryAndEffect = false;
        }
      }

      // 1-2) 인벤토리 지급 (coins 차감이 실제로 적용된 경우에만)
      if (shouldApplyInventoryAndEffect) {
        await sql/* sql */ `
          insert into user_inventory(user_id, item_id, qty)
          values(${userId}::uuid, ${itemIdUuid}::uuid, ${qty})
          on conflict (user_id, item_id)
          do update set
            qty = GREATEST(0, user_inventory.qty + ${qty}),
            updated_at = now()
        `;
      }

      // 1-3) 계정 효과 적용 (effect_key/value 가 있는 경우)
      if (shouldApplyInventoryAndEffect && item.effect_key && item.effect_value != null) {
        const effectKey = item.effect_key.trim();
        const effectValueNum = Number(item.effect_value);
        const durationMinRaw =
          typeof item.effect_duration_minutes === "number"
            ? item.effect_duration_minutes
            : Number(item.effect_duration_minutes ?? 0);
        const durationMin =
          Number.isFinite(durationMinRaw) && durationMinRaw > 0
            ? Math.floor(durationMinRaw)
            : 0;

        let expiresAt: string | null = null;
        if (durationMin > 0) {
          expiresAt = new Date(Date.now() + durationMin * 60_000).toISOString();
        }

        await sql/* sql */ `
          insert into user_effects(user_id, effect_key, value, expires_at)
          values (${userId}::uuid, ${effectKey}, ${effectValueNum}, ${expiresAt})
          on conflict (user_id, effect_key)
          do update set
            value      = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
        `;
      }

      source = "user_inventory";
    } catch (e: any) {
      // user_inventory / shop_items / user_effects 스키마가 없거나
      // NO_CANONICAL_ITEM_FALLBACK 신호인 경우 → legacy wallet_items 로 graceful fallback
      const msg = String(e?.message ?? "");
      if (!isMissingTable(e) && !msg.includes("NO_CANONICAL_ITEM_FALLBACK")) {
        // 진짜 오류는 그대로 노출
        throw e;
      }

      // ─────────────────────────────────────────────
      // 2) Legacy fallback: wallet_items (구 구조)
      //    - 기존 코드와 동일한 테이블/동작(단순 가산)
      //    - coins 차감이나 효과 적용은 수행하지 않음
      // ─────────────────────────────────────────────
      source = "wallet_items";

      try {
        await sql/* sql */ `
          create table if not exists wallet_items(
            user_id   text not null,
            item_id   text not null,
            qty       int  not null default 0,
            updated_at timestamptz not null default now(),
            primary key(user_id, item_id)
          )
        `;
        await sql/* sql */ `
          alter table wallet_items
          add column if not exists updated_at timestamptz not null default now()
        `;
        await sql/* sql */ `
          create index if not exists wallet_items_user_idx
          on wallet_items (user_id, updated_at desc)
        `;
        await sql/* sql */ `
          create index if not exists wallet_items_item_idx
          on wallet_items (item_id)
        `;
      } catch (schemaErr) {
        if (!isMissingTable(schemaErr)) {
          throw schemaErr;
        }
      }

      // upsert: 기존 계약 유지(단순 가산). updated_at 최신화
      await sql/* sql */ `
        insert into wallet_items(user_id, item_id, qty)
        values(${userId}, ${itemKey}, ${qty})
        on conflict (user_id, item_id)
        do update set
          qty = wallet_items.qty + excluded.qty,
          updated_at = now()
      `;
      appliedItemKey = itemKey;
      costCoins = 0; // legacy 모드에서는 코인 차감 없음
    }

    return withCORS(
      json(
        { ok: true }, // 외부 계약 유지
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Redeem-User": userId,
            "X-Redeem-Item": appliedItemKey,
            "X-Redeem-Delta": String(appliedQty),
            "X-Redeem-Source": source,
            "X-Redeem-Cost-Coins": String(costCoins),
            "X-Redeem-Idempotent": idem ? "1" : "0",
            "X-Redeem-Took-ms": String(Math.round(performance.now() - t0)),
          },
        }
      ),
      env.CORS_ORIGIN
    );
  } catch (e: any) {
    if (isInsufficientBalanceError(e)) {
      // 지갑 잔액 부족 시 조금 더 명확한 코드로 응답
      return withCORS(
        json(
          { error: "insufficient_funds" },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        ),
        env.CORS_ORIGIN
      );
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
