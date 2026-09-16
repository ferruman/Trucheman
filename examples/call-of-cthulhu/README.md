# The Call of Cthulhu — a complete Trucheman run

H. P. Lovecraft, _The Call of Cthulhu_ (Weird Tales, February 1928; public domain), translated
English → Russian by Trucheman v0.2.0 in one job, high quality mode, with no manual edits to the
output. This folder holds the whole run so you can check the claims in the main README against a
real book rather than three curated paragraphs:

| File                                                                 | What it is                                                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`source.epub`](source.epub)                                         | The input. A Project Gutenberg build with the Gutenberg header, license and references removed, as their license permits. EPUBCheck-clean.                      |
| [`output.epub`](output.epub)                                         | The result exactly as Trucheman built it. Open it in any reader.                                                                                                |
| [`reports/quality-report.json`](reports/quality-report.json)         | Every critic finding, what the repair did with it, and what stayed unresolved.                                                                                  |
| [`reports/consistency-report.json`](reports/consistency-report.json) | Entity evidence, book-wide naming decisions, glossary adherence per block.                                                                                      |
| [`reports/glossary.json`](reports/glossary.json)                     | The 67-entry glossary the entity registry generated before translation started.                                                                                 |
| [`reports/style-profile.json`](reports/style-profile.json)           | The style profile the preflight derived and appended to every prompt.                                                                                           |
| [`reports/usage-report.json`](reports/usage-report.json)             | Requests and tokens per stage and model.                                                                                                                        |
| [`reports/epubcheck.txt`](reports/epubcheck.txt)                     | `0 fatals / 0 errors / 0 warnings` on the output.                                                                                                               |
| [`sample.html`](sample.html)                                         | A four-passage, print-ready sample for a non-technical reader: draft vs. final with the critic's interventions, no JSON. Open it in a browser and print to PDF. |

## The run

- **Text**: 11,948 source words, 128 blocks, 10 batches.
- **Models**: translation `deepseek-v4-flash`; literary editing and repair `gpt-5.6-luna`;
  critic `deepseek-v4-pro` (a different model family from the editor, on purpose); consistency
  `deepseek-v4-flash`. Post-repair audit on.
- **Time and spend**: 6 minutes wall clock; 47 requests, 452k tokens in total
  (translation 68k, editing 97k, critic 123k, repair 25k, consistency 139k). Well under half a
  dollar at September 2026 API prices.
- **What each stage did**: the editor changed 105 of 128 blocks. The critic raised 10 findings on
  9 blocks; repair resolved 8 of them. Of the other two, one correct repair was rejected by a guard
  (see below) and one the repair model declined to change; both are `high`, which is why the job
  finished as `needs_attention` rather than `completed`. The deterministic scan found no empty, untranslated, number-dropping or
  source-residue blocks.
- **Consistency**: 71 book-wide decisions, 12 mechanical normalizations, glossary adherence
  27/27 blocks for _Ктулху_, 21/21 for _Юхансен_, 19/19 for _Леграсс_ and _Уилкокс_.

The models were configured through `.env.local` exactly as the README describes; nothing here
used a private build or prompt.

## Five blocks through the pipeline

Each block is shown as the translator wrote it, as the editor rewrote it, what the critic said,
and what the reader gets. Bold marks the span the next stage changed. Run
`npm run trace:segment -- data/jobs/<id> <segment-id>` on any job to get the same view for any
block.

### 1. The opening paragraph

> The most merciful thing in the world, I think, is the inability of the human mind to correlate
> all its contents. We live on a placid island of ignorance in the midst of black seas of
> infinity, and it was not meant that we should voyage far. The sciences, each straining in its
> own direction, have hitherto harmed us little; but some day the piecing together of dissociated
> knowledge will open up such terrifying vistas of reality, and of our frightful position therein,
> that we shall either go mad from the revelation or flee from the deadly light into the peace and
> safety of a new dark age.

**Translation** — faithful, slightly stiff:

> Самое милосердное в мире, думаю я, это неспособность человеческого разума **увязать между собою
> всё, что он содержит**. Мы живём на спокойном островке неведения посреди чёрных морей
> бесконечности, и не суждено нам плавать далеко. Науки, каждая в своём направлении, доселе мало
> нам вредили; но однажды соединение разрозненных знаний откроет перед нами столь устрашающие виды
> действительности и того ужасного положения, которое мы в ней занимаем, что мы либо сойдём с ума
> от этого откровения, либо **отвратимся от гибельного света и укроемся** в покое и безопасности
> нового тёмного века.

**Literary edit** — tighter, but it introduces a calque:

> Самое милосердное в мире, думаю я, — это неспособность человеческого разума связать воедино всё,
> что в нём содержится. Мы живём на безмятежном островке неведения посреди чёрных морей
> бесконечности, и не суждено нам **далеко заплывать**. Науки, каждая из которых стремится в своём
> направлении, до сих пор мало нам вредили; но однажды соединение разрозненных знаний откроет перед
> нами столь устрашающие виды действительности и нашего ужасного положения в ней, что мы либо
> сойдём с ума от этого откровения, либо бежим от гибельного света в покой и безопасность нового
> тёмного века.

**Critic** (`source_language_interference`, medium): _«далеко заплывать» — калька с «voyage far»;
«заплывать» означает лишь плавание вплавь; естественно «плавать далеко»._

**Final**: `…и не суждено нам далеко плавать.` Everything else from the edit kept.

### 2. The locked box: a meaning error the editor made and the critic caught

> It had been locked, and I did not find the key till it occurred to me to examine the personal
> ring which the professor carried always in his pocket.

**Translation**: `…осмотреть личную связку ключей, которую профессор всегда носил в кармане.`

**Literary edit**: `…осмотреть **перстень**, который профессор всегда носил в кармане.`

The editor, polishing the sentence, turned a key ring into a signet ring. The stronger prose model
made a mistake the cheaper translator had not.

**Critic** (`semantic_error`, medium): _«personal ring» здесь — кольцо для ключей, а не перстень;
профессор носил в кармане связку ключей, а не украшение._

**Final**: `…осмотреть связку ключей, которую профессор всегда носил в кармане.` The rest of the
editor's paragraph — _«как следует разобрать его бумаги», «стал верить в самые примитивные
обманы»_ — survives.

### 3. Johansen's voyage: "God knows"

The last sentence of a long paragraph:

> All this Johansen did not suspect, but God knows he soon saw enough!

**Translation**: `Ничего этого Юхансен не подозревал, но Бог знает, что вскоре он увидел достаточно!`

**Literary edit**: `Ничего этого Юхансен не подозревал, но, **ведомый Богом**, вскоре увидел достаточно!`

**Critic** (`semantic_error`, high): _«God knows» — «одному Богу известно», а не то, что Юхансен
был ведом Богом._ In the same block it also flagged _«извергах культа»_ as a calque
(`unnatural_language`, medium).

**Final**: `Ничего этого Юхансен не подозревал, но, одному Богу известно, он вскоре увидел
достаточно!` and `О смуглых культистах на «Алерте»…`. The edit's other gains stay: _«Эмма»,
принявшая балласт_, _берег, сложенный из грязи, ила и покрытой водорослями циклопической кладки_,
_за неизмеримые эоны до начала истории_.

### 4. The statuette: a long descriptive sentence, and a repair that was wrongly rejected

> It represented a monster of vaguely anthropoid outline, but with an octopuslike head whose face
> was a mass of feelers, a scaly, rubbery-looking body, prodigious claws on hind and fore feet,
> and long, narrow wings behind.

**Translation** — one breathless sentence, as in English:

> Она изображала чудовище с неясно человекоподобными очертаниями, но с головой осьминога, чьё лицо
> представляло собой массу щупалец, с чешуйчатым, словно резиновым телом, чудовищными когтями на
> задних и передних лапах и длинными узкими крыльями за спиной.

**Literary edit** — the same information, restructured the way Russian descriptive prose carries
a list:

> Она изображала чудовище с неясно человекоподобными очертаниями, но с головой осьминога: лицо его
> представляло собой сплошную массу щупалец; тело было чешуйчатым, словно резиновым; на задних и
> передних лапах росли огромные когти, а за спиной тянулись длинные узкие крылья.

Further down the same block the editor wrote _«Головоногое существо наклонило голову вперёд»_ for
"The cephalopod head was bent forward". The critic flagged it (`semantic_error`, high: the head
_is_ bent, the creature does not bend it), and the repair produced the right sentence — _«Голова
головоногого существа была наклонена вперёд»_ — but `applySelectiveRepairs` rejected it with
"repair duplicates an adjacent fragment", a false positive of the duplicate-guard, so the reader
gets the editor's version. This is one of the two unresolved `high` findings and the reason the job
is `needs_attention`. The guard has since been fixed to require most of a word to repeat, not
just a stem.

### 5. Mythos terminology and the couplet

The chant and its gloss:

> "Ph'nglui mglw'nafh Cthulhu R'lyeh wgah'nagl fhtagn."
> "In his house at R'lyeh dead Cthulhu waits dreaming."

**Translation**:

> — Пх'нглуи мглв'нафх Ктулху Р'лайе вгах'нагл фхтагн.
> — В своём доме в Р'лайе мёртвый Ктулху ждёт, видя сны.

**Literary edit**:

> — Пх'нглуи мглв'нафх Ктулху **Р'лайх** вгах'нагл фхтагн.
> — В своём доме в Р'лайе мёртвый Ктулху ждёт, **грезя**.

The Russian dialogue dash instead of quotation marks comes from the Russian language module, not
from the model. _грезя_ for "dreaming" is the editor earning its keep. _Р'лайх_ is a miss: the
glossary carried `R'lyeh → Р'лайе` and the consistency pass kept all eight prose occurrences on
it, but the entity registry had also produced a separate two-word entry `Cthulhu R'lyeh → Ктулху
Р'лайх`, which legitimized the variant inside the chant. The two chant lines in the output read
_Р'лайх_, the rest of the book _Р'лайе_. The registry now rewrites a multi-word entity to spell a
contained name the way that name's own entry does.

The couplet needed no help from anyone downstream of the translator:

> "That is not dead which can eternal lie,
> And with strange eons even death may die."

> «Не мёртво то, что в вечности лежит,
> И со странными эонами даже смерть может умереть».

## Where this run falls short

We are showing the output as built, so here is what a careful reader will find:

- The two unresolved `high` findings. One is the rejected repair above. The other is the critic
  objecting to _«в несколько миль высотой»_ for "miles high" as adding indefiniteness; the repair
  model declined to change it, and we agree with the repair model. A critic can be wrong, which is
  why findings are reported rather than applied blindly.
- _Р'лайе_ / _Р'лайх_ in the chant, explained above.
- The critic asked for _Weird Tales_ to be transliterated (_«Уирд Тейлз»_) and the repair obliged.
  A human editor would probably keep the Latin title of a magazine. Reasonable people differ; the
  trace shows exactly who decided what.
- The critic changed _галеон_ to _галион_ as "the normative form". Both forms exist in Russian.
- Lovecraft's 1928 vocabulary for race and ethnicity — _негр_, _эскимосы_, _китайцы_, _смуглые
  культисты_ — is carried over as written. Trucheman translates the author's text; it does not
  modernize, soften or annotate it, and no stage in the pipeline generated any of this wording on
  its own. Readers who want a different policy for period vocabulary should set it in the job
  instructions, where it reaches every stage.

## Reproduce it

```sh
git clone https://github.com/ferruman/Trucheman.git && cd Trucheman
cp .env.example .env.local     # add keys; the models used here are listed under "The run" above
npm install && npm run dev
```

Then, in the UI at `http://127.0.0.1:4173`: new job, English → Russian, upload
`examples/call-of-cthulhu/source.epub`, quality **High**, start. Or drive the same steps through the
API:

```sh
J=http://127.0.0.1:4173/api/jobs
ID=$(curl -s -X POST $J -H 'content-type: application/json' \
  -d '{"title":"The Call of Cthulhu","sourceLanguage":"en","targetLanguage":"ru"}' | jq -r .id)
curl -s -X PUT $J/$ID/source -H 'content-type: application/epub+zip' \
  --data-binary @examples/call-of-cthulhu/source.epub
curl -s -X PUT $J/$ID/config -H 'content-type: application/json' -d '{"qualityMode":"high"}'
curl -s -X POST $J/$ID/analyze && curl -s -X POST $J/$ID/start
```

Models are not deterministic, so your run will differ in wording; the structure of the result —
journals per stage, a quality report, a consistency report, a validated EPUB — will not.

## Provenance

The English text is Lovecraft's, public domain. `source.epub` derives from Project Gutenberg
eBook #68283; the Gutenberg header, the license section and all references to the Project were
removed as its license permits for distribution without the Gutenberg trademark. The Russian text
was produced by the models named above in this run and is released with the repository under the
MIT license. No published Russian translation was consulted or copied.
