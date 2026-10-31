export const NOTE_TYPES = ["todo", "owed", "question", "conclusion", "idea", "person", "file", "source"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_STATUSES = ["unexplored", "acknowledged", "revised", "declined", "for_now", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const ROLES = ["conversation", "filing", "research", "duties", "critic", "reflection", "debater", "judge"] as const;
export type Role = (typeof ROLES)[number];

export type ProviderName = "mock" | "anthropic" | "gemini";

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Settings {
  userId: string;
  provider: ProviderName;
  cheapModel: string;
  strongModel: string;
  judgeModel: string;
  alternateModel: string;
  localCategories: string[];
  forNowTtlHours: number;
  dictationLang: string;
  priceOverrides: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }>;
  usdToEur: number;
}

export interface SoulVersion {
  id: string;
  userId: string;
  version: number;
  content: string;
  reason: string;
  causingMessageId: string | null;
  createdByRole: string;
  createdAt: string;
}

export interface Folder {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface Note {
  id: string;
  userId: string;
  folderId: string | null;
  type: string;
  title: string;
  body: string;
  status: string;
  forNowExpiresAt: string | null;
  archivedAt: string | null;
  currentVersion: number;
  mockEra: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteVersion {
  id: string;
  noteId: string;
  version: number;
  folderId: string | null;
  type: string;
  title: string;
  body: string;
  status: string;
  reason: string;
  causingMessageId: string | null;
  createdAt: string;
}

export interface UsageRow {
  id: string;
  userId: string;
  role: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsdCents: number | null;
  costEurCents: number | null;
  priceKnown: boolean;
  durationMs: number;
  inputChars: number;
  outputText: string;
  conversationId: string | null;
  jobId: string | null;
  jobKind: string | null;
  createdAt: string;
}
