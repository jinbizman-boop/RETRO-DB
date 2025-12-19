// functions/api/_utils/accountSnapshot.ts
import { getSql } from "./db";

function toNum(v: any, fallback = 0) {
  if (v == null) return fallback;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// exp 기준 레벨(프로젝트 기존 me.ts 계산과 동일하게 맞추는 걸 권장)
export function computeLevelFromExp(exp: number): number {
  const e = Math.max(0, Math.floor(exp || 0));
  return Math.floor(e / 1000) + 1;
}

export function computeXpCap(level: number): number {
  const lv = Math.max(1, Math.floor(level || 1));
  return lv * 1000;
}

export async function loadAccountSnapshot(env: any, userIdUuid: string) {
  const sql = getSql(env);

  const [statsRow] = await sql/* sql */`
    select coins, tickets, exp, games_played
    from user_stats
    where user_id = ${userIdUuid}::uuid
    limit 1
  `;

  const [walletRow] = await sql/* sql */`
    select points, tickets
    from user_wallet
    where user_id = ${userIdUuid}::uuid
    limit 1
  `;

  const coins = toNum(statsRow?.coins, 0);
  const exp = toNum(statsRow?.exp, 0);
  const statsTickets = toNum(statsRow?.tickets, 0);
  const gamesPlayed = toNum(statsRow?.games_played, 0);

  const points = toNum(walletRow?.points, coins);               // 없으면 coins로 fallback
  const walletTickets = toNum(walletRow?.tickets, statsTickets); // 없으면 statsTickets로 fallback

  const level = computeLevelFromExp(exp);
  const xpCap = computeXpCap(level);

  const wallet = {
    points,
    tickets: walletTickets,
    exp,
    plays: gamesPlayed,
    level,
    xpCap,
  };

  const stats = {
    points: coins,
    exp,
    tickets: statsTickets,
    gamesPlayed,
    level,
    xpCap,
  };

  return {
    wallet,
    stats,
    snapshot: { wallet, stats },
  };
}
