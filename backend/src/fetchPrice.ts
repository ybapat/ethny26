/**
 * fetchPrice.ts — hit the REAL Chainlink Data Streams endpoint and print the price.
 * This is the production price-fetch path (no mocks).
 *
 * Run:
 *   DS_API_KEY=<uuid> DS_USER_SECRET=<secret> npm run fetch            # ETH/USD testnet
 *   DS_API_KEY=... DS_USER_SECRET=... DS_ENV=mainnet npm run fetch <feedIdHex>
 *
 * Without credentials it prints how to get them. With invalid credentials the
 * live server returns 401 (proving our request/auth format is correct). With
 * valid credentials it returns a real signed report, which we decode to a price.
 */
import { FEED_IDS } from "./config.ts";
import { dataStreamsClientFromEnv, readDsEnv } from "./oracle/fromEnv.ts";
import { decodeV3Report } from "./oracle/reportV3.ts";

async function main() {
  const feedId = process.argv[2] ?? FEED_IDS.ETH_USD;

  let cfg;
  try {
    cfg = readDsEnv();
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(2);
  }

  console.log(`Chainlink Data Streams — ${cfg.env}`);
  console.log(`host: ${cfg.restBase}`);
  console.log(`feedID: ${feedId}`);

  const client = dataStreamsClientFromEnv();

  // Show the exact request we send (headers redacted) so it's auditable.
  const { url, headers } = client.buildLatestRequest(feedId);
  console.log(`GET ${url}`);
  console.log(
    `headers: Authorization=${mask(headers["Authorization"])} ` +
      `X-Authorization-Timestamp=${headers["X-Authorization-Timestamp"]} ` +
      `X-Authorization-Signature-SHA256=${mask(headers["X-Authorization-Signature-SHA256"])}`,
  );

  try {
    const report = await client.fetchLatestReport(feedId);
    const decoded = decodeV3Report(report.fullReport, cfg.decimals);
    const ageSec = Math.floor(Date.now() / 1000) - report.observationsTimestamp;
    console.log("\n✓ live signed report received");
    console.log(`  price            : ${decoded.price}`);
    console.log(`  bid / ask        : ${decoded.bid} / ${decoded.ask}`);
    console.log(`  validFrom        : ${report.validFromTimestamp}`);
    console.log(`  observationsAt   : ${report.observationsTimestamp} (${ageSec}s ago)`);
    console.log(`  fullReport bytes : ${(report.fullReport.length - 2) / 2}`);
    console.log("\nNOTE: the same `fullReport` hex is what the Daml `Verify` choice checks on-ledger.");
  } catch (e) {
    console.error(`\n✗ fetch failed: ${String((e as Error).message)}`);
    console.error(
      "If this is 401, the request format is correct and you just need valid credentials.\n" +
        "If 400 about missing headers, the auth headers were not sent.",
    );
    process.exit(1);
  }
}

function mask(s: string | undefined): string {
  if (!s) return "(none)";
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

main();
