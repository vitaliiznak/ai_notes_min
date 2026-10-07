export function formatNoteTime(iso: string, style: "short" | "full"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (style === "full") {
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  return formatShort(date);
}

function formatShort(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return shortDate(date, now);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "Just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return shortDate(date, now);
}

function shortDate(date: Date, now: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
