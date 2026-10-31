import { BoundaryError } from "../errors.js";

/** Gmail is read-only. No send, no modify, no Drive, no Photos. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

export const GMAIL_FORBIDDEN_MARKERS = ["gmail.send", "gmail.modify", "gmail.compose", "drive", "photos", "gmail.insert"] as const;

export interface GmailModule {
  id: "gmail";
  scopes: readonly string[];
  readOnly: true;
  listRecent: (config: { refreshToken?: string }) => Promise<{ linked: false; reason: string } | { linked: true; messages: unknown[] }>;
}

export function assertGmailScopes(scopes: readonly string[]): void {
  if (scopes.length !== 1 || scopes[0] !== GMAIL_SCOPES[0]) {
    throw new BoundaryError("Gmail may only request gmail.readonly.");
  }
  const joined = scopes.join(" ").toLowerCase();
  for (const marker of GMAIL_FORBIDDEN_MARKERS) {
    if (joined.includes(marker)) {
      throw new BoundaryError(`Gmail scope refused: ${marker}`);
    }
  }
}

export function assertGmailReadOnly(action: string): void {
  const name = action.toLowerCase();
  const banned = ["send", "delete", "modify", "trash", "insert", "import", "reply", "forward"];
  if (banned.some((word) => name.includes(word))) {
    throw new BoundaryError(`Gmail module is read-only; refused: ${action}`);
  }
}

export function gmailAuthUrl(input: { redirectUri: string; state: string; clientId?: string }): string {
  const clientId = input.clientId ?? process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  assertGmailScopes(GMAIL_SCOPES);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** Granted scopes coming back from Google must still be readonly only. */
export function assertGrantedScopes(scope: string): void {
  const parts = scope.split(/\s+/).filter(Boolean);
  assertGmailScopes(parts);
}

export const gmailModule: GmailModule = {
  id: "gmail",
  scopes: GMAIL_SCOPES,
  readOnly: true,
  async listRecent(config) {
    assertGmailReadOnly("list");
    if (!config.refreshToken) {
      return { linked: false, reason: "Gmail is not linked." };
    }
    return { linked: false, reason: "Read path is scaffolded. Linking stores nothing that can send." };
  },
};
