import { useRef } from "react";

/**
 * Bestätigungs-Dialog vor IRREVERSIBLEN / außen-wirksamen Aktionen (Merge nach main,
 * Stop/Aufräumen mit ungesicherter Arbeit, Force-Operationen). Zeigt die Folgen in Klartext;
 * `danger` färbt den Bestätigen-Button rot. Backdrop schließt nur bei echtem Klick (kein
 * versehentliches Schließen durch eine Textmarkierung, die auf dem Overlay endet).
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Bestätigen",
  cancelLabel = "Abbrechen",
  danger = false,
  secondary,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Optionale dritte Aktion (z. B. „trotzdem …") zwischen Abbrechen und der Primäraktion. */
  secondary?: { label: string; onClick: () => void };
  onConfirm: () => void;
  onClose: () => void;
}) {
  const downOnOverlay = useRef(false);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-title">{title}</div>
        <div className="confirm-body">{body}</div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {cancelLabel}
          </button>
          {secondary && (
            <button
              type="button"
              onClick={() => {
                secondary.onClick();
                onClose();
              }}
            >
              {secondary.label}
            </button>
          )}
          <button
            type="button"
            className={danger ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
