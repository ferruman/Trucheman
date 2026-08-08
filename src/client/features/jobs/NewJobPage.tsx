import { useState } from "react";
import { LANGUAGES } from "../../../shared/languages";
import { api, jobActions, uploadSource } from "../../app/api";

export function NewJobPage() {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("en");
  const [target, setTarget] = useState("ru");
  const [file, setFile] = useState<File>();
  const [createdJobId, setCreatedJobId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function prepare(jobId: string, selectedFile: File) {
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

  return <section>
    <h2>New book</h2>
    <form onSubmit={submit} aria-busy={busy}>
      <label>EPUB file<input disabled={busy} required type="file" accept=".epub,application/epub+zip" onChange={event => setFile(event.target.files?.[0])}/></label>
      <label>Title<input disabled={busy || Boolean(createdJobId)} value={title} onChange={event => setTitle(event.target.value)}/></label>
      <label>Source<select disabled={busy || Boolean(createdJobId)} value={source} onChange={event => {
        const nextSource = event.target.value;
        setSource(nextSource);
        if (nextSource === target) setTarget(LANGUAGES.find(language => language.tag !== nextSource)!.tag);
      }}>{LANGUAGES.map(language => <option key={language.tag} value={language.tag}>{language.name}</option>)}</select></label>
      <label>Target<select disabled={busy || Boolean(createdJobId)} value={target} onChange={event => setTarget(event.target.value)}>{LANGUAGES.map(language => <option disabled={language.tag === source} key={language.tag} value={language.tag}>{language.name}</option>)}</select></label>
      <button disabled={busy} type="submit">{busy ? "Preparing…" : createdJobId ? "Retry upload and analysis" : "Upload and analyze"}</button>
      {error && <div role="alert">
        <p>{error}</p>
        {createdJobId && <p>The job was created. You can retry without creating a duplicate or <a href={`/jobs/${createdJobId}`}>open its saved state</a>.</p>}
      </div>}
      {createdJobId && !busy && <button className="secondary" type="button" onClick={() => { setCreatedJobId(""); setError(""); }}>Start a separate job</button>}
    </form>
  </section>;
}
