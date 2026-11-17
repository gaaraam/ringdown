import type { CustomerSource } from "../sim/customer.ts";

/** One outstanding prompt: duplicate /say requests cannot leak into the next turn. */
export class HumanCustomer implements CustomerSource {
  readonly spec = { speechRate: 7 };
  private resolve?: (text: string) => void;
  private reject?: (error: Error) => void;
  constructor(private readonly waiting: () => void) {}
  reply(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.waiting();
    });
  }
  say(text: string): boolean {
    const resolve = this.resolve;
    if (!resolve) return false;
    this.resolve = undefined;
    this.reject = undefined;
    resolve(text);
    return true;
  }
  cancel() {
    this.reject?.(new Error("통화를 닫았어요."));
    this.resolve = undefined;
    this.reject = undefined;
  }
  responseDelay() { return 300; }
  interruption() { return undefined; }
}
