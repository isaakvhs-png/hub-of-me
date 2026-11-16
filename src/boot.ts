import { ensureAccount } from "./accounts.js";
import { ensureHow, ensureLife } from "./web.js";
import { db } from "./state.js";
import { heartbeat } from "./settings.js";
import { startAutonomy } from "./autonomy.js";
import { setMock } from "./models.js";
import { scriptedModel } from "./mock.js";
import { rewipeOnce } from "./rewipe.js";
import { startMail } from "./mail.js";

/** After the database is open: the account, the empty centre, runs cut off by a restart, the heartbeat, its own work. */
export async function boot(opts: { autonomy?: boolean; noRewipe?: boolean } = {}): Promise<() => void> {
  if (process.env.AI_PROVIDER?.trim().toLowerCase() === "mock") setMock(scriptedModel);
  await ensureAccount();
  if (!opts.noRewipe) await rewipeOnce();
  await ensureLife();
  await ensureHow();
  // A run that was going when the server stopped can't go on (its waiting lives in memory): say so.
  await db().query(`UPDATE runs SET status = 'interrupted', finished_at = now(), result = result || E'\n\n(The server restarted during this run.)' WHERE status IN ('running','waiting')`);
  const beat = setInterval(() => { void heartbeat().catch(() => undefined); }, 60_000);
  let stopOwn: () => void = () => {};
  let stopMail: () => void = () => {};
  if (opts.autonomy !== false) { stopOwn = startAutonomy(); stopMail = startMail(); }
  return () => { clearInterval(beat); stopOwn(); stopMail(); };
}
