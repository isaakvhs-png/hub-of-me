import { describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { bootCore } from "../src/core/index.js";
import { drain, resetQueueForTests } from "../src/core/queue.js";
import { createApp } from "../server/app.js";

describe("the HTTP surface", () => {
  it("signs in, sends, answers, and serves the view's data", async () => {
    resetQueueForTests();
    process.env.AI_PROVIDER = "mock";
    const db = await createDb({ memory: true });
    const { userIds } = await bootCore(db);
    const app = createApp(db);
    expect((await app.request("/api/chat")).status).toBe(401);
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: process.env.USER_EMAIL || "isaak@local", password: process.env.USER_PASSWORD || "hub-of-me" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const h = { cookie, "content-type": "application/json" };
    const sent = await (await app.request("/api/send", { method: "POST", headers: h, body: JSON.stringify({ text: "Kenya Programme starts in March.", clientMsgId: "x1" }) })).json() as { runId: string };
    const { MockModels } = await import("../src/core/mock.js");
    await drain({ db, userId: userIds[0], ai: new MockModels(), now: () => new Date() });
    const again = await (await app.request("/api/send", { method: "POST", headers: h, body: JSON.stringify({ text: "Kenya Programme starts in March.", clientMsgId: "x1" }) })).json() as { duplicate: boolean };
    expect(again.duplicate).toBe(true);
    const chat = await (await app.request("/api/chat", { headers: h })).json() as { kind: string }[];
    expect(chat.map((c) => c.kind)).toEqual(["his", "its"]);
    const record = await (await app.request(`/api/runs/${sent.runId}`, { headers: h })).json() as { steps: { node: string }[] };
    expect(record.steps.length).toBeGreaterThan(8);
    const exp = await app.request(`/api/runs/${sent.runId}/export`, { headers: h });
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    for (const path of ["/api/map", "/api/knobs", "/api/rings", "/api/workshop", "/api/calendar", "/api/runs"]) expect((await app.request(path, { headers: h })).status, path).toBe(200);
    expect((await app.request("/api/diag/health")).status).toBe(404); // no token set: diagnostics are off
    await db.close();
  });
});
