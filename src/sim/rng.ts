/** 시드 고정 난수. 같은 시드 = 같은 장애·같은 페르소나 행동 */
export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = typeof seed === "number" ? seed >>> 0 : hash(seed);
    if (this.s === 0) this.s = 0x9e3779b9;
  }
  /** [0, 1) — mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  between(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  /** 로그정규 분포 지연: p50과 p95로 지정 */
  latency(p50: number, p95: number): number {
    const mu = Math.log(p50);
    const sigma = (Math.log(p95) - mu) / 1.6449;
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.round(Math.exp(mu + sigma * z));
  }
  /** 하위 스트림 (호출 순서가 바뀌어도 다른 스트림에 영향이 없게) */
  fork(label: string): Rng {
    return new Rng(hash(`${this.s}:${label}`));
  }
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
