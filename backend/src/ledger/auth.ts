/**
 * auth.ts — M2M OIDC token provider for the Seaport 5n-sandbox validator.
 *
 * The validator's JSON Ledger API requires a JWT obtained via OIDC
 * client_credentials (see "Seaport Sandbox Validator Access"):
 *   POST https://auth.sandbox.fivenorth.io/application/o/token/
 *        grant_type=client_credentials
 *        client_id=<...> client_secret=<...> audience=<...> scope=daml_ledger_api
 *   → { access_token, expires_in, ... }   (token lasts ~8h → must refresh)
 *
 * REST calls then send `Authorization: Bearer <token>`. (WS auth uses the
 * subprotocols `jwt.token.<token>` + `daml.ws.auth`; see buildWsSubprotocols.)
 *
 * Secrets are NEVER hardcoded — they come from env (.env, gitignored).
 * Node built-ins only; erasable-syntax-only TS; relative imports end in `.ts`.
 */

export interface M2mConfig {
  /** OIDC token endpoint, e.g. https://auth.sandbox.fivenorth.io/application/o/token/ */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Token audience (fivenorth uses the client id). */
  audience: string;
  /** Scope; the validator needs `daml_ledger_api`. */
  scope: string;
}

/** Build the x-www-form-urlencoded body for the client_credentials grant. */
export function buildTokenRequestBody(c: M2mConfig): string {
  const p = new URLSearchParams();
  p.set("grant_type", "client_credentials");
  p.set("client_id", c.clientId);
  p.set("client_secret", c.clientSecret);
  p.set("audience", c.audience);
  p.set("scope", c.scope);
  return p.toString();
}

/** WebSocket auth for the Canton JSON API: subprotocols, ordering matters. */
export function buildWsSubprotocols(token: string): string[] {
  return [`jwt.token.${token}`, "daml.ws.auth"];
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Caches the access token and refreshes it ~60s before expiry. Inject `fetchImpl`
 * for tests; defaults to global fetch.
 */
export class M2mTokenProvider {
  private readonly cfg: M2mConfig;
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;
  private token: string | undefined;
  private expiresAtMs = 0;

  constructor(cfg: M2mConfig, opts: { fetchImpl?: FetchLike; nowMs?: () => number } = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** Return a valid token, exchanging/refreshing if needed. */
  async getToken(): Promise<string> {
    const now = this.nowMs();
    if (this.token && now < this.expiresAtMs - 60_000) return this.token;

    const res = await this.fetchImpl(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: buildTokenRequestBody(this.cfg),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`M2M token exchange failed: HTTP ${res.status}: ${text}`);
    const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("M2M token response missing access_token");
    this.token = j.access_token;
    const ttlSec = typeof j.expires_in === "number" ? j.expires_in : 28800; // default 8h
    this.expiresAtMs = now + ttlSec * 1000;
    return this.token;
  }

  /** Force the next getToken() to re-exchange (e.g. after a 401). */
  invalidate(): void {
    this.token = undefined;
    this.expiresAtMs = 0;
  }
}

/**
 * Build an M2mTokenProvider from env, or return undefined if creds are absent
 * (so local/unsecured sandboxes still work with no auth).
 * Env: OIDC_TOKEN_URL?, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_AUDIENCE?, OIDC_SCOPE?
 */
export function m2mProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): M2mTokenProvider | undefined {
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return undefined;
  return new M2mTokenProvider({
    tokenUrl: env.OIDC_TOKEN_URL ?? "https://auth.sandbox.fivenorth.io/application/o/token/",
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    audience: env.OIDC_AUDIENCE ?? env.OIDC_CLIENT_ID,
    scope: env.OIDC_SCOPE ?? "daml_ledger_api",
  });
}
