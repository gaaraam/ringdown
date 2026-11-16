import type { KbDoc } from "../pack/load.ts";

export interface Chunk { chunkId: string; text: string; score: number }
/** 공백 단어와 단어 내부 바이그램을 함께 써서 한국어 조사 차이를 완화한다. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((word) =>
    [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))]);
}
export class Knowledge {
  readonly chunks: Chunk[];
  private readonly tokens: string[][];
  constructor(docs: KbDoc[]) {
    this.chunks = docs.flatMap((doc) => {
      const parts = doc.text.split(/^## /m);
      return parts.flatMap((part, i) => {
        const newline = part.indexOf("\n");
        const heading = i === 0 ? "intro" : (newline < 0 ? part : part.slice(0, newline)).trim();
        const text = (i === 0 ? part : part.slice(newline + 1)).trim();
        return text ? [{ chunkId: `${doc.file}#${heading}`, text, score: 0 }] : [];
      });
    });
    this.tokens = this.chunks.map((c) => tokenize(c.text));
  }
  search(query: string, limit = 3): Chunk[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.tokens.length;
    const average = this.tokens.reduce((sum, ts) => sum + ts.length, 0) / (n || 1) || 1;
    return this.chunks.map((chunk, i) => {
      const ts = this.tokens[i]!;
      const score = terms.reduce((sum, term) => {
        const frequency = ts.filter((t) => t === term).length;
        const df = this.tokens.filter((tokens) => tokens.includes(term)).length;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        return sum + idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * ts.length / average));
      }, 0);
      return { ...chunk, score };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, limit);
  }
}
