<p align="center">
  <img src="docs/assets/trucheman-hero.webp" alt="Pixel-art EPUB translation pipeline running through a retro terminal" width="1200">
</p>

<h1 align="center">Trucheman</h1>

<p align="center">
  <strong>Translate books, not just strings.</strong><br>
  An open-source literary translation pipeline for EPUB books, not an LLM wrapper:<br>
  translation → literary editing → book-wide consistency → independent critique → selective repair → validated EPUB.<br>
  Local-first and resumable.
</p>

<p align="center">
  <a href="https://github.com/ferruman/Trucheman/actions/workflows/ci.yml"><img src="https://github.com/ferruman/Trucheman/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/ferruman/Trucheman/actions/workflows/container.yml"><img src="https://github.com/ferruman/Trucheman/actions/workflows/container.yml/badge.svg" alt="Container status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f2c14e" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Node.js-24%2B-5fa04e" alt="Node.js 24 or newer">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ed?logo=docker&logoColor=white" alt="Docker Compose">
</p>

> [!IMPORTANT]
> Trucheman is pre-1.0 and under active development. Keep backups of source books and local job
> data when upgrading.

## See it in action

<p align="center">
  <img src="docs/assets/trucheman-demo.gif" alt="Trucheman importing, translating, validating, and reporting usage for an EPUB" width="960">
</p>

The demo uses the deterministic local provider: no API key, network request, or staged mockup. It
runs the same import, translation, editing, build, validation, and reporting flow used by a live
provider.

## What the pipeline changes

One paragraph from H. P. Lovecraft's _The Call of Cthulhu_ (1928, public domain), taken from a real
Trucheman job. Both stages ran `deepseek-v4-flash`; nothing was hand-edited.

> Then the men, having reached a spot where the trees were thinner, came suddenly in sight of the
> spectacle itself. Four of them reeled, one fainted, and two were shaken into a frantic cry which
> the mad cacophony of the orgy fortunately deadened. Legrasse dashed swamp water on the face of
> the fainting man, and all stood trembling and nearly hypnotized with horror.

**After translation** — accurate, but reads like a translation:

> Затем люди, достигнув места, где деревья становились реже, внезапно увидели само зрелище.
> Четверо из них пошатнулись, один **упал в обморок**, а двое разразились неистовым криком,
> который, к счастью, заглушила безумная какофония оргии. Леграсс плеснул болотной водой в лицо
> **упавшему в обморок**, и все стояли, дрожа и **почти загипнотизированные** ужасом.

**After literary editing** — same meaning, native prose:

> Затем люди, добравшись до места, где деревья росли реже, внезапно увидели само зрелище.
> Четверо из них пошатнулись, один **лишился чувств**, а двое исторгли безумный крик, который,
> к счастью, заглушила дикая какофония оргии. Леграсс плеснул болотной водой в лицо
> **потерявшему сознание**, и все стояли, дрожа и **едва не загипнотизированные** ужасом.

The editor removed the repeated clinical "упал в обморок", replaced the "reached a spot where the
trees became thinner" calque with how a Russian narrator would put it, and fixed the awkward
"почти загипнотизированные". The consistency stage then keeps names such as _Леграсс_ identical
across chapters, and the optional critic audits every edited segment and repairs only validated
findings. Run `npm run trace:segment` on any job to see the same source → draft → edit → audit →
repair chain for any paragraph.

For a whole book rather than a paragraph, see
[examples/call-of-cthulhu](examples/call-of-cthulhu/README.md): the complete v0.2.0 run on
Lovecraft's _The Call of Cthulhu_ — source and output EPUBs, every critic finding and repair, the
consistency and usage reports, five blocks traced stage by stage, and an honest list of what the
run got wrong.

## Why Trucheman?

|                         |                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **EPUB-aware**          | Preserves book structure and formatting instead of treating an EPUB as one giant text file.          |
| **Literary pipeline**   | Separates translation, editing, consistency, optional critique, and targeted repair.                 |
| **Local-first**         | Keeps source books, checkpoints, reports, and generated EPUBs on your machine.                       |
| **Safe to interrupt**   | Resumes durable jobs without paying for completed provider calls twice.                              |
| **Standard or Batch**   | Runs immediately through Chat Completions or asynchronously through the OpenAI Batch API.            |
| **Validated output**    | Checks archive safety, rebuilt structure, untranslated fragments, consistency, and EPUB conformance. |
| **Visible model usage** | Reports request and token totals for every pipeline stage and exact model.                           |

## Quick start

You need Docker Desktop or Docker Engine with the Compose plugin.

```sh
git clone https://github.com/ferruman/Trucheman.git
cd Trucheman
cp .env.example .env
docker compose up -d
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Without provider credentials, Trucheman uses
its deterministic local provider, so you can safely explore the complete workflow first.

For live translation, add your provider keys and models to `.env`, then restart:

```sh
docker compose restart
```

Job data survives container replacement in the `trucheman-data` volume. Keys are mounted through
Docker Compose secrets, the service runs as a non-root user, and the port is exposed only on the
loopback interface.

```sh
docker compose logs -f                 # follow startup and jobs
docker compose pull && docker compose up -d  # update
docker compose down                    # stop without deleting books
```

Do not run `docker compose down -v` unless you intend to delete all local Trucheman data. The
[Docker guide](docs/docker.md) covers installation, updates, backup, and restore.

## The pipeline

```text
Import → Inspect → Translate → Literary edit → Consistency → Build → Validate
                               ↘ Critic → selective repair ↗
```

- **Standard quality** translates, edits, and applies book-wide consistency decisions.
- **High quality** additionally audits every edited segment and repairs only validated medium- or
  high-severity findings.
- **Standard processing** starts provider requests immediately.
- **Batch processing** submits durable asynchronous work to the official OpenAI Batch API, which
  can reduce provider cost at the expense of latency.

Pausing or restarting Trucheman preserves completed checkpoints and submitted batch identifiers.
Changing a quality mode keeps reusable work whenever the pipeline boundary allows it.

## Language support

The UI offers English, Russian, German, Polish, and Japanese in any direction. The pipeline itself
is language-generic: every stage receives the source and target language and works from the
model's own knowledge. Language modules add deterministic rules on top of that:

| Module                 | Adds                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Russian** (target)   | Typography (ё, «ёлочки», dialogue dashes), name-ending awareness for consistency checks, written-number detection, an EPUB audit, and agreement repair. |
| **Japanese** (source)  | Vertical-to-horizontal layout conversion, furigana-driven readings, honorific and name-order policy, sentence-final particle handling, smaller batches. |
| **Japanese → Russian** | Polivanov transliteration rules.                                                                                                                        |

English, German, and Polish currently run on the generic pipeline alone. Everything shipped so far
has been exercised on English → Russian and Japanese → Russian books, and the regression corpus
covers those two pairs; treat other directions as untested and start with a short book. Adding a
language is a registry entry plus optional capabilities, described in
[Language modules](docs/language-modules.md).

<details>
<summary><strong>Provider configuration</strong></summary>

Translation, literary editing, critique, and consistency can use independently configured
provider profiles. The built-in `openai-chat` transport speaks the OpenAI-compatible Chat
Completions protocol; each profile can select another registered transport independently. A
minimal DeepSeek configuration looks like this:

```dotenv
TRUCHEMAN_TRANSLATION_API_KEY=your-key
TRUCHEMAN_EDITING_API_KEY=your-key
TRUCHEMAN_TRANSLATION_TRANSPORT=openai-chat
TRUCHEMAN_EDITING_TRANSPORT=openai-chat
TRUCHEMAN_TRANSLATION_MODEL=deepseek-v4-flash
TRUCHEMAN_EDITING_MODEL=deepseek-v4-flash
TRUCHEMAN_CRITIC_MODEL=deepseek-v4-flash
TRUCHEMAN_CONSISTENCY_MODEL=deepseek-v4-flash
```

The corresponding `*_TRANSPORT` variables are also available for critic and consistency. Repair
uses the editing transport. Application services call a single provider gateway; a new API
protocol is added as a registry adapter without changing the translation pipeline.

Omitted critic settings inherit the editing profile. Omitted consistency settings inherit the
translation profile. Restart the service after editing `.env`.

Using one model for every stage is supported and is the simplest way to start. For stronger
production results, configure separate models by role:

- a faithful, cost-efficient model for translation;
- a stronger prose model for literary editing and repair;
- an independent critic model, preferably from a different model family, to reduce correlated
  blind spots;
- a consistency model chosen for structured reasoning over terminology and entities.

Validate a model combination on a short representative chapter before committing a whole book;
different languages and genres can favor different combinations.

Batch mode requires the official `https://api.openai.com/v1/chat/completions` endpoint for every
configured profile and compatible OpenAI models. Trucheman rejects other endpoints before
uploading book text.

> [!NOTE]
> The live translation pipeline has been tested with OpenAI and DeepSeek APIs. Other
> OpenAI-compatible providers and models may work, but are not part of the supported compatibility
> baseline yet; try them on a small book first and keep the source EPUB and job data backed up.

</details>

## Drive it from an AI assistant

Trucheman ships an [MCP](https://modelcontextprotocol.io) server, so Claude Code, Claude Desktop
or any MCP client can run the whole pipeline in conversation: "translate this EPUB into Russian,
high quality" → the assistant uploads the book, starts the job, waits, and hands back the report
and the finished file. The repository's `.mcp.json` registers it for Claude Code; for other
clients, the command is `npm run mcp` with `TRUCHEMAN_URL` pointing at a running instance
(default `http://127.0.0.1:4173`).

| Tool              | Does                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| `translate_book`  | create job → upload `.epub` → set quality and instructions → analyze → start        |
| `wait_for_job`    | block until the job finishes or a timeout passes; call again if it is still running |
| `job_status`      | status, stage, batches done                                                         |
| `job_report`      | validation, EPUBCheck, critic findings and repairs, consistency, usage per model    |
| `download_output` | save the translated EPUB to a path                                                  |
| `control_job`     | pause, resume, or retry                                                             |
| `list_jobs`       | every job on this instance                                                          |

The MCP server is a client of the same local HTTP API the browser UI uses; it holds no
credentials and adds no second way into the pipeline.

## Privacy and boundaries

Trucheman is a single-user local application. It stores books and job state locally, but a live
provider run sends eligible book text to the APIs you configure. It does not provide authentication
and must not be exposed directly to the public internet.

Use only DRM-free books you have the right to process. Never commit `.env`, source books, or local
job data. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development

Requirements: Node.js 24 or newer.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

The development server listens on `127.0.0.1:4173`. Copy `.env.example` to `.env.local` for local
provider credentials; `.env.local` takes precedence over `.env`.

The versioned literary regression corpus uses public-domain passages from _Alice's Adventures in
Wonderland_ and _Botchan_, paired with deliberately flawed repository-authored Russian drafts:

```sh
npm run eval:literary:golden -- --limit 5 # inexpensive smoke sample; no gate
npm run eval:literary:golden             # full corpus; enforces the 85% acceptance floor
```

These commands use the configured editing provider and write ignored reports under
`eval-results/`. Source provenance is recorded in [tests/fixtures/NOTICE.md](tests/fixtures/NOTICE.md).

## Project docs

- [Product overview](PRODUCT.md)
- [Architecture](ARCHITECTURE.md)
- [Language modules](docs/language-modules.md)
- [Roadmap](ROADMAP.md)
- [Showcase: The Call of Cthulhu, complete run](examples/call-of-cthulhu/README.md)
- [Docker operations](docs/docker.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## License

Trucheman is available under the [MIT License](LICENSE).
