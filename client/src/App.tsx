import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SingleView } from "./view/SingleView";

export function App() {
  const [user, setUser] = useState<{ name: string } | null | undefined>(undefined);
  useEffect(() => { api<{ name: string }>("/api/auth/me").then(setUser).catch(() => setUser(null)); }, []);
  if (user === undefined) return <div className="center note">Opening the hub…</div>;
  if (!user) return <Login onIn={setUser} />;
  return <SingleView name={user.name} onLogout={() => setUser(null)} />;
}

function Login({ onIn }: { onIn: (u: { name: string }) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try { onIn(await api<{ name: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not sign in."); }
  }
  return (
    <form className="login" onSubmit={submit}>
      <h1>Hub of Me</h1>
      <label>Email<input autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {error ? <p className="err">{error}</p> : null}
      <button className="send" type="submit">Enter</button>
    </form>
  );
}
