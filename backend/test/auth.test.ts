/**
 * auth.test.ts — M2M token provider (no network; fetch is injected).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTokenRequestBody,
  buildWsSubprotocols,
  M2mTokenProvider,
  type M2mConfig,
} from "../src/ledger/auth.ts";

const CFG: M2mConfig = {
  tokenUrl: "https://auth.example/o/token/",
  clientId: "validator-devnet-m2m",
  clientSecret: "secret-xyz",
  audience: "validator-devnet-m2m",
  scope: "daml_ledger_api",
};

test("buildTokenRequestBody emits the client_credentials form body", () => {
  const body = buildTokenRequestBody(CFG);
  const p = new URLSearchParams(body);
  assert.equal(p.get("grant_type"), "client_credentials");
  assert.equal(p.get("client_id"), "validator-devnet-m2m");
  assert.equal(p.get("client_secret"), "secret-xyz");
  assert.equal(p.get("audience"), "validator-devnet-m2m");
  assert.equal(p.get("scope"), "daml_ledger_api");
});

test("buildWsSubprotocols puts the jwt token first, daml.ws.auth second", () => {
  const subs = buildWsSubprotocols("TOK");
  assert.deepEqual(subs, ["jwt.token.TOK", "daml.ws.auth"]);
});

test("M2mTokenProvider exchanges once and caches until near expiry", async () => {
  let calls = 0;
  let nowMs = 1_000_000;
  const fakeFetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }),
    };
  };
  const p = new M2mTokenProvider(CFG, { fetchImpl: fakeFetch, nowMs: () => nowMs });

  assert.equal(await p.getToken(), "tok-1");
  assert.equal(await p.getToken(), "tok-1", "cached, no second exchange");
  assert.equal(calls, 1);

  // Advance to within the 60s refresh window before the 3600s expiry → re-exchange.
  nowMs += 3600_000 - 30_000;
  assert.equal(await p.getToken(), "tok-2");
  assert.equal(calls, 2);
});

test("M2mTokenProvider throws on a non-2xx token response", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "bad creds" });
  const p = new M2mTokenProvider(CFG, { fetchImpl: fakeFetch, nowMs: () => 0 });
  await assert.rejects(() => p.getToken(), /401/);
});

test("M2mTokenProvider.invalidate forces a re-exchange", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }) };
  };
  const p = new M2mTokenProvider(CFG, { fetchImpl: fakeFetch, nowMs: () => 0 });
  await p.getToken();
  p.invalidate();
  await p.getToken();
  assert.equal(calls, 2);
});
