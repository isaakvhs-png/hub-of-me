import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Calendar, Folder, Layers, MessageSquare, MoreHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { cn, eur } from "@/lib/utils";

const primary = [
  { to: "/", label: "Dump", icon: MessageSquare, end: true },
  { to: "/library", label: "Library", icon: Folder, end: false },
  { to: "/calendar", label: "Calendar", icon: Calendar, end: false },
  { to: "/discovery", label: "Deck", icon: Layers, end: false },
];

const more = [
  { to: "/todos", label: "To-do" },
  { to: "/brief", label: "Brief" },
  { to: "/asks", label: "Asks" },
  { to: "/debates", label: "Debates" },
  { to: "/picture", label: "Picture" },
  { to: "/soul", label: "Soul" },
  { to: "/why", label: "Why" },
  { to: "/health", label: "Health" },
  { to: "/settings", label: "Settings" },
];

export function Shell({ name, onLogout, children }: { name: string; onLogout: () => void; children: React.ReactNode }) {
  const [summary, setSummary] = useState<{ tensions: number; leftEurCents: number; unexplored: number } | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api<{ tensions: number; leftEurCents: number; unexplored: number }>("/api/summary").then(setSummary).catch(() => setSummary(null));
  }, [location.pathname]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    onLogout();
    navigate("/");
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="hidden border-r border-border md:flex md:flex-col md:px-4 md:py-6">
        <div className="px-2">
          <div className="font-serif text-2xl italic text-primary">Hub of Me</div>
          <div className="mt-1 text-xs text-muted-foreground">{name}</div>
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          {primary.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => linkClass(isActive)}>
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
          <div className="my-3 h-px bg-border" />
          {more.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => linkClass(isActive)}>
              {item.label}
              {item.to === "/why" && summary ? <span className="ml-auto font-mono text-xs text-muted-foreground">{summary.tensions}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2 text-xs text-muted-foreground">
          <div className="font-mono text-primary">{summary ? eur(summary.leftEurCents) : "…"} left</div>
          <div>{summary?.unexplored ?? 0} unexplored</div>
          <button className="mt-3 text-left hover:text-foreground" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
          <div className="font-serif text-xl italic text-primary">Hub of Me</div>
          <button className="text-sm text-muted-foreground" onClick={() => setOpen((value) => !value)} aria-label="More">
            <MoreHorizontal />
          </button>
        </header>
        {open ? (
          <div className="border-b border-border px-4 py-3 md:hidden">
            <div className="flex flex-wrap gap-2">
              {more.map((item) => (
                <NavLink key={item.to} to={item.to} onClick={() => setOpen(false)} className="rounded-full border border-border px-3 py-1 text-sm">
                  {item.label}
                  {item.to === "/why" && summary ? ` ${summary.tensions}` : ""}
                </NavLink>
              ))}
              <button className="text-sm text-muted-foreground" onClick={logout}>Sign out</button>
            </div>
          </div>
        ) : null}
        <main className="flex-1 px-4 py-5 pb-24 md:px-8 md:pb-8">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-[#0c0b09]/95 px-2 py-2 md:hidden">
        {primary.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => cn("flex flex-col items-center gap-1 py-1 text-[11px]", isActive ? "text-primary" : "text-muted-foreground")}>
            <item.icon size={18} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function linkClass(active: boolean) {
  return cn("flex items-center gap-2 rounded-md px-2 py-2 text-sm", active ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground");
}
