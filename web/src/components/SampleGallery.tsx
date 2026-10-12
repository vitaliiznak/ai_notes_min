import { SAMPLE_NOTES, type SampleNote } from "../samples";
import { canSummarize, charLength } from "../shared";

// Test fixture, not part of the product: fills the form so someone can try AI without typing.
// Saving still goes through the normal path.
export function SampleGallery({
  current,
  onPick,
  disabled,
}: {
  current: SampleNote | undefined;
  onPick: (note: SampleNote) => void;
  disabled: boolean;
}) {
  return (
    <section className="samples" aria-labelledby="samples-heading">
      <div className="samples-head">
        <span className="demo-badge">Test only</span>
        <div>
          <h2 id="samples-heading">Sample notes</h2>
          <p className="samples-note">
            For trying the app. Picking one only fills the form — nothing is saved until you press Save note.
          </p>
        </div>
      </div>
      <ul className="samples-list">
        {SAMPLE_NOTES.map((note) => {
          const length = charLength(note.content);
          return (
            <li key={note.title}>
              <button type="button" className="sample" aria-pressed={note === current} disabled={disabled} onClick={() => onPick(note)}>
                <span className="sample-title">{note.title}</span>
                <span className="sample-meta">
                  {canSummarize(note.content) ? "Summary + tags" : "Tags only"} · {length.toLocaleString("en-US")}{" "}
                  characters
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
