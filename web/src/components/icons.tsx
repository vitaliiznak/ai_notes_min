const line = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function NoteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M4.25 2.75h6.4l3.1 3.1v9.4h-9.5v-12.5zM10.4 2.9v3.3h3.2" {...line} strokeLinecap="butt" strokeWidth="1.6" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" {...line} strokeWidth="1.75" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3.5 5.5 8 10 12.5" {...line} strokeWidth="1.75" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.75v2.5h-2.5" {...line} strokeWidth="1.6" />
    </svg>
  );
}

/** Marks text the AI wrote or will write. */
export function Sparkle() {
  return (
    <svg className="sparkle" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 1.5 8.3 5.7 12.5 7 8.3 8.3 7 12.5 5.7 8.3 1.5 7 5.7 5.7Z" fill="currentColor" />
    </svg>
  );
}
