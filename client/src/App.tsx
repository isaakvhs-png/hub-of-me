import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { CalendarPage } from "@/pages/calendar";
import { ChatPage } from "@/pages/chat";
import { DiscoveryPage } from "@/pages/discovery";
import { LibraryPage } from "@/pages/library";
import { LoginPage } from "@/pages/login";
import { AsksPage, BriefPage, DebatePage, DebatesPage, HealthPage, SettingsPage, SoulPage, WhyPage } from "@/pages/rest";
import { ToDoPage } from "@/pages/todos";
import { PicturePage } from "@/pages/picture";
import { NotebookPage } from "@/pages/notebook";

export function App() {
  const [user, setUser] = useState<{ name: string } | null | undefined>(undefined);

  useEffect(() => {
    api<{ name: string }>("/api/auth/me").then(setUser).catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="grid min-h-screen place-items-center text-muted-foreground">Opening the hub…</div>;
  if (!user) return <LoginPage onIn={setUser} />;

  return (
    <Shell name={user.name} onLogout={() => setUser(null)}>
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/discovery" element={<DiscoveryPage />} />
        <Route path="/brief" element={<BriefPage />} />
        <Route path="/todos" element={<ToDoPage />} />
        <Route path="/picture" element={<PicturePage />} />
        <Route path="/asks" element={<AsksPage />} />
        <Route path="/debates" element={<DebatesPage />} />
        <Route path="/debates/:id" element={<DebatePage />} />
        <Route path="/soul" element={<SoulPage />} />
        <Route path="/why" element={<WhyPage />} />
        <Route path="/notebook" element={<NotebookPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<ChatPage />} />
      </Routes>
    </Shell>
  );
}
