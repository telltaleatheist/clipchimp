# The NLI Flag-Ranking Environment

The local Python environment that Briefcase's flag pipeline ranks with: what it
is, why it exists, exactly what is in it, the contract its worker speaks, the
numbers in it that must not drift, how it gets built, how to build it by hand
when that fails, and what happens when it is missing.

Companion to [`docs/chapter-pipeline-handoff.md`](./chapter-pipeline-handoff.md),
which covers the *chapter* half of the same analysis run. Chapters and flags are
deliberately independent stages — chapter work finishes entirely before any flag
work starts — and this document picks up where that one stops.

> **`docs/` is gitignored** (`.gitignore` line 87: `docs/*`). This file must be
> force-added to be committed: `git add -f docs/nli-flag-ranking.md`.

---

## 1. Why this exists at all

The old flag path asked an LLM to READ a chapter and DISCOVER every quote in it
matching a category. That is open-ended discovery, and it fails the way
open-ended discovery always fails — the same law the chapter pipeline is built
around (`chapter-pipeline-handoff.md` §1: *a mid-size LLM cannot select K items
from N*). Asked for "all the flags in this chapter", the model returns the two
or three most obvious hits and stops. Worse, the timestamps came from matching
the model's quote back to the transcript, so a quote the model reworded landed
nowhere.

The replacement splits the job into the two halves each engine is actually good
at:

```
transcript segments
       │
  [1] SENTENCES     code   breath-length whisper segments -> real sentences,
       │                   each carrying the times of the segments it spans
  [2] RANK          NLI    every sentence AND every sliding 3-sentence window
       │                   scored against every enabled category's stance
       │                   hypotheses. ~90s for a 60-minute video on MPS.
       │                   Nothing is skipped.
  [3] WINDOW        code   hot sentences expanded and merged, category-blind,
       │                   into paragraph-sized passages
  [4] VERIFY        LLM    one tiny schema-constrained call per (window,
                           category): is the speaker ASSERTING this, or
                           reporting / questioning / debunking it?
```

Ranking is exhaustive and cheap, so nothing is "missed because the model stopped
early". Judgement is where the LLM is strong, and it is asked exactly one
question at a time. Timestamps come from the transcript segments the sentence
was assembled from — no model ever emits a time, and there is no phrase matching
on this path.

**Stage 2 is what needs this environment.** It runs
`MoritzLaurer/deberta-v3-base-zeroshot-v2.0` locally, in a resident Python
subprocess, and there is no way to do that without Python, torch and
transformers on the machine.

Measured cost of the widest capture setting on the two reference videos, with
the 27b verifier at ~3s a call — candidates / verify calls / stored FLAG
sections (full table and rationale in the `CAPTURE_THRESHOLD` comment in
`nli-ranker.service.ts`):

|                | watters (12 min, 159 sentences) | hank (60 min, 801 sentences) |
| -------------- | ------------------------------- | ---------------------------- |
| threshold 0.7  | 72 / 56 / 11                    | 79 / 67 / 13   (4m34s)       |
| threshold 0.2  | 119 / 83 / 16                   | 164 / 134 / 27 (9m13s)       |

---

## 2. What the environment is

A single directory. By default:

```
~/Library/Application Support/briefcase/nli/     (macOS)
%APPDATA%\briefcase\nli\                         (Windows)
~/.config/briefcase/nli/                         (Linux)
```

Resolution order, and it is the same order for the ranker and the installer
(one function, `resolveNliDir`, so they can never disagree):

1. `BRIEFCASE_NLI_DIR` environment variable
2. `nliWorkerDir` in `<appSupport>/briefcase/app-config.json`
3. the default above

Contents:

```
nli/
├── venv/            Python virtualenv built from a SYSTEM interpreter
│   ├── bin/python           (Scripts/python.exe on Windows)
│   └── lib/pythonX.Y/site-packages/   torch, transformers, sentencepiece, …
├── hf/              HF_HOME for the worker
│   └── hub/models--MoritzLaurer--deberta-v3-base-zeroshot-v2.0/
│       ├── blobs/      the real files (model.safetensors ≈ 352MB)
│       ├── snapshots/<revision>/   symlinks into blobs/
│       └── refs/main
├── worker.py        copy of backend/python/nli-worker/worker.py
└── install.json     provenance marker (see §7) — never required
```

Measured size on macOS arm64: **venv ≈ 867MB, hf ≈ 362MB, total ≈ 1.2GB**.

Only these files are fetched from the hub, and they are exactly what the
zero-shot pipeline loads — pulling the whole repo would drag in ONNX exports and
duplicate weight formats for nothing:

```
config.json  tokenizer.json  tokenizer_config.json  special_tokens_map.json
added_tokens.json  spm.model  model.safetensors
```

### It is not a download

Every other Briefcase component (ffmpeg, yt-dlp, whisper models, GGUF models) is
an artifact fetched from a URL. This one is **constructed locally**. A virtualenv
is not portable between machines — it hard-codes interpreter paths and links
against a specific libpython — and a 1.2GB per-(OS, arch, Python version) tarball
of one is not something to publish or maintain.

**Briefcase does not bundle or download a Python interpreter.** It builds on top
of one the user already has. If there isn't one, the install fails with a message
naming the thing to install and the command that installs it, and analysis keeps
working via the fallback (§8).

---

## 3. The worker contract

`worker.py` is a **subprocess contract, not a service**: one model load, a
JSON-lines protocol on stdin/stdout, a clean exit on EOF. Nothing in it should
grow features.

One JSON object per line, both directions.

**Ready line** — emitted once, after the model loads:

```json
{"ready": true, "device": "mps", "model": "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"}
```

`device` is torch's own vocabulary, stringified: `"mps"` = Metal, `"0"` = cuda:0,
`"-1"` = CPU.

**Request** (stdin):

```json
{"id": 1, "texts": ["...", "..."], "hypotheses": ["...", "..."]}
```

**Response** (stdout):

```json
{"id": 1, "scores": [[0.99, 0.02], [0.11, 0.87]]}
```

One row per text, one column per hypothesis, **in the order the hypotheses were
sent**. Duplicate hypotheses are handled: the worker scores the unique set and
fans the columns back out, because the transformers pipeline keys results by
label and duplicates would otherwise collapse into one column.

**Failure** (stdout):

```json
{"id": 1, "error": "ValueError: ..."}
```

A failed request is reported, never fatal — the worker stays up.

**Everything a human should read goes to stderr.** stdout carries the protocol
and nothing else.

**Exit:** stdin EOF. The parent (`NliRankerService.stop()`) ends stdin at the end
of every analysis, because there is no reason to hold a loaded model and ~1GB of
Python resident between runs. SIGKILL is only the backstop for a wedged
interpreter and must not outlive the app's shutdown budget.

**Environment the parent sets** (`NliRankerService.doStart`, and identically
`verifyNliWorker` in `common/nli-env.ts`):

```
HF_HOME=<nli dir>/hf     the pre-downloaded model, not the user's global cache
HF_HUB_OFFLINE=1         a missing model fails fast into the fallback…
TRANSFORMERS_OFFLINE=1   …instead of silently downloading 350MB mid-analysis
TOKENIZERS_PARALLELISM=false
```

Overridable by env var inside the worker: `BRIEFCASE_NLI_MODEL`,
`BRIEFCASE_NLI_BATCH`. Both exist for experiments; both move calibrated
behaviour, so see §4 before touching them.

### Device selection

```python
if sys.platform == 'darwin':
    device = 'mps' if torch.backends.mps.is_available() else -1
elif torch.cuda.is_available():
    device = 0
else:
    device = -1
```

macOS has no CUDA and Metal is the only accelerator there; Windows and Linux
have no Metal and CUDA is the only one. `-1` (CPU) is a fallback on every
platform, and it is a fallback, not a failure — the pipeline is *correct* on
CPU, just slower. All published timings in this document are MPS.

---

## 4. Calibration facts that must not drift

These are **measured**, not preferences. Each one silently moves flag output if
changed, without moving any threshold in any file that looks like it owns the
threshold.

| Fact | Value | Where | Why it is load-bearing |
| ---- | ----- | ----- | ---------------------- |
| Model | `MoritzLaurer/deberta-v3-base-zeroshot-v2.0` | `worker.py` `MODEL`, `nli-env.ts` `NLI_MODEL_ID` | Every threshold below was calibrated against this model's score distribution. |
| Hypothesis template | the pipeline's **default**, `"This example is {}."` | `worker.py` — by *not* passing `hypothesis_template` | The template is half of what the model scores. Changing it moves the threshold without touching the threshold. |
| `multi_label` | `True` | `worker.py` | The categories are not mutually exclusive. A softmax across them would make one category's score depend on which others happened to be present. |
| All categories kept | every hypothesis above threshold, not the argmax | `worker.py` returns all columns; `nli-ranker.service.ts` keeps all above threshold | The argmax version measurably LOST real flags to category mislabeling — a dehumanization line whose top score was `misinformation` was verified, flagged, and scored as a miss for carrying the wrong category. |
| `batch_size` | **64** | `worker.py` `BATCH` | Measured on MPS: ~1,900 sentences of a 60-minute video in ~40s. |
| `MAX_CHARS` | 1200 | `worker.py` | A transcript "sentence" longer than this is a run-on with no terminal punctuation; the model window is 512 tokens regardless. |
| `CAPTURE_THRESHOLD` | 0.2 | `nli-ranker.service.ts` | The bottom of the old sensitivity dial. Below ~0.15 deberta scores on this material are not near-misses, they are the model saying no — a lower threshold stops ranking and starts forwarding the transcript. |
| `RESCUE_MIN_SCORE` clamp | 0.15 | `nli-ranker.service.ts` | **Do not remove.** The rescue rule's floor is `threshold - margin` = `0.2 - 0.25` = **-0.05**, which every score in the matrix clears. Measured before the clamp existed: all 159 sentences of the 12-minute video "rescued" on all 10 categories at 0.000-0.008 — ~1600 verifier calls on the short video and roughly 8000 (about seven hours on the 27b) on the long one. Full argument in the `RESCUE_MARGIN` / `RESCUE_FLOOR` comments. |
| `SLIDING_WINDOW_SENTENCES` | 3, stride 1 | `nli-ranker.service.ts` | Sentence-level scoring cannot find DISTRIBUTED rhetoric. Measured symptom: a 60-minute video about prayer ministries in the White House and God-ordained regime change produced ZERO christian-nationalism flags, because the argument is never in one sentence. |
| `misinformation` excluded | always, even when enabled | `nli-ranker.service.ts` `MISINFORMATION_EXCLUSION` | Entailment degenerates it to "makes a factual assertion": 169/205 candidates and 19/20 false positives on the 60-minute reference video. It is judgeable only by the LLM discovery path. |

The **hypotheses themselves** (`HYPOTHESES` in `nli-ranker.service.ts`) are also
tuned, and are deliberately NOT the category descriptions from
`analysis-categories.json`. Those descriptions are *instructions written for an
LLM* ("ANY use of slurs — flag even if quoted", "NOTE: do NOT flag…"), and an
NLI model scores an instruction as a claim about the text, which is meaningless.
A hypothesis has to be a PROPOSITION the sentence can entail.

---

## 5. Provisioning

Component id **`nli-ranker`**, kind **`python-env`**, label **"Flag ranking
(NLI)"**. It appears in the setup wizard (tools step, "Flag detection —
recommended", not pre-selected) and in Settings → Components → Flag detection.

Five stages, reported as stages:

| # | Stage | What it does | Skipped when |
| - | ----- | ------------ | ------------ |
| 1 | Finding a system Python | Tries `python3`, then `python`, then `py -3` on Windows. Each candidate must report ≥ 3.9 **and** import `venv`. | never |
| 2 | Creating the Python environment | `<python> -m venv <dir>/venv` | the venv interpreter already exists |
| 3 | Installing packages | `<venv python> -m pip install --no-input <pins>` | the required packages are already in site-packages |
| 4 | Downloading the ranking model | `snapshot_download` with `HF_HOME=<dir>/hf` and `allow_patterns` = the file list in §2 | a usable snapshot already exists |
| 5 | Installing and verifying the worker | copies `worker.py` from the build, then **drives the whole thing end to end** | never |

### Why progress is by stage and not by byte

pip and the Hugging Face hub client do not report a byte total this process can
see. A bar synthesised from nothing is worse than no bar — it would sit at a
fake 40% through a ten-minute torch download. So the unit is the stage, `done`
is the number completed, and a heartbeat re-emits the current stage every 15s
while a child process is working. That heartbeat is not cosmetic: the download
dock fails an item after 10 minutes of silence, and this work is legitimately
silent for minutes at a time.

### Pins, and why they are ranges

The reference environment (the machine the pipeline was calibrated on) holds:

```
torch 2.13.0   transformers 5.15.1   huggingface_hub 1.28.0
tokenizers 0.22.2   safetensors 0.8.0   numpy 2.4.6   sentencepiece 0.2.2
Python 3.11.14
```

What is actually installed:

```
torch>=2.6,<3          transformers>=5.0,<6      huggingface_hub>=1.0,<2
tokenizers>=0.21,<1    safetensors>=0.5,<1       sentencepiece>=0.2,<0.3
numpy>=2.0,<3
```

Pinning the exact versions would be a portability bug, not rigor. torch
publishes per-(OS, arch, Python) wheels, and any single patch version is missing
for some combination somebody will have — a machine on a newer Python, or a
platform whose wheel for that patch was never built. An exact pin turns that
into "no matching distribution" with nothing the user can do about it.

The **major** version is what the calibration depends on: transformers 5's
zero-shot pipeline (`labels`/`scores` dict, `multi_label`, `hypothesis_template`)
is the API `worker.py` speaks, and torch 2.x is the ABI those wheels are built
against. Within a major, a newer patch does not move a score. Floor at the
oldest version known to carry the API, ceiling at the next major.

`sentencepiece` is not optional: the deberta-v3 tokenizer needs it.

### Idempotency and resumability

- A **complete** environment is detected up front and the whole install no-ops.
  Nothing is touched, nothing is re-downloaded.
- Every stage checks its own output first, so a run interrupted after the venv
  but before the model **resumes at the model**.
- The marker (§7) is written **last**, and only after verification. A half-built
  environment must never report "installed" — that is precisely the failure this
  whole exercise exists to prevent.

### Repair

Settings → Components → Flag detection → **Repair** (`POST /config/install-component`
with `{"id": "nli-ranker", "force": true}`). It deletes the venv and the marker
and rebuilds them. It does **not** delete `hf/`: the model cache is
content-addressed and re-validated against the hub on every fetch, so
re-downloading 350MB to fix a broken venv is cost with no benefit. A genuinely
damaged model cache is caught by the snapshot check and re-fetched by stage 4
regardless of `force`.

### Uninstall

**Remove** deletes the whole directory. It is driven by the *resolved* directory
rather than the install record, because a hand-built environment has no record
and "Remove" would otherwise look like it worked and leave 1.2GB behind. It
refuses to delete a directory that carries none of the expected layout.

### No interpreter

Stage 1 fails with a message naming the fix for the current platform
(`brew install python@3.11` / the python.org installer or
`winget install Python.Python.3.11` / `apt install python3 python3-venv`), and
saying explicitly that analysis still runs on the fallback in the meantime. On
Debian-family Linux, a stage-2 failure additionally suggests `python3-venv`,
because `python3` existing without it is that platform's most common shape of
this failure.

---

## 6. Building it by hand

If provisioning fails and you want the environment anyway — this is exactly what
the installer does, and the first working environment was built this way:

```bash
NLI="$HOME/Library/Application Support/briefcase/nli"   # or %APPDATA%\briefcase\nli
mkdir -p "$NLI"
python3 -m venv "$NLI/venv"
"$NLI/venv/bin/pip" install \
  'torch>=2.6,<3' 'transformers>=5.0,<6' 'huggingface_hub>=1.0,<2' \
  'tokenizers>=0.21,<1' 'safetensors>=0.5,<1' 'sentencepiece>=0.2,<0.3' 'numpy>=2.0,<3'

HF_HOME="$NLI/hf" "$NLI/venv/bin/python" - <<'PY'
from huggingface_hub import snapshot_download
print(snapshot_download('MoritzLaurer/deberta-v3-base-zeroshot-v2.0', allow_patterns=[
    'config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json',
    'added_tokens.json','spm.model','model.safetensors']))
PY

cp /path/to/Briefcase/backend/python/nli-worker/worker.py "$NLI/worker.py"
```

Check it:

```bash
cd "$NLI"
printf '%s\n' '{"id":1,"texts":["The election was stolen."],"hypotheses":["This example is a conspiracy theory."]}' \
  | HF_HOME="$NLI/hf" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 ./venv/bin/python -u worker.py
```

You should see a `ready` line and then a `scores` line. A hand-built environment
has no `install.json` and that is fine — the marker is provenance, never
permission (§7).

---

## 7. Status detection

`checkNliEnv(dir)` in `backend/src/common/nli-env.ts` is the **single** answer to
"is it there", used by both the component manager (what the settings pane and
wizard say) and `NliRankerService` (whether an analysis runs the ranked path).
They share it on purpose: if each kept its own copy they would drift, and the
first symptom would be the settings pane saying "Installed" while every analysis
silently degraded.

It is **filesystem only** — no interpreter is spawned — because it runs on every
`listComponents()`, which is every time the settings pane or wizard renders, and
importing torch costs seconds. It checks, individually:

- the venv interpreter exists
- each of `torch`, `transformers`, `sentencepiece` is in site-packages
- a model snapshot exists with both `config.json` and real weights behind its
  symlinks
- `worker.py` exists

At **install** time the standard is higher. `provisionNliEnv` finishes by
spawning the freshly built worker exactly the way `NliRankerService` will — same
offline HF environment — waiting for the ready line, sending one real scoring
request, requiring a finite numeric score back, then closing stdin and expecting
a clean exit. A venv that imports torch but cannot load the model, and a model
that is present but truncated, both pass a file check and fail here. Only then
is `install.json` written, recording the model, the device, the system Python
version, the resolved package versions and the pins.

**`install.json` is read, never required.** Requiring it would report the very
first environment this feature ever ran on — hand-built, working, in daily use —
as "not installed", and would send an analysis down the fallback path over a
missing JSON file. `NliEnvStatus.verified` carries the distinction for anyone who
wants it.

The ranker's own spawn remains the final arbiter. If it fails anyway, it reports
unavailable and Repair rebuilds.

---

## 8. When it is absent

**Analysis still runs.** `NliRankerService` never throws into an analysis: every
failure mode — no directory, no venv, spawn failure, model load error, protocol
error — resolves to "unavailable", and the flag stage runs the old chapter
discovery pass instead.

What changes:

- Flags come from one open-ended LLM call per chapter instead of an exhaustive
  NLI ranking pass. Fewer of them, found less reliably.
- Timestamps come from matching the model's quote back to the transcript rather
  than from the sentence's own segments.
- `analysisGranularity` (the sensitivity dial) becomes a **run input** again. On
  the ranked path it is a display filter over stored verdicts; on the discovery
  path there are no scores and no rejected candidates to filter, so the dial has
  to decide before the run.
- Rows are written legacy-shaped (`verdict` and `nli_score` NULL), which every
  reader treats as an unfiltered flag.
- `misinformation` becomes available again — it is the one category the LLM path
  can judge and entailment cannot.

**The user is told.** One line in the server log is not enough for a
degradation that changes the result somebody is about to look at, so the run also
attaches a warning to the job:

> Flags were found with the fallback method (one AI pass per chapter), which is
> slower and finds fewer of them: the "Flag ranking (NLI)" component is not
> installed or is incomplete. Install it from Settings → Components and re-run
> the analysis for the full flag pass. (*reason*)

This travels the channel that already exists for exactly this class of outcome —
`TaskResult.warnings` → `job.warnings` → the queue row and the library card's
warning badge. No new notification system was built for it.

`BRIEFCASE_FLAGS_DISCOVERY=1` also selects the discovery path, and deliberately
does **not** produce the warning: that is an operator override, and warning
somebody about a thing they just asked for is noise.

---

## 9. The drift check

There are two copies of `worker.py`: the committed one
(`backend/python/nli-worker/worker.py`, shipped to `dist/python` by the assets
rule in `nest-cli.json`) and the one in the environment beside the venv. **The
environment's copy is what runs** — it is the one next to an interpreter that can
import transformers, and running the repo copy against an environment it was not
installed with would be a different program in a different place.

So on every worker start `NliRankerService.reportWorkerDrift` hashes both and
logs one line:

- identical → `worker.py matches the committed copy (sha256 …)`
- different → a `WORKER DRIFT` warning with both paths and both hashes

**It reports, it never repairs.** Nothing in the ranker copies, syncs or
overwrites anything; getting the right `worker.py` into place is the component
manager's job. Repair (§5) is the supported way to refresh it. To do it by hand:

```bash
cp backend/python/nli-worker/worker.py \
   "$HOME/Library/Application Support/briefcase/nli/worker.py"
```

---

## 10. Where the code lives

| Path | What |
| ---- | ---- |
| `backend/src/common/nli-env.ts` | Layout, pins, `resolveNliDir`, `checkNliEnv`, `findSystemPython`, `provisionNliEnv`, `verifyNliWorker`, `removeNliEnv`. DI-free so both sides can import it without a cycle. |
| `backend/python/nli-worker/worker.py` | The committed worker — source of truth for review and history. |
| `backend/src/analysis/nli-ranker.service.ts` | Sentences, hypotheses, thresholds, the rescue rule, windowing, the worker's lifecycle, the drift check. |
| `backend/src/analysis/ai-analysis.service.ts` | Flag path selection, the verification pass, the fallback warning. |
| `backend/src/components/component-manager.service.ts` | `installPythonEnv`, and the `python-env` branches of `isInstalled` / `remove`. |
| `backend/src/config/model-catalog.ts` | `nliEnvComponents()` — the synthesized component entry. |
| `frontend-v3/src/app/components/setup-wizard/setup-wizard.component.ts` | Wizard entry (tools step). |
| `frontend-v3/src/app/pages/settings/panes/components-pane.component.*` | Settings entry, Install / Repair / Remove. |

### A note on the component's artifact

`python-env` travels through the same component surface as the downloads, and
`pickArtifact()` is how that surface answers "is this supported here?" and "how
big is it?". Both answers are real for this component — supported anywhere a
Python 3.9+ interpreter can be found, and the size is the measured on-disk size
of a finished environment — so it declares a platform-agnostic artifact with an
**empty url**. The install path for this kind never reads the url. Doing it this
way leaves `pickArtifact`, the single-active-install guard, and the abort
handling in `install()` exactly as they were, rather than threading a second
"does this component even have an artifact" concept through all of them.
