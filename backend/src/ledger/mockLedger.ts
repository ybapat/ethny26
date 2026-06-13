/**
 * mockLedger.ts — an in-memory LedgerClient for tests/demo.
 *
 * It mimics the on-ledger effects of the MatchedPair choices so the trigger loop
 * can be exercised end-to-end with no Canton participant:
 *   - applyFunding   mutates accruedFundingLong + lastFundingTime
 *   - liquidate      removes the pair from the active set
 *   - settleClose    removes the pair from the active set
 * Every call is also recorded in `actions` for assertions.
 *
 * Swap this for a real @c7-digital/ledger client (same LedgerClient shape) to go live.
 */
import type {
  LedgerClient,
  MatchedPair,
  OraclePrice,
  ApplyFundingArgs,
  LiquidateArgs,
  SettleCloseArgs,
  CloseRequest,
} from "../types.ts";

export type LedgerAction =
  | { kind: "updateOraclePrice"; price: OraclePrice }
  | { kind: "applyFunding"; contractId: string; args: ApplyFundingArgs }
  | { kind: "liquidate"; contractId: string; args: LiquidateArgs }
  | { kind: "settleClose"; contractId: string; args: SettleCloseArgs };

const clone = (p: MatchedPair): MatchedPair => ({
  ...p,
  long: { ...p.long },
  short: { ...p.short },
});

export class MockLedger implements LedgerClient {
  private pairs: Map<string, MatchedPair> = new Map();
  private closeRequests: Map<string, CloseRequest> = new Map();
  /** Append-only log of everything the loop did. */
  public readonly actions: LedgerAction[] = [];
  /** Latest price pushed per feed (last write wins). */
  public readonly prices: Map<string, OraclePrice> = new Map();

  constructor(initial: MatchedPair[] = []) {
    for (const p of initial) this.pairs.set(p.contractId, clone(p));
  }

  /** Test helper: add/replace a pair in the active set. */
  seed(pair: MatchedPair): void {
    this.pairs.set(pair.contractId, clone(pair));
  }

  /** Test helper: register a pending close request for a pair. */
  seedCloseRequest(req: CloseRequest): void {
    this.closeRequests.set(req.contractId, { ...req });
  }

  /** Test helper: read current state of a pair (or undefined if archived). */
  peek(contractId: string): MatchedPair | undefined {
    const p = this.pairs.get(contractId);
    return p ? clone(p) : undefined;
  }

  async getActiveMatchedPairs(): Promise<MatchedPair[]> {
    return Array.from(this.pairs.values()).map(clone);
  }

  async getCloseRequests(): Promise<CloseRequest[]> {
    return Array.from(this.closeRequests.values()).map((c) => ({ ...c }));
  }

  async updateOraclePrice(price: OraclePrice): Promise<void> {
    this.prices.set(price.feedId, { ...price });
    this.actions.push({ kind: "updateOraclePrice", price: { ...price } });
  }

  async applyFunding(contractId: string, args: ApplyFundingArgs): Promise<void> {
    const p = this.pairs.get(contractId);
    if (!p) throw new Error(`applyFunding: unknown pair ${contractId}`);
    // Positive fundingPayment => long pays short => long's net funding decreases.
    p.accruedFundingLong = round8(p.accruedFundingLong - args.fundingPayment);
    p.lastFundingTime = args.at;
    this.actions.push({ kind: "applyFunding", contractId, args: { ...args } });
  }

  async liquidate(contractId: string, args: LiquidateArgs): Promise<void> {
    if (!this.pairs.has(contractId)) throw new Error(`liquidate: unknown pair ${contractId}`);
    this.pairs.delete(contractId);
    this.actions.push({ kind: "liquidate", contractId, args: { ...args } });
  }

  async settleClose(contractId: string, args: SettleCloseArgs): Promise<void> {
    if (!this.pairs.has(contractId)) throw new Error(`settleClose: unknown pair ${contractId}`);
    this.pairs.delete(contractId);
    // Consume any close request(s) targeting this pair.
    for (const [cid, req] of this.closeRequests) {
      if (req.matchedPairContractId === contractId) this.closeRequests.delete(cid);
    }
    this.actions.push({ kind: "settleClose", contractId, args: { ...args } });
  }

  /** Convenience filters for assertions. */
  actionsOfKind<K extends LedgerAction["kind"]>(kind: K): Extract<LedgerAction, { kind: K }>[] {
    return this.actions.filter((a): a is Extract<LedgerAction, { kind: K }> => a.kind === kind);
  }
}

/** Local copy of round8 to avoid a cross-module import in the mock. */
function round8(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e8) / 1e8;
}
