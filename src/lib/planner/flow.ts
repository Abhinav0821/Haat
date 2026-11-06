/**
 * Generic network-flow engine: Dinic maximum flow and successive-shortest-path
 * minimum-cost flow (SPFA). Standard algorithms; integer capacities give integer flows.
 */

export const INF = 1_000_000_000;

export class FlowGraph {
  readonly n: number;
  private head: number[];
  private to: number[] = [];
  private cap: number[] = [];
  private cost: number[] = [];
  private nxt: number[] = [];

  constructor(n: number) {
    this.n = n;
    this.head = new Array(n).fill(-1);
  }

  /** Adds u→v; returns the edge id (its reverse is id ^ 1). */
  addEdge(u: number, v: number, cap: number, cost = 0): number {
    const e = this.to.length;
    this.to.push(v, u);
    this.cap.push(cap, 0);
    this.cost.push(cost, -cost);
    this.nxt.push(this.head[u], this.head[v]);
    this.head[u] = e;
    this.head[v] = e + 1;
    return e;
  }

  /** Flow currently on forward edge e. */
  flowOn(e: number): number {
    return this.cap[e ^ 1];
  }

  maxflow(s: number, t: number, limit = INF): number {
    let total = 0;
    const level = new Array<number>(this.n);
    const it = new Array<number>(this.n);
    const bfs = () => {
      level.fill(-1);
      level[s] = 0;
      const q = [s];
      for (let i = 0; i < q.length; i++) {
        const u = q[i];
        for (let e = this.head[u]; e !== -1; e = this.nxt[e]) {
          if (this.cap[e] > 0 && level[this.to[e]] < 0) {
            level[this.to[e]] = level[u] + 1;
            q.push(this.to[e]);
          }
        }
      }
      return level[t] >= 0;
    };
    const dfs = (u: number, f: number): number => {
      if (u === t) return f;
      for (; it[u] !== -1; it[u] = this.nxt[it[u]]) {
        const e = it[u];
        const v = this.to[e];
        if (this.cap[e] > 0 && level[v] === level[u] + 1) {
          const d = dfs(v, Math.min(f, this.cap[e]));
          if (d > 0) {
            this.cap[e] -= d;
            this.cap[e ^ 1] += d;
            return d;
          }
        }
      }
      return 0;
    };
    while (total < limit && bfs()) {
      for (let i = 0; i < this.n; i++) it[i] = this.head[i];
      let f: number;
      while (total < limit && (f = dfs(s, limit - total)) > 0) total += f;
    }
    return total;
  }

  /** Sends up to `limit` units s→t at minimum cost. Requires no negative cycle in the residual graph. */
  minCostFlow(s: number, t: number, limit: number): { flow: number; cost: number } {
    let flow = 0;
    let cost = 0;
    const dist = new Array<number>(this.n);
    const inq = new Array<boolean>(this.n);
    const prevE = new Array<number>(this.n);
    while (flow < limit) {
      dist.fill(Infinity);
      inq.fill(false);
      prevE.fill(-1);
      dist[s] = 0;
      const q = [s];
      inq[s] = true;
      for (let i = 0; i < q.length; i++) {
        const u = q[i];
        inq[u] = false;
        for (let e = this.head[u]; e !== -1; e = this.nxt[e]) {
          if (this.cap[e] <= 0) continue;
          const v = this.to[e];
          const nd = dist[u] + this.cost[e];
          if (nd < dist[v]) {
            dist[v] = nd;
            prevE[v] = e;
            if (!inq[v]) {
              inq[v] = true;
              q.push(v);
            }
          }
        }
      }
      if (dist[t] === Infinity) break;
      let push = limit - flow;
      for (let v = t; v !== s; v = this.to[prevE[v] ^ 1]) push = Math.min(push, this.cap[prevE[v]]);
      for (let v = t; v !== s; v = this.to[prevE[v] ^ 1]) {
        this.cap[prevE[v]] -= push;
        this.cap[prevE[v] ^ 1] += push;
      }
      flow += push;
      cost += push * dist[t];
    }
    return { flow, cost };
  }
}
