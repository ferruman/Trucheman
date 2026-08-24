import { useEffect, useRef } from "react";
import type { InvalidationStage } from "../../../shared/domain/job";

type Props = {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (from: InvalidationStage) => void;
};

/** Cheapest re-run first: the stages above the chosen one are replayed from their checkpoints. */
const CHOICES: Array<{ from: InvalidationStage; label: string; detail: string }> = [
  {
    from: "audit",
    label: "Re-run the quality audit",
    detail: "Keeps the translation and the edits. Only the critic and its repairs run again.",
  },
  {
    from: "editing",
    label: "Re-run editing",
    detail: "Keeps the draft translation. Editing, audit and repairs run again.",
  },
  {
    from: "translation",
    label: "Re-translate the book",
    detail: "Discards every checkpoint, including settled entity renderings.",
  },
];

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
      <h3 id="invalidation-title">How much work should run again?</h3>
      <p>
        Whatever is kept is reused from its checkpoint at no cost. The previous successful file
        remains available until its replacement succeeds.
      </p>
      <div className="stage-choices">
        {CHOICES.map((choice) => (
          <button
            key={choice.from}
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => onConfirm(choice.from)}
          >
            <strong>{choice.label}</strong>
            <small>{choice.detail}</small>
          </button>
        ))}
      </div>
      <div className="actions">
        <button className="secondary" disabled={busy} type="button" onClick={onCancel}>
          Cancel
        </button>
        {busy ? <span>Invalidating…</span> : null}
      </div>
    </dialog>
  );
}
