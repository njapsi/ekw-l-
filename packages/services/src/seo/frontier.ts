/**
 * The crawl frontier (docs/SEO-ENGINE.md §1 "Frontier"). Holds URLs still to
 * fetch, ordered by depth then discovery order, with a seen-set for dedupe and
 * a hard `maxPages` bound: once `maxPages` URLs have been *admitted*, discovery
 * stops and in-flight work drains.
 *
 * This is the in-memory implementation used by a single-process crawl
 * (ADR-0018). The `Frontier` interface is what a Redis-backed distributed
 * frontier would implement.
 */
export interface FrontierItem {
  normalizedUrl: string;
  depth: number;
  discoveredVia: 'seed' | 'link' | 'sitemap' | 'canonical' | 'redirect';
  order: number;
}

export interface Frontier {
  /** Try to admit a URL. Returns false if seen, out of budget, or over depth. */
  add(url: string, depth: number, via: FrontierItem['discoveredVia']): boolean;
  /** Next item to crawl, or undefined when drained. */
  next(): FrontierItem | undefined;
  has(url: string): boolean;
  readonly admitted: number;
  readonly pending: number;
  readonly seenCount: number;
  atCapacity(): boolean;
}

export class MemoryFrontier implements Frontier {
  private readonly seen = new Set<string>();
  private readonly heap: FrontierItem[] = [];
  private counter = 0;
  private _admitted = 0;

  constructor(
    private readonly maxPages: number,
    private readonly maxDepth: number,
  ) {}

  add(url: string, depth: number, via: FrontierItem['discoveredVia']): boolean {
    if (this.seen.has(url)) return false;
    if (depth > this.maxDepth) {
      this.seen.add(url); // remember so we don't re-evaluate it repeatedly
      return false;
    }
    if (this._admitted >= this.maxPages) return false;
    this.seen.add(url);
    this._admitted++;
    this.heap.push({ normalizedUrl: url, depth, discoveredVia: via, order: this.counter++ });
    return true;
  }

  next(): FrontierItem | undefined {
    if (this.heap.length === 0) return undefined;
    let bestIdx = 0;
    for (let i = 1; i < this.heap.length; i++) {
      const a = this.heap[i]!;
      const b = this.heap[bestIdx]!;
      if (a.depth < b.depth || (a.depth === b.depth && a.order < b.order)) bestIdx = i;
    }
    const [item] = this.heap.splice(bestIdx, 1);
    return item;
  }

  has(url: string): boolean {
    return this.seen.has(url);
  }

  get admitted(): number {
    return this._admitted;
  }
  get pending(): number {
    return this.heap.length;
  }
  get seenCount(): number {
    return this.seen.size;
  }
  atCapacity(): boolean {
    return this._admitted >= this.maxPages;
  }
}
