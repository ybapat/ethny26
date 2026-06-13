/**
 * fromEnv.ts — build the REAL Chainlink Data Streams client + price source from
 * environment credentials. This is the production wiring (no mocks).
 *
 * Required env:
 *   DS_API_KEY      Chainlink Data Streams API key (UUID)         -> Authorization header
 *   DS_USER_SECRET  Chainlink Data Streams user secret (HMAC key)
 * Optional env:
 *   DS_ENV          "testnet" (default) | "mainnet"
 *   DS_DECIMALS     price scaling decimals (default 18)
 *
 * Obtain credentials from Chainlink: https://chain.link/contact?ref_id=datastreams
 * (CHAINLINK.md §10). Until then these throw a clear, actionable error.
 */
import { DATA_STREAMS, FEED_IDS } from "../config.ts";
import { DataStreamsClient } from "./dataStreams.ts";
import { DataStreamsPriceSource } from "./priceSource.ts";
import { DataStreamsWsPriceSource } from "./wsPriceSource.ts";

export interface DsEnv {
  apiKey: string;
  userSecret: string;
  restBase: string;
  wsBase: string;
  decimals: number;
  env: "testnet" | "mainnet";
}

export function readDsEnv(env: NodeJS.ProcessEnv = process.env): DsEnv {
  const apiKey = env.DS_API_KEY;
  const userSecret = env.DS_USER_SECRET;
  if (!apiKey || !userSecret) {
    throw new Error(
      "Missing Chainlink Data Streams credentials. Set DS_API_KEY and DS_USER_SECRET " +
        "(get them from https://chain.link/contact?ref_id=datastreams). " +
        'Example: DS_API_KEY=<uuid> DS_USER_SECRET=<secret> npm run fetch',
    );
  }
  const which = (env.DS_ENV ?? "testnet").toLowerCase();
  const isMain = which === "mainnet";
  return {
    apiKey,
    userSecret,
    restBase: isMain ? DATA_STREAMS.mainnetRest : DATA_STREAMS.testnetRest,
    wsBase: isMain ? DATA_STREAMS.mainnetWs : DATA_STREAMS.testnetWs,
    decimals: env.DS_DECIMALS ? Number(env.DS_DECIMALS) : 18,
    env: isMain ? "mainnet" : "testnet",
  };
}

/** Build a live DataStreamsClient from env credentials. */
export function dataStreamsClientFromEnv(env: NodeJS.ProcessEnv = process.env): DataStreamsClient {
  const cfg = readDsEnv(env);
  return new DataStreamsClient({
    restBase: cfg.restBase,
    apiKey: cfg.apiKey,
    apiSecret: cfg.userSecret,
  });
}

/**
 * Build a live PriceSource from env. Defaults the ETH-USD market to the confirmed
 * ETH/USD V3 feed id; pass more markets via `marketToFeedId`.
 */
export function dataStreamsPriceSourceFromEnv(
  marketToFeedId: Record<string, string> = { "ETH-USD": FEED_IDS.ETH_USD },
  env: NodeJS.ProcessEnv = process.env,
): DataStreamsPriceSource {
  const cfg = readDsEnv(env);
  return new DataStreamsPriceSource({
    client: dataStreamsClientFromEnv(env),
    marketToFeedId,
    decimals: cfg.decimals,
  });
}

/**
 * Build a REAL-TIME (WebSocket) PriceSource from env. Call `.start()` on the
 * returned source, then `await .waitForFirst(market)` before using it. This is
 * the event-driven path (sub-second pushes).
 */
export function dataStreamsWsPriceSourceFromEnv(
  marketToFeedId: Record<string, string> = { "ETH-USD": FEED_IDS.ETH_USD },
  env: NodeJS.ProcessEnv = process.env,
): DataStreamsWsPriceSource {
  const cfg = readDsEnv(env);
  return new DataStreamsWsPriceSource({
    wsBase: cfg.wsBase,
    apiKey: cfg.apiKey,
    apiSecret: cfg.userSecret,
    marketToFeedId,
    decimals: cfg.decimals,
  });
}
