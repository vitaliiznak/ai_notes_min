import { useState } from "react";
import { api, errorMessage } from "../api";

export function DeleteNotes({ id, onDeleted }: { id?: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const label = id ? "Delete note" : "Delete all notes";

  async function remove() {
    setPending(true);
    setError(null);
    try {
      if (id) await api.deleteNote(id);
      else await api.deleteAllNotes();
      setConfirming(false);
      setConfirmation("");
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="delete-notes">
      {!confirming ? (
        <button className="text-button danger" onClick={() => setConfirming(true)}>{label}</button>
      ) : (
        <div className="delete-confirmation" role="group" aria-label={label}>
          <p>{id ? "Permanently delete this note?" : "Permanently delete every note, including notes hidden by a tag filter?"} This cannot be undone.</p>
          {!id && <label>Type DELETE to confirm<input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={pending} autoComplete="off" /></label>}
          <div className="delete-actions">
            <button className="danger" disabled={pending || (!id && confirmation !== "DELETE")} onClick={remove}>{pending ? "Deleting…" : label}</button>
            <button disabled={pending} onClick={() => { setConfirming(false); setError(null); setConfirmation(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error-banner" role="alert">{error}</p>}
    </div>
  );
}
