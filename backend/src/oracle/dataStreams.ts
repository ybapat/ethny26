/**
 * dataStreams.ts — Chainlink Data Streams REST client (CHAINLINK.md §1-2).
 *
 * `buildLatestRequest` is pure/testable: it builds the latest-report URL and the
 * three HMAC auth headers. The signed PATH includes the query string, per §2.
 * `fetchLatestReport` performs the real `fetch` and unwraps the `{report:{...}}`
 * envelope (§1).
 */
import { DATA_STREAMS } from "../config.ts";
import { signRequest } from "./hmac.ts";

export interface LatestReportEnvelope {
  feedID: string;
  validFromTimestamp: number;
  observationsTimestamp: number;
  fullReport: string;
}

export class DataStreamsClient {
  private readonly restBase: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly now: () => number;

  constructor(opts: {
    restBase: string;
    apiKey: string;
    apiSecret: string;
    now?: () => number;
  }) {
    this.restBase = opts.restBase.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Build the GET `/api/v1/reports/latest?feedID=...` request: absolute URL plus
   * the three HMAC headers. Pure — no network. The signed PATH includes the
   * query string exactly as it appears in the URL.
   */
  buildLatestRequest(feedId: string): {
    url: string;
    headers: Record<string, string>;
  } {
    const path = `${DATA_STREAMS.paths.latest}?feedID=${feedId}`;
    const url = `${this.restBase}${path}`;
    const headers = signRequest({
      method: "GET",
      path,
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      timestampMs: this.now(),
    });
    return { url, headers };
  }

  /**
   * Fetch the latest signed report for a feed and parse the `{report:{...}}`
   * envelope. Not unit-tested live.
   */
  async fetchLatestReport(feedId: string): Promise<LatestReportEnvelope> {
    const { url, headers } = this.buildLatestRequest(feedId);
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Data Streams latest report failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const json = (await res.json()) as { report?: LatestReportEnvelope };
    if (!json.report || typeof json.report.fullReport !== "string") {
      throw new Error("Data Streams response missing report.fullReport");
    }
    return json.report;
  }
}
