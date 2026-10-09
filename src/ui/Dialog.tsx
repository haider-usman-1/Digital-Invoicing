import { useEffect, useRef } from "react";

/**
 * A modal dialog.
 *
 * Built on a plain overlay rather than <dialog showModal>, because the submission flow needs to
 * refuse dismissal while a request is in flight and that is simpler to guarantee here than by
 * fighting the native element's cancel behaviour.
 *
 * `busy` is the important prop: while it is true the dialog cannot be closed by Escape, by the
 * backdrop, or by a close button. That is deliberate. FBR has no idempotency key, so the moment
 * where a user cannot tell whether their click registered is exactly the moment they click again
 * and file a duplicate.
 */
export function Dialog({
  title,
  icon,
  busy = false,
  onClose,
  children,
  footer,
}: {
  title: string;
  /** Status glyph or spinner shown beside the title. */
  icon?: React.ReactNode;
  busy?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself, and never mid-request.
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy}
        tabIndex={-1}
        ref={panel}
      >
        <div className="dialog-head">
          {icon}
          <h2>{title}</h2>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** A coloured dot standing in for a status icon, matching the note tones. */
export function StatusDot({ tone }: { tone: "ok" | "warn" | "error" }) {
  const colour = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn-text)" : "var(--danger-text)";
  return (
    <span
      aria-hidden="true"
      style={{ width: 8, height: 8, borderRadius: "50%", background: colour, flex: "none" }}
    />
  );
}
