import { useEffect, useState } from "react";
import { LANGUAGES } from "../../../shared/languages";
import { api, jobActions, uploadSource } from "../../app/api";
import type { JobView } from "../../../shared/domain/job";

type GlossaryDraft = {
  source: string;
  target: string;
  category: string;
  note: string;
  enabled: boolean;
};

/**
 * The categories worth carrying between books. A generated glossary is mostly `term`, because
 * the entity extractor casts wide on purpose: over a volume of 帝都物語 the rule that would have
 * dropped 地面 and 視線 also dropped 加藤保憲, 東京 and 銀座, so the noise is kept and filtered
 * here instead — by then the model has labelled every row and the labels can be trusted.
 */
const NAMED_CATEGORIES = new Set(["person", "place", "organization", "work", "ship"]);

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
  const [qualityMode, setQualityMode] = useState<"standard" | "high">("standard");
  const [glossary, setGlossary] = useState<GlossaryDraft[]>([]);
  const [createdJobId, setCreatedJobId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [importFrom, setImportFrom] = useState("");
  const [importNote, setImportNote] = useState("");
  const [namesOnly, setNamesOnly] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    // Advisory: the page creates books with or without an earlier one to borrow from.
    api.list({ signal: controller.signal }).then(setJobs, () => undefined);
    return () => controller.abort();
  }, []);

  /**
   * A glossary is only meaningful for the pair it was resolved for: an en→ru rendering of a
   * name answers nothing about the same book in ja→ru.
   */
  const borrowable = jobs.filter(
    (job) => job.sourceLanguage === source && job.targetLanguage === target,
  );

  async function importGlossary() {
    const job = borrowable.find((candidate) => candidate.id === importFrom);
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const { entries } = await jobActions.glossary(job.id);
      const existing = new Set(glossary.map((entry) => entry.source.toLocaleLowerCase()));
      const wanted = entries.filter((entry) => !namesOnly || NAMED_CATEGORIES.has(entry.category));
      const added = wanted
        .filter((entry) => !existing.has(entry.source.toLocaleLowerCase()))
        .map((entry) => ({
          source: entry.source,
          target: entry.target,
          category: entry.category,
          note: entry.note ?? "",
          enabled: entry.enabled,
        }));
      const skipped = [
        entries.length - wanted.length && `${entries.length - wanted.length} common term(s)`,
        wanted.length - added.length && `${wanted.length - added.length} already listed`,
      ].filter(Boolean);
      setGlossary((current) => [...current, ...added]);
      setImportNote(
        added.length
          ? `Added ${added.length} term(s) from “${job.title}”${
              skipped.length ? `, skipping ${skipped.join(" and ")}` : ""
            }.`
          : `“${job.title}” has nothing to add${
              skipped.length ? ` — ${skipped.join(" and ")}` : ""
            }.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read that book's glossary");
    } finally {
      setBusy(false);
    }
  }

  async function prepare(jobId: string, selectedFile: File) {
    await jobActions.configure(jobId, {
      instructions,
      qualityMode,
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
        <label>
          Quality mode
          <select
            disabled={busy}
            value={qualityMode}
            onChange={(event) => setQualityMode(event.target.value as "standard" | "high")}
          >
            <option value="standard">Standard — translation and literary edit</option>
            <option value="high">High — audit and selective repair</option>
          </select>
          <small className="field-help">
            High quality audits every edited segment, then pays for another model call only for
            segments with a concrete medium or high-severity defect.
          </small>
        </label>
        <section className="glossary-editor" aria-labelledby="glossary-heading">
          <div>
            <h3 id="glossary-heading">Glossary</h3>
            <p className="muted">
              Add terms whose translations should stay consistent throughout the book.
            </p>
          </div>
          {borrowable.length > 0 && (
            <div className="glossary-import">
              <label>
                Reuse a glossary
                <select
                  disabled={busy}
                  value={importFrom}
                  onChange={(event) => setImportFrom(event.target.value)}
                >
                  <option value="">Choose an earlier book…</option>
                  {borrowable.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.title}
                    </option>
                  ))}
                </select>
                <small className="field-help">
                  Copies the terms that book translated against, generated ones included, so the
                  next volume of a series renders every name the same way.
                </small>
              </label>
              <label className="checkbox-label">
                <input
                  checked={namesOnly}
                  disabled={busy}
                  type="checkbox"
                  onChange={(event) => setNamesOnly(event.target.checked)}
                />
                Names, places and organizations only
              </label>
              <button
                className="secondary"
                disabled={busy || !importFrom}
                type="button"
                onClick={importGlossary}
              >
                Import terms
              </button>
              {importNote && <p role="status">{importNote}</p>}
            </div>
          )}
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
