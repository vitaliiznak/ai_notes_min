interface Props {
  tags: string[];
  /** The tag the list is filtered by, highlighted wherever it appears. */
  active?: string | null;
  /** Makes each tag a button that filters the list by it. */
  onSelect?: (tag: string) => void;
}

export function Tags({ tags, active, onSelect }: Props) {
  return (
    <ul className="tags" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag} className={tag === active ? "is-active" : undefined}>
          {onSelect ? (
            <button
              type="button"
              className="tag-button"
              aria-pressed={tag === active}
              title={`Show notes tagged ${tag}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelect(tag);
              }}
            >
              {tag}
            </button>
          ) : (
            tag
          )}
        </li>
      ))}
    </ul>
  );
}
