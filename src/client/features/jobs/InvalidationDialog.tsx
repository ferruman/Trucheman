import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function InvalidationDialog({ open, busy, onCancel, onConfirm }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="invalidation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h3 id="invalidation-title">Invalidate completed work?</h3>
      <p>
        Translations, edits, and the current output will need to be generated again. The previous
        successful file remains available until its replacement succeeds.
      </p>
      <div className="actions">
        <button className="secondary" disabled={busy} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button disabled={busy} type="button" onClick={onConfirm}>
          {busy ? "Invalidating…" : "Invalidate and rebuild"}
        </button>
      </div>
    </dialog>
  );
}
