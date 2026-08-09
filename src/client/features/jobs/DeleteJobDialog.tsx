import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteJobDialog({ open, busy, onCancel, onConfirm }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog ref={ref} aria-labelledby="delete-job-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h3 id="delete-job-title">Delete this job?</h3>
    <p>This permanently removes the source EPUB, translation journals, and generated output. This action cannot be undone.</p>
    <div className="actions">
      <button className="secondary" disabled={busy} type="button" onClick={onCancel}>Cancel</button>
      <button className="danger" disabled={busy} type="button" onClick={onConfirm}>{busy ? "Deleting…" : "Delete job"}</button>
    </div>
  </dialog>;
}
