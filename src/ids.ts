import { randomBytes, randomUUID } from "node:crypto";

export function id(): string {
  return randomUUID();
}

export function token(): string {
  return randomBytes(32).toString("hex");
}
