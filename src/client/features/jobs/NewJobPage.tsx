import { useState } from "react";
import { LANGUAGES } from "../../../shared/languages";
import { api, jobActions, uploadSource } from "../../app/api";

type GlossaryDraft = {
  source: string;
  target: string;
  category: string;
  note: string;
  enabled: boolean;
};

const emptyGlossaryEntry = (): GlossaryDraft => ({
  source: "",
  target: "",
  category: "proper name",
  note: "",
  enabled: true,
});

export function NewJobPage() {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("en");
  const [target, setTarget] = useState("ru");
  const [file, setFile] = useState<File>();
  const [instructions, setInstructions] = useState("");
  const [glossary, setGlossary] = useState<GlossaryDraft[]>([]);
  const [createdJobId, setCreatedJobId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function prepare(jobId: string, selectedFile: File) {
    await jobActions.configure(jobId, {
      instructions,
      glossary: glossary.map((entry, index) => ({
        ...entry,
        id: `glossary-${index + 1}`,
        note: entry.note || undefined,
      })),
    });
    await uploadSource(jobId, selectedFile);
    await jobActions.analyze(jobId);
    location.href = `/jobs/${jobId}`;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose an EPUB file first");
      return;
    }
    if (source === target) {
      setError("Source and target languages must differ");
      return;
    }
    if (
      glossary.some(
        (entry) => !entry.source.trim() || !entry.target.trim() || !entry.category.trim(),
      )
    ) {
      setError("Complete every glossary term, target, and category before continuing");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let jobId = createdJobId;
      if (!jobId) {
        const job = await api.create({
          title: title || file.name.replace(/\.epub$/i, ""),
          sourceLanguage: source,
          targetLanguage: target,
        });
        jobId = job.id;
        setCreatedJobId(jobId);
      }
      await prepare(jobId, file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the book");
      setBusy(false);
    }
  }

  return (
    <section className="page new-job-page">
      <header className="page-header">
        <div>
          <span className="section-label">Create job</span>
          <h1>New book</h1>
        </div>
      </header>
      <form onSubmit={submit} aria-busy={busy}>
        <label>
          EPUB file
          <input
            disabled={busy}
            required
            type="file"
            accept=".epub,application/epub+zip"
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
        <label>
          Title
          <input
            disabled={busy || Boolean(createdJobId)}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Source
          <select
            disabled={busy || Boolean(createdJobId)}
            value={source}
            onChange={(event) => {
              const nextSource = event.target.value;
              setSource(nextSource);
              if (nextSource === target)
                setTarget(LANGUAGES.find((language) => language.tag !== nextSource)!.tag);
            }}
          >
            {LANGUAGES.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target
          <select
            disabled={busy || Boolean(createdJobId)}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {LANGUAGES.map((language) => (
              <option disabled={language.tag === source} key={language.tag} value={language.tag}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <section className="glossary-editor" aria-labelledby="glossary-heading">
          <div>
            <h3 id="glossary-heading">Glossary</h3>
            <p className="muted">
              Add terms whose translations should stay consistent throughout the book.
            </p>
          </div>
          {glossary.length > 0 && (
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Glossary entries</caption>
                <thead>
                  <tr>
                    <th scope="col">Source term</th>
                    <th scope="col">Target term</th>
                    <th scope="col">Category</th>
                    <th scope="col">Note</th>
                    <th scope="col">Use</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {glossary.map((entry, index) => (
                    <tr key={index}>
                      <td>
                        <input
                          aria-label={`Glossary source term ${index + 1}`}
                          disabled={busy}
                          required
                          value={entry.source}
                          onChange={(event) =>
                            setGlossary((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, source: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Glossary target term ${index + 1}`}
                          disabled={busy}
                          required
                          value={entry.target}
                          onChange={(event) =>
                            setGlossary((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, target: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Glossary category ${index + 1}`}
                          disabled={busy}
                          required
                          value={entry.category}
                          onChange={(event) =>
                            setGlossary((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, category: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Glossary note ${index + 1}`}
                          disabled={busy}
                          value={entry.note}
                          onChange={(event) =>
                            setGlossary((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, note: event.target.value } : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <label className="checkbox-label">
                          <input
                            aria-label={`Enable glossary term ${index + 1}`}
                            disabled={busy}
                            type="checkbox"
                            checked={entry.enabled}
                            onChange={(event) =>
                              setGlossary((current) =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, enabled: event.target.checked }
                                    : item,
                                ),
                              )
                            }
                          />{" "}
                          Enabled
                        </label>
                      </td>
                      <td>
                        <button
                          className="secondary"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            setGlossary((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => setGlossary((current) => [...current, emptyGlossaryEntry()])}
          >
            Add glossary term
          </button>
          <label>
            Shared instructions
            <textarea
              rows={3}
              disabled={busy}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="For example: preserve honorifics and keep chapter titles concise."
            />
          </label>
        </section>
        <button disabled={busy} type="submit">
          {busy ? "Preparing…" : createdJobId ? "Retry upload and analysis" : "Upload and analyze"}
        </button>
        {error && (
          <div role="alert">
            <p>{error}</p>
            {createdJobId && (
              <p>
                The job was created. You can retry without creating a duplicate or{" "}
                <a href={`/jobs/${createdJobId}`}>open its saved state</a>.
              </p>
            )}
          </div>
        )}
        {createdJobId && !busy && (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setCreatedJobId("");
              setError("");
            }}
          >
            Start a separate job
          </button>
        )}
      </form>
    </section>
  );
}
