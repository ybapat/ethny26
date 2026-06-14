/** Redaction.tsx — the privacy demo: shown to an outsider in place of any private
 * panel. On Canton a non-stakeholder never receives the data at all. */
export function Redaction({ what }: { what: string }) {
  return (
    <div className="redact">
      <div className="redact-content rise">
        <div className="redact-lock">🔒</div>
        <div className="redact-title">Private</div>
        <div className="redact-sub">
          You're not a counterparty here, so there's no {what} to show you. On
          Canton this data never even reaches an outsider — only the two traders,
          the venue, and the regulator can see it. Switch to <strong>Alice</strong>,{" "}
          <strong>Bob</strong>, <strong>Venue</strong> or <strong>Regulator</strong> to look inside.
        </div>
        <div className="redact-bars">
          {[240, 300, 200, 260].map((w, i) => (
            <div key={i} className="redact-bar" style={{ width: w }} />
          ))}
        </div>
      </div>
    </div>
  );
}
