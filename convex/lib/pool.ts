// Pooled demand: bounties for the same task from different businesses, added up.
//   B_k = sum of b_i over the bounties i in cluster k (same taskKey)
// Plain code, so the totals on the page are exact.

export type PoolRow = { requestId: string; taskKey?: string; pledged: number; goal: number };
export type Pool = { taskKey: string; businesses: number; bounties: number; pledged: number; goal: number };

export function poolByTask(rows: PoolRow[]): Map<string, Pool> {
  const pools = new Map<string, Pool & { ids: Set<string> }>();
  for (const r of rows) {
    if (!r.taskKey) continue;
    const p = pools.get(r.taskKey) ?? { taskKey: r.taskKey, businesses: 0, bounties: 0, pledged: 0, goal: 0, ids: new Set() };
    p.ids.add(r.requestId);
    p.bounties += 1;
    p.pledged += Math.max(0, r.pledged);
    p.goal += Math.max(0, r.goal);
    pools.set(r.taskKey, p);
  }
  return new Map([...pools].map(([k, { ids, ...p }]) => [k, { ...p, businesses: ids.size }]));
}
