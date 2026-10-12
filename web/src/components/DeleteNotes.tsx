import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { useTagFilter } from "../tag-filter";

/** Deletes the note with this id, or every note without one. Either way it ends on the list. */
export function DeleteNotes({ id }: { id?: string }) {
  const { clear: clearTag } = useTagFilter();
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const remove = useMutation({
    mutationFn: () => (id ? api.deleteNote(id) : api.deleteAllNotes()),
    onSuccess: () => {
      close();
      if (!id) clearTag();
      window.location.hash = "#/";
    },
  });
  const label = id ? "Delete note" : "Delete all notes";
  const pending = remove.isPending;

  function close() {
    setConfirming(false);
    setConfirmation("");
    remove.reset();
  }

  return (
    <div className="delete-notes">
      {!confirming ? (
        <button className="text-button danger" onClick={() => setConfirming(true)}>
          {label}
        </button>
      ) : (
        <div className="delete-confirmation" role="group" aria-label={label}>
          <p>
            {id ? "Permanently delete this note?" : "Permanently delete every note, including notes hidden by a tag filter?"}{" "}
            This cannot be undone.
          </p>
          {!id && (
            <label>
              Type DELETE to confirm
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                disabled={pending}
                autoComplete="off"
              />
            </label>
          )}
          <div className="delete-actions">
            <button
              className="danger"
              disabled={pending || (!id && confirmation !== "DELETE")}
              onClick={() => remove.mutate()}
            >
              {pending ? "Deleting…" : label}
            </button>
            <button disabled={pending} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {remove.error && (
        <p className="error-banner" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
    </div>
  );
}
