const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "full" is the date and time. "short" is "5m ago" for the past week, then the date (with the year if it isn't this one). */
export function formatNoteTime(iso: string, style: "short" | "full"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (style === "full") return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const ago = Date.now() - date.getTime();
  if (ago < 0 || ago >= 7 * DAY) {
    const thisYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: thisYear ? undefined : "numeric" });
  }
  if (ago < MINUTE) return "Just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;
  return `${Math.floor(ago / DAY)}d ago`;
}
