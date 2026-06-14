/** walletSpike.ts — prove FULL external-party flow: onboard a self-custody party,
 * then prepare→sign→execute a real ledger transaction via interactive submission. */
import { SDK } from "@canton-network/wallet-sdk";
import { m2mProviderFromEnv } from "./ledger/auth.ts";

const base = (process.env.LEDGER_BASE_URL ?? "").replace(/\/+$/, "");
const prov = m2mProviderFromEnv()!;

async function main() {
  const token = await prov.getToken();
  const sdk: any = await (SDK as any).create({ auth: { method: "static", token }, ledgerClientUrl: base });
  console.log("SDK userId:", sdk.userId ?? sdk.ctx?.userId, "| synchronizer:", (sdk.ctx?.defaultSynchronizerId ?? "").slice(0, 30), "…");

  const key = sdk.keys.generate();
  const partyHint = "selfcustody" + Date.now().toString(36);
  const party = await sdk.party.external.create(key.publicKey, { partyHint }).sign(key.privateKey).execute();
  const partyId = party.partyId;
  console.log("✓ onboarded external party:", partyId.slice(0, 50), "…");

  console.log("preparing a Ping (interactive submission)…");
  const cmds = sdk.utils.ping.create([{ initiator: partyId, responder: partyId }]);
  const prepared = sdk.ledger.prepare({ partyId, commands: cmds });
  console.log("…signing the prepared-transaction hash with the EXTERNAL key…");
  const res = await prepared.sign(key.privateKey).execute({ partyId });
  console.log("✓ INTERACTIVE SUBMISSION EXECUTED:", JSON.stringify(res).slice(0, 200));
}
main().catch((e) => { console.error("✗ failed:", e?.message ?? e); if (e?.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n")); process.exit(1); });
