import { BoundaryError } from "./errors.js";

const OUTREACH = new Set(["send_email", "send_message", "send", "post", "reply", "invite", "outreach"]);
const SIGN_IN = new Set(["enter_password", "sign_in", "submit_password", "authenticate_as_user", "fill_password"]);

/**
 * Outreach to another person needs an explicit yes.
 * Email never sends, even with that yes: Gmail is read-only and drafting is the ceiling.
 * There is no enabled outreach channel in this build.
 */
export function assertCanReachOut(input: { channel: string; explicitYes: boolean }): void {
  const channel = input.channel.toLowerCase();
  if (channel === "email" || channel === "gmail") {
    throw new BoundaryError("Email is read and draft only. Nothing is sent.");
  }
  if (!OUTREACH.has(channel) && channel !== "other") {
    throw new BoundaryError(`Unknown outreach channel: ${input.channel}`);
  }
  if (!input.explicitYes) {
    throw new BoundaryError("Reaching another person needs your explicit yes. Drafting stays in the app.");
  }
  throw new BoundaryError("No outreach channel is enabled. The draft stays in the app.");
}

export function assertNotSigningIn(action: string): void {
  if (SIGN_IN.has(action)) {
    throw new BoundaryError("The system does not enter passwords or sign in for you.");
  }
}

export function assertNotDelete(action: string): void {
  const name = action.toLowerCase();
  if (name === "delete" || name.startsWith("delete_") || name.endsWith("_delete")) {
    throw new BoundaryError("Nothing is deleted. Archive instead.");
  }
}

export function assertCalendarWriteAllowed(): void {
  // Writing the in-app calendar is allowed. The function exists so call sites stay obvious.
}
