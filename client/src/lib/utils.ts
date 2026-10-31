import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function eur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const euros = Math.abs(cents) / 100;
  const digits = euros !== 0 && euros < 0.005 ? 4 : 2;
  return `${sign}€${euros.toFixed(digits)}`;
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
