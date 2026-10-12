// Grey bars where text will appear. Each className sizes its own bars (see .skeleton in styles.css).
export function Placeholder({ className, lines = 3 }: { className: string; lines?: number }) {
  return (
    <div className={`skeleton ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
