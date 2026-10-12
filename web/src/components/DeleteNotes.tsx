import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { href, navigate } from "../routes";
import { useTagFilter } from "../tag-filter";

interface ConfirmDeleteProps {
  label: string;
  question: string;
  /** A word to type before the delete is enabled, for a delete that reaches past what is on screen. */
  typeToConfirm?: string;
  remove: () => Promise<unknown>;
  onDeleted?: () => void;
}

/** A delete button that asks first. Either way it ends on the list. */
function ConfirmDelete({ label, question, typeToConfirm, remove, onDeleted }: ConfirmDeleteProps) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const deletion = useMutation({
    mutationFn: remove,
    onSuccess: () => {
      close();
      onDeleted?.();
      navigate(href.home);
    },
  });
  const pending = deletion.isPending;

  function close() {
    setConfirming(false);
    setTyped("");
    deletion.reset();
  }

  return (
    <div className="delete-notes">
      {!confirming ? (
        <button className="text-button danger" onClick={() => setConfirming(true)}>
          {label}
        </button>
      ) : (
        <div className="delete-confirmation" role="group" aria-label={label}>
          <p>{question} This cannot be undone.</p>
          {typeToConfirm && (
            <label>
              Type {typeToConfirm} to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={pending} autoComplete="off" />
            </label>
          )}
          <div className="delete-actions">
            <button
              className="danger"
              disabled={pending || (typeToConfirm !== undefined && typed !== typeToConfirm)}
              onClick={() => deletion.mutate()}
            >
              {pending ? "Deleting…" : label}
            </button>
            <button disabled={pending} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {deletion.error && (
        <p className="error-banner" role="alert">
          {errorMessage(deletion.error)}
        </p>
      )}
    </div>
  );
}

export function DeleteNote({ id }: { id: string }) {
  return <ConfirmDelete label="Delete note" question="Permanently delete this note?" remove={() => api.deleteNote(id)} />;
}

export function DeleteAllNotes() {
  const { clear: clearTag } = useTagFilter();
  return (
    <ConfirmDelete
      label="Delete all notes"
      question="Permanently delete every note, including notes hidden by a tag filter?"
      typeToConfirm="DELETE"
      remove={api.deleteAllNotes}
      onDeleted={clearTag}
    />
  );
}
