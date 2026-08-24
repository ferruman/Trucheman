import { useCallback, useEffect, useState } from "react";
import { jobActions, type StyleProfile } from "../../app/api";

const FIELDS = [
  ["genre", "Genre"],
  ["narrativeVoice", "Narrative voice"],
  ["tone", "Tone"],
  ["register", "Register"],
] as const;

/**
 * The style profile the preflight derived, and the only place to correct it. A wrong reading of
 * the voice reaches every batch of the book, so it is worth a look before the run that uses it.
 */
export function StyleProfilePanel({ id, onSaved }: { id: string; onSaved: () => void }) {
  const [profile, setProfile] = useState<StyleProfile | null>(null);
  const [draft, setDraft] = useState<StyleProfile>({});
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setProfile((await jobActions.styleProfile(id)).profile);
    } catch {
      setProfile(null);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!profile) return null;

  function startEditing() {
    setDraft({ ...profile });
    setNotes((profile?.notes ?? []).join("\n"));
    setError("");
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const body: StyleProfile = { ...draft, notes: notes.split("\n").filter((n) => n.trim()) };
      setProfile((await jobActions.saveStyleProfile(id, body)).profile);
      setEditing(false);
      // Saving invalidates every stage, so the job's status changed under the page.
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the style profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="operation-panel" aria-labelledby="style-profile-heading">
      <div className="panel-heading">
        <span className="section-label">Preflight</span>
        <h2 id="style-profile-heading">Book style profile</h2>
      </div>
      {!editing && (
        <>
          <dl className="detail-list">
            {FIELDS.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{profile[key] ?? "—"}</dd>
              </div>
            ))}
            {(profile.notes?.length ?? 0) > 0 && (
              <div>
                <dt>Notes</dt>
                <dd>
                  <ul>
                    {profile.notes?.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
          <div className="actions">
            <button className="secondary" type="button" onClick={startEditing}>
              Correct this profile…
            </button>
          </div>
        </>
      )}
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="field-help">
            This block is appended to the instructions of every stage, so saving it discards all
            completed work and the book is translated again from the start.
          </p>
          {FIELDS.map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                value={draft[key] ?? ""}
                maxLength={600}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
            </label>
          ))}
          <label>
            <span>Notes, one per line</span>
            <textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="actions">
            <button disabled={busy} type="submit">
              {busy ? "Saving…" : "Save and invalidate"}
            </button>
            <button
              className="secondary"
              disabled={busy}
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
