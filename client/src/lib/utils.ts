import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function eur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function when(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
