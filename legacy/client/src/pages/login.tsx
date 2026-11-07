import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export function LoginPage({ onIn }: { onIn: (user: { name: string }) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await api<{ name: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      onIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-8 h-1 w-16 bg-primary" />
      <h1 className="font-serif text-5xl italic text-primary">Hub of Me</h1>
      <p className="mt-4 text-lg leading-relaxed text-muted-foreground">Dump a thought. It gets filed, versioned, and kept. Nothing here is deleted.</p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Enter"}</Button>
      </form>
      <p className="mt-6 text-xs text-muted-foreground">The local account is USER_EMAIL from the environment. The example file uses peter@local.</p>
    </div>
  );
}
