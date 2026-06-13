/**
 * cantonLedger.ts — REAL Canton JSON Ledger API v2 implementation of LedgerClient.
 *
 * This drops in for MockLedger to go live against a Canton participant's JSON
 * Ledger API v2 (CANTON-RWA.md §1). It speaks the v2 endpoints:
 *   - GET  /v2/state/ledger-end          → { offset }
 *   - POST /v2/state/active-contracts    → created events (envelope varies by build)
 *   - POST /v2/commands/submit-and-wait  → exercise choices
 *
 * Auth (CANTON-RWA.md §1): local sandbox = none; secured/DevNet = Bearer JWT.
 * `actAs`/`readAs` are COMMAND-BODY fields (NOT JWT claims) in v2.
 * `templateId` uses the package-NAME format "pkg-name:Module:Template".
 *
 * Cross-checked against Person 2's matching-engine/src/ledger.cpp for endpoint
 * paths, the exercise-command JSON shape, and the active-contracts response
 * handling (single-object `activeContracts` array vs. NDJSON `{created:{...}}`).
 *
 * Node native TypeScript constraints: erasable-syntax-only (no enum/namespace/
 * param-properties), relative imports end in `.ts`, Node built-ins only (global
 * fetch), ESM. The PURE helpers below are exported for unit testing w/o network.
 *
 * Field/envelope shapes that depend on Person 1's actual DAR are flagged with
 * `// CONFIRM with Person 1`.
 */
import type {
  LedgerClient,
  MatchedPair,
  CloseRequest,
  OraclePrice,
  ApplyFundingArgs,
  LiquidateArgs,
  SettleCloseArgs,
  Side,
} from "../types.ts";

/* ====================================================================== *
 * Config
 * ====================================================================== */

/** Template ids in package-name format "pkg-name:Module:Template". */
export interface CantonTemplateIds {
  matchedPair: string;
  closeRequest: string;
  /** MockOraclePrice contract template id. */
  oraclePrice: string;
  /** Optional Chainlink Verifier template id (on-ledger Verify path). */
  verifier?: string;
}

/** Choice names. Defaults match DEX.md §11 / CANTON-RWA.md §3 conventions. */
export interface CantonChoices {
  applyFunding?: string;
  liquidate?: string;
  settleClose?: string;
  updateOraclePrice?: string;
  verify?: string;
}

export interface CantonLedgerOpts {
  /** e.g. "http://localhost:7575" — no trailing slash required. */
  baseUrl: string;
  /** Optional JWT; if set, sent as `Authorization: Bearer <token>`. */
  authToken?: string;
  userId: string;
  /** [venueParty]. */
  actAs: string[];
  readAs?: string[];
  templateIds: CantonTemplateIds;
  choices?: CantonChoices;
  /** Price decimals if needed (default 10). */
  decimals?: number;
}

const DEFAULT_CHOICES: Required<CantonChoices> = {
  applyFunding: "ApplyFunding",
  liquidate: "Liquidate",
  settleClose: "SettleClose",
  updateOraclePrice: "UpdatePrice",
  verify: "Verify",
};

/* ====================================================================== *
 * PURE helpers (exported + unit-tested, no network)
 * ====================================================================== */

/**
 * number → Daml `Decimal` string. Daml Decimal has up to 10 fractional digits.
 * We render with `dp` decimals (default 10) then trim trailing zeros (keeping at
 * least one fractional digit so it's always an unambiguous decimal literal).
 */
export function decToString(n: number, dp: number = 10): string {
  if (!Number.isFinite(n)) {
    throw new Error(`decToString: non-finite number ${n}`);
  }
  // toFixed handles rounding to dp; avoids scientific notation for typical magnitudes.
  let s = n.toFixed(dp);
  if (s.indexOf(".") >= 0) {
    // Trim trailing zeros, but keep one digit after the decimal point.
    s = s.replace(/0+$/, "");
    if (s.endsWith(".")) s += "0";
  } else {
    s += ".0";
  }
  // Normalise "-0.0" → "0.0".
  if (s === "-0.0") s = "0.0";
  return s;
}

/** Daml Decimal string (or number) → number. */
export function parseDecimal(s: string | number): number {
  if (typeof s === "number") return s;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`parseDecimal: not a number "${s}"`);
  return n;
}

/**
 * unix seconds → ISO-8601 UTC `"YYYY-MM-DDTHH:MM:SSZ"` (Daml `Time`).
 * Drops sub-second precision (Daml Time is microsecond-precise but the engine
 * works in whole seconds).
 */
export function unixToIso(seconds: number): string {
  const d = new Date(Math.round(seconds) * 1000);
  // toISOString → "YYYY-MM-DDTHH:MM:SS.sssZ"; strip the milliseconds.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** ISO-8601 `Time` → unix seconds (rounded). */
export function isoToUnix(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`isoToUnix: invalid ISO time "${iso}"`);
  return Math.round(ms / 1000);
}

/**
 * Side → Daml variant. Daml enum/variant constructors serialize on the JSON
 * Ledger API as the bare constructor name string, e.g. "Long".
 * // CONFIRM with Person 1: whether Side is a Daml enum (→ "Long") or a variant
 * // with payload (→ {"Long":{}}). We emit the bare string which is correct for
 * // a nullary enum constructor; variantToSide accepts both forms on the way in.
 */
export function sideToVariant(side: Side): string {
  return side;
}

/** Daml variant/enum value → Side. Accepts "Long" AND {"Long":{}} AND {tag:"Long"}. */
export function variantToSide(v: unknown): Side {
  if (v === "Long" || v === "Short") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Daml-LF JSON variant encoding: { "tag": "Long", "value": {} }.
    if (o.tag === "Long" || o.tag === "Short") return o.tag as Side;
    // Object-key encoding: { "Long": {} }.
    if ("Long" in o) return "Long";
    if ("Short" in o) return "Short";
    // Constructor-style: { "constructor": "Long" }.
    const ctor = o["constructor"];
    if (ctor === "Long" || ctor === "Short") return ctor as Side;
  }
  throw new Error(`variantToSide: cannot interpret side ${JSON.stringify(v)}`);
}

/** Defensive decimal field read (accepts number or Daml Decimal string). */
function dec(arg: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = arg?.[k];
    if (v !== undefined && v !== null) return parseDecimal(v);
  }
  return 0;
}

/** Defensive Time field read → unix seconds (accepts ISO string or unix number). */
function time(arg: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = arg?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "number") return Math.round(v);
    return isoToUnix(String(v));
  }
  return 0;
}

/** Defensive string field read. */
function str(arg: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = arg?.[k];
    if (v !== undefined && v !== null) return String(v);
  }
  return "";
}

/**
 * Map a Daml FLAT `MatchedPair` createArgument → our nested MatchedPair shape.
 *
 * // CONFIRM with Person 1: exact Daml field names. Assumed flat fields:
 * //   venue, longTrader, shortTrader, regulator, market, collateralInstrument,
 * //   size (Decimal), entryPrice (Decimal), longCollateralQty (Decimal),
 * //   shortCollateralQty (Decimal), accruedFundingLong (Decimal),
 * //   lastFundingTime (Time), openedAt (Time).
 * The function is defensive (accepts a few aliases + number-or-string decimals).
 */
export function parseMatchedPair(contractId: string, createArgument: any): MatchedPair {
  const a = createArgument ?? {};
  return {
    contractId,
    market: str(a, "market"),
    collateralInstrument: str(a, "collateralInstrument", "instrument"),
    size: dec(a, "size"),
    entryPrice: dec(a, "entryPrice"),
    long: {
      trader: str(a, "longTrader"),
      collateralQty: dec(a, "longCollateralQty"),
    },
    short: {
      trader: str(a, "shortTrader"),
      collateralQty: dec(a, "shortCollateralQty"),
    },
    accruedFundingLong: dec(a, "accruedFundingLong"),
    lastFundingTime: time(a, "lastFundingTime"),
    openedAt: time(a, "openedAt"),
  };
}

/**
 * Map a Daml `CloseRequest` createArgument → our CloseRequest shape.
 *
 * // CONFIRM with Person 1: exact Daml field names. Assumed:
 * //   matchedPairCid | matchedPairContractId (ContractId), closingSide (Side),
 * //   requestedAt (Time).
 */
export function parseCloseRequest(contractId: string, createArgument: any): CloseRequest {
  const a = createArgument ?? {};
  return {
    contractId,
    matchedPairContractId: str(a, "matchedPairCid", "matchedPairContractId", "matchedPair"),
    closingSide: variantToSide(a.closingSide ?? a.side),
    requestedAt: time(a, "requestedAt", "at"),
  };
}

/** A normalized created event extracted from an active-contracts response. */
export interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: any;
}

/**
 * Defensively pull created events out of a `/v2/state/active-contracts` response.
 *
 * // CONFIRM with Person 1 / live API: the EXACT envelope varies by Canton build.
 * This is the SINGLE place that knows the envelope shape. Handled shapes:
 *   1. Single object: { activeContracts: [ <entry>, ... ] }
 *   2. Top-level array: [ <entry>, ... ]
 *   3. Entry → contractEntry.JsActiveContract.createdEvent (v2 typed envelope)
 *   4. Entry → activeContract.createdEvent  (alternate nesting)
 *   5. NDJSON-style entry: { created: { contractId, templateId, createArguments } }
 *   6. Flat created event: { contractId, templateId, createArgument(s) }
 * Each createdEvent's payload may live under `createArgument` OR `createArguments`.
 */
export function extractCreatedEvents(responseJson: any): CreatedEvent[] {
  const out: CreatedEvent[] = [];

  // Normalize to a list of "entries".
  let entries: any[];
  if (Array.isArray(responseJson)) {
    entries = responseJson;
  } else if (responseJson && Array.isArray(responseJson.activeContracts)) {
    entries = responseJson.activeContracts;
  } else if (responseJson && Array.isArray(responseJson.result)) {
    entries = responseJson.result;
  } else if (responseJson) {
    entries = [responseJson];
  } else {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    // Dig down to a `createdEvent`-like object through the known nestings.
    const created =
      entry.contractEntry?.JsActiveContract?.createdEvent ??
      entry.contractEntry?.activeContract?.createdEvent ??
      entry.JsActiveContract?.createdEvent ??
      entry.activeContract?.createdEvent ??
      entry.createdEvent ??
      entry.created ??
      // Flat: the entry itself looks like a created event.
      (entry.contractId !== undefined ? entry : undefined);

    if (!created || typeof created !== "object") continue;

    const contractId = created.contractId ?? created.contractID ?? created.cid;
    const templateId = created.templateId ?? created.templateID;
    const createArgument =
      created.createArgument ?? created.createArguments ?? created.argument ?? created.payload;

    if (contractId === undefined || templateId === undefined) continue;

    out.push({
      contractId: String(contractId),
      templateId: String(templateId),
      createArgument,
    });
  }

  return out;
}

/**
 * Build a `/v2/commands/submit-and-wait` ExerciseCommand body
 * (CANTON-RWA.md §1; matches Person 2's engine command shape).
 */
export function buildExerciseCommand(opts: {
  templateId: string;
  contractId: string;
  choice: string;
  choiceArgument: any;
  userId: string;
  actAs: string[];
  readAs?: string[];
  commandId: string;
}): any {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: opts.templateId,
          contractId: opts.contractId,
          choice: opts.choice,
          choiceArgument: opts.choiceArgument,
        },
      },
    ],
    userId: opts.userId,
    commandId: opts.commandId,
    actAs: opts.actAs,
    readAs: opts.readAs ?? [],
  };
}

/** Build the active-contracts request body filtered to one template id. */
export function buildActiveContractsRequest(activeAtOffset: number, templateId: string): any {
  return {
    activeAtOffset,
    eventFormat: {
      filtersForAnyParty: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId,
                  includeCreatedEventBlob: false,
                },
              },
            },
          },
        ],
      },
      verbose: false,
    },
  };
}

/** A reasonably-unique command id (no npm deps). */
function makeCommandId(prefix: string): string {
  const rnd =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

/* ====================================================================== *
 * CantonLedger — the real LedgerClient
 * ====================================================================== */

export class CantonLedger implements LedgerClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly userId: string;
  private readonly actAs: string[];
  private readonly readAs: string[];
  private readonly templateIds: CantonTemplateIds;
  private readonly choices: Required<CantonChoices>;
  private readonly decimals: number;

  constructor(opts: CantonLedgerOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authToken = opts.authToken;
    this.userId = opts.userId;
    this.actAs = opts.actAs;
    this.readAs = opts.readAs ?? [];
    this.templateIds = opts.templateIds;
    // Only override defaults with explicitly-provided (non-undefined) choice names.
    const c = opts.choices ?? {};
    this.choices = {
      applyFunding: c.applyFunding ?? DEFAULT_CHOICES.applyFunding,
      liquidate: c.liquidate ?? DEFAULT_CHOICES.liquidate,
      settleClose: c.settleClose ?? DEFAULT_CHOICES.settleClose,
      updateOraclePrice: c.updateOraclePrice ?? DEFAULT_CHOICES.updateOraclePrice,
      verify: c.verify ?? DEFAULT_CHOICES.verify,
    };
    this.decimals = opts.decimals ?? 10;
  }

  /* ----------------------------- HTTP ---------------------------------- */

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.authToken) h.authorization = `Bearer ${this.authToken}`;
    return h;
  }

  /** GET <baseUrl><path> → parsed JSON; non-2xx throws with status + body. */
  private async get(path: string): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { method: "GET", headers: this.headers() });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GET ${path} → HTTP ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /** POST a JSON body; non-2xx throws with status + body. */
  private async submit(path: string, body: any): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST ${path} → HTTP ${res.status}: ${text}`);
    }
    return text ? safeParse(text) : {};
  }

  /** GET /v2/state/ledger-end → activeAtOffset (number). */
  private async getLedgerEndOffset(): Promise<number> {
    const res = await this.get("/v2/state/ledger-end");
    // Person 2's engine reads `offset`; some builds nest it. Be defensive.
    const off = res?.offset ?? res?.activeAtOffset ?? res?.ledgerEnd ?? 0;
    return Number(off);
  }

  /** Fetch + filter active contracts for a single template id. */
  private async activeContractsFor(templateId: string): Promise<CreatedEvent[]> {
    const offset = await this.getLedgerEndOffset();
    const body = buildActiveContractsRequest(offset, templateId);
    const res = await this.submit("/v2/state/active-contracts", body);
    return extractCreatedEvents(res).filter((e) => e.templateId === templateId);
  }

  /* -------------------------- LedgerClient ----------------------------- */

  async getActiveMatchedPairs(): Promise<MatchedPair[]> {
    const events = await this.activeContractsFor(this.templateIds.matchedPair);
    return events.map((e) => parseMatchedPair(e.contractId, e.createArgument));
  }

  async getCloseRequests(): Promise<CloseRequest[]> {
    const events = await this.activeContractsFor(this.templateIds.closeRequest);
    return events.map((e) => parseCloseRequest(e.contractId, e.createArgument));
  }

  async applyFunding(contractId: string, args: ApplyFundingArgs): Promise<void> {
    // CONFIRM with Person 1: choice arg field names on MatchedPair.ApplyFunding.
    const choiceArgument: any = {
      fundingRate: decToString(args.fundingRate, this.decimals),
      fundingPayment: decToString(args.fundingPayment, this.decimals),
      indexPrice: decToString(args.indexPrice, this.decimals),
      at: unixToIso(args.at),
    };
    // On-ledger Chainlink Verify path: pass the raw signed report unmodified.
    if (args.signedReport) choiceArgument.signedReportBytes = args.signedReport; // CONFIRM with Person 1
    await this.exercise(this.templateIds.matchedPair, contractId, this.choices.applyFunding, choiceArgument, "funding");
  }

  async liquidate(contractId: string, args: LiquidateArgs): Promise<void> {
    // CONFIRM with Person 1: choice arg field names on MatchedPair.Liquidate.
    const choiceArgument: any = {
      side: sideToVariant(args.side),
      markPrice: decToString(args.markPrice, this.decimals),
      equity: decToString(args.equity, this.decimals),
      maintenanceMargin: decToString(args.maintenanceMargin, this.decimals),
      at: unixToIso(args.at),
    };
    if (args.signedReport) choiceArgument.signedReportBytes = args.signedReport; // CONFIRM with Person 1
    await this.exercise(this.templateIds.matchedPair, contractId, this.choices.liquidate, choiceArgument, "liq");
  }

  async settleClose(contractId: string, args: SettleCloseArgs): Promise<void> {
    // CONFIRM with Person 1: choice arg field names on MatchedPair.SettleClose.
    const choiceArgument: any = {
      closingSide: sideToVariant(args.closingSide),
      exitPrice: decToString(args.exitPrice, this.decimals),
      realizedPnl: decToString(args.realizedPnl, this.decimals),
      netFunding: decToString(args.netFunding, this.decimals),
      at: unixToIso(args.at),
    };
    if (args.signedReport) choiceArgument.signedReportBytes = args.signedReport; // CONFIRM with Person 1
    await this.exercise(this.templateIds.matchedPair, contractId, this.choices.settleClose, choiceArgument, "settle");
  }

  /**
   * Post a verified/mock price.
   *
   * // CONFIRM with Person 1: this method's exact contract wiring (the Verify
   * // choice signature on the Chainlink Verifier, and how UpdatePrice targets a
   * // specific MockOraclePrice contract by id). The IMPORTANT, confirmed-shape
   * // paths are funding/liquidate/settle above; this is best-effort.
   *
   * Two paths:
   *  - If `price.signedReport` AND `templateIds.verifier` is configured → exercise
   *    the `Verify` choice on the verifier with the raw signed report bytes.
   *  - Else exercise `UpdatePrice` on a MockOraclePrice contract with the new
   *    price + timestamp. We use the feedId as the contract id placeholder —
   *    CONFIRM how the oracle-price contract is located (by key/feedId vs. CID).
   */
  async updateOraclePrice(price: OraclePrice): Promise<void> {
    if (price.signedReport && this.templateIds.verifier) {
      const choiceArgument: any = {
        signedReportBytes: price.signedReport, // CONFIRM with Person 1
        feedId: price.feedId,
        asOf: unixToIso(price.asOf),
      };
      // CONFIRM with Person 1: the verifier is exercised by contract id; we have
      // no CID here, so this targets the verifier template id with the feedId as
      // a stand-in. Wire the real verifier CID/key once Person 1's DAR lands.
      await this.exercise(this.templateIds.verifier, price.feedId, this.choices.verify, choiceArgument, "verify");
      return;
    }
    // Plain MockOraclePrice.UpdatePrice path.
    const choiceArgument: any = {
      newPrice: decToString(price.price, this.decimals),
      newTs: unixToIso(price.asOf),
    };
    // CONFIRM with Person 1: oracle-price contract is located by feedId here as a
    // placeholder for the real MockOraclePrice contract id.
    await this.exercise(this.templateIds.oraclePrice, price.feedId, this.choices.updateOraclePrice, choiceArgument, "oracle");
  }

  /* ---------------------------- internals ------------------------------ */

  /** Build + submit an ExerciseCommand, discarding the result. */
  private async exercise(
    templateId: string,
    contractId: string,
    choice: string,
    choiceArgument: any,
    prefix: string,
  ): Promise<void> {
    const body = buildExerciseCommand({
      templateId,
      contractId,
      choice,
      choiceArgument,
      userId: this.userId,
      actAs: this.actAs,
      readAs: this.readAs,
      commandId: makeCommandId(prefix),
    });
    await this.submit("/v2/commands/submit-and-wait", body);
  }
}

/** Parse JSON; fall back to raw text wrapped so submit() never throws on NDJSON. */
function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/* ====================================================================== *
 * Factory from env
 * ====================================================================== */

/**
 * Build a CantonLedger from environment variables, with sane defaults.
 * Reads: LEDGER_BASE_URL, LEDGER_AUTH_TOKEN?, VENUE_PARTY, USER_ID, and
 * template-id env vars (TEMPLATE_MATCHED_PAIR, TEMPLATE_CLOSE_REQUEST,
 * TEMPLATE_ORACLE_PRICE, TEMPLATE_VERIFIER?).
 */
export function cantonLedgerFromEnv(
  env: Record<string, string | undefined> = process.env,
): CantonLedger {
  const venueParty = env.VENUE_PARTY ?? "Venue";
  return new CantonLedger({
    baseUrl: env.LEDGER_BASE_URL ?? "http://localhost:7575",
    authToken: env.LEDGER_AUTH_TOKEN,
    userId: env.USER_ID ?? "venue",
    actAs: [venueParty],
    readAs: env.READ_AS ? env.READ_AS.split(",").map((s) => s.trim()).filter(Boolean) : [],
    templateIds: {
      // CONFIRM with Person 1: real package-name template ids from the DAR.
      matchedPair: env.TEMPLATE_MATCHED_PAIR ?? "perp-dex:PerpDex.Matching:MatchedPair",
      closeRequest: env.TEMPLATE_CLOSE_REQUEST ?? "perp-dex:PerpDex.Matching:CloseRequest",
      oraclePrice: env.TEMPLATE_ORACLE_PRICE ?? "perp-dex:PerpDex.Oracle:MockOraclePrice",
      verifier: env.TEMPLATE_VERIFIER,
    },
    choices: {
      applyFunding: env.CHOICE_APPLY_FUNDING,
      liquidate: env.CHOICE_LIQUIDATE,
      settleClose: env.CHOICE_SETTLE_CLOSE,
      updateOraclePrice: env.CHOICE_UPDATE_PRICE,
      verify: env.CHOICE_VERIFY,
    },
    decimals: env.LEDGER_DECIMALS ? Number(env.LEDGER_DECIMALS) : 10,
  });
}
