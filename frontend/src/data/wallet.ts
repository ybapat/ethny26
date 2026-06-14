/**
 * data/wallet.ts — browser-side self-custody key management.
 *
 * The trader's Ed25519 private key is generated and held IN THE BROWSER (tweetnacl,
 * the same lib the Canton Wallet SDK uses → byte-compatible signatures) and is
 * never sent to the gateway. The gateway only relays the M2M-authed HTTP calls and
 * computes the hashes to sign; signing happens here. Keys persist in localStorage
 * so a wallet survives a refresh.
 */
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";

const LS_KEY = "nyx.wallets.v1"; // { [partyId]: privateKeyBase64 }

// In-memory fallback for when localStorage is unavailable (private mode, storage
// blocked by browser settings, or quota). Without this, a setItem that throws used
// to abort onboarding entirely (rememberWallet sits before onboard-execute).
let mem: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (mem) return mem;
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { mem = {}; return mem; }
}
function save(m: Record<string, string>): void {
  if (mem) { mem = m; return; }
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)); }
  catch { mem = m; } // localStorage write failed — keep keys in memory for this session
}

/** Generate a fresh Ed25519 keypair (base64), private key never leaves the browser. */
export function generateKeypair(): { publicKey: string; privateKey: string } {
  const kp = nacl.sign.keyPair();
  return { publicKey: encodeBase64(kp.publicKey), privateKey: encodeBase64(kp.secretKey) };
}

/** Detached Ed25519 signature (base64) over a base64-encoded hash — exactly what
 * Canton's interactive submission / external onboarding expect. */
export function signHash(hashB64: string, privateKeyB64: string): string {
  return encodeBase64(nacl.sign.detached(decodeBase64(hashB64), decodeBase64(privateKeyB64)));
}

export function rememberWallet(partyId: string, privateKey: string): void {
  const m = load(); m[partyId] = privateKey; save(m);
}
/** The private key for a self-custody party, if this browser holds it. */
export function walletKey(partyId: string): string | undefined {
  return load()[partyId];
}
/** Party ids of all self-custody wallets this browser holds keys for. */
export function knownWallets(): string[] {
  return Object.keys(load());
}

/** Forget a wallet's key (e.g. it was orphaned by a gateway restart). */
export function forgetWallet(partyId: string): void {
  const m = load(); delete m[partyId]; save(m);
}
