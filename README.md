# omp-council

Shadow Council and Shadow Arena for OMP.

Provider-generic multi-model orchestration. No built-in assumption about Claude, Codex, Grok, Gemini, or any other vendor. If a model is authenticated and visible through OMP's model registry, it can sit on the Council or enter the Arena.

- **Shadow Council** (`/council`) — independent reasoning, then debate or deep review. Architecture, debug, security, refactor.
- **Shadow Arena** (`/arena`) — isolated competing implementations, blind judge, no auto-apply.

Verified against **OMP 18.1.14**. `eval` `agent()` still has no per-call `model` override (`prompt`, `agent`, `label`, `schema`, `schemaMode`, `isolated`, `apply`, `merge`, `tools` only). Run-scoped agent files remain the routing seam.

## Highlights

- **Any OMP model/provider** — built-ins, OAuth-backed providers, OpenRouter, local Ollama/llama.cpp/LM Studio, custom `models.yml` providers, extension-provided models, etc.
- **Saved participant registry** for models you use regularly.
- **`-t` / `--tmp`** opens the full authenticated-model picker and uses the selection for one run only.
- Council `quick`, `debate`, and `deep` modes with retained-agent cross-review.
- Cognitive role presets independent of model/provider identity.
- Arena runs isolated competing implementations and a blind judge.
- Live status widget + Agent Hub visibility.
- `/council cancel` / `/arena cancel` abort the active orchestration and waited subagents.
- Arena never auto-applies a winner; `/arena apply` validates and confirms first.

## Why run-scoped agent files

OMP 18.1.14 `eval` `agent()` does **not** expose a per-call model override; the selected agent's frontmatter `model` wins. To keep arbitrary model selection while preserving native OMP subagents, isolation, Agent Hub, and cancellation, omp-council does this for every run:

1. Resolve the models the user selected through `ctx.models`.
2. Write uniquely named temporary agent definitions under `~/.omp/agent/agents/`, each with the exact selected model in `model:` frontmatter.
3. Launch those agents through `eval`'s native `agent()` helper.
4. Reuse the retained handles for Council rebuttal/final rounds.
5. Delete the run-scoped agent files on success, failure, cancellation, clear, session start (same instance leftovers), or session shutdown.
6. Delete leftover Hub transcripts named like `C9-seat1-position.jsonl` next to the parent session file so Alt+A does not keep showing finished seats.

Names contain process + per-session + run identifiers, so concurrent OMP sessions do not reuse the same runtime files. Runtime state is keyed by `sessionManager.getSessionId()`.

These runtime files are an implementation detail. **`--tmp` does not write to `council.json` and does not add the selected model to the user's saved registry.**

Runtime agents also omit `task`/`eval` from their tool lists so child sessions cannot recurse into `/council` or `/arena`.

## Install

OMP `v18.1.14`+

```text
/marketplace add Shadorain/omp-council
/marketplace install council@omp-council
```

Or clone:

```bash
git clone https://github.com/Shadorain/omp-council.git ~/.omp/agent/extensions/omp-council
```

Local checkout: `ln -sfn "$(pwd)" ~/.omp/agent/extensions/omp-council` or `./install.sh` (copies `index.ts` and `src/*.ts`).

Restart OMP. `/council` and `/arena` show up in autocomplete.

If you use `PI_CODING_AGENT_DIR`, `OMP_AGENT_DIR`, or `OMP_COUNCIL_CONFIG`, the extension honors them.

Older provider-specific agent files (`council-claude.md`, `council-codex.md`, …) are unused and may be removed.

## How to use

Council reviews. Arena competes. Same saved model list for both.

```text
/council
```

1. First time: pick 2-8 authenticated models. That list is saved to `~/.omp/agent/council.json`. Later `/council setup` rebuilds it.
2. Check which seats run this time. Pick Quick, Debate, or Deep. Pick a role (architecture, debug, ...).
3. Type the question in the prompt editor.
4. The widget shows seat progress. The chair (current session model) synthesizes after the seats finish. No majority vote.
5. Esc asks, then aborts the run and child agents. `/council cancel` does the same without the prompt.

Skip the form:

```text
/council --deep --role architecture -- Review this service boundary.
```

One-off models, do not save:

```text
/council -t
/council -t --deep --role architecture -- Review this service boundary.
```

Arena:

```text
/arena
/arena -t --profile rust -- Implement this refactor.
/arena apply
```

Candidates work in isolated workspaces. The judge sees Candidate A/B/C, not model names. The winner is never applied until `/arena apply` checks the patch and you confirm.

`/council help` reprints this flow in the session.

Picker keys: type to filter, Space toggles, Enter submits.

`/council test` after setup runs the saved seats with prompt `test`. Unresolved tokens are the question, not a missing model. `--` still forces an explicit prompt.

Reconfigure: `/council setup`. Inspect: `/council config`.

By default the Arena judge is the model active in the main OMP session.

## Temporary mode: `-t` / `--tmp`

Temporary mode opens the full authenticated model list for this run only. It does not write `council.json`.

```text
/council -t anthropic/some-model ollama/qwen -- Review this design.
/arena -t --profile rust --judge @slow -- Implement this refactor.
```

Arena `-t` also opens a blind-judge picker unless `--judge` is supplied.

## Saved registry format

```json
{
  "version": 1,
  "participants": [
    {
      "id": "primary-reasoner",
      "label": "Primary Reasoner",
      "model": "provider-a/model-a",
      "aliases": ["reasoner"],
      "tags": ["reasoning", "premium"]
    }
  ],
  "presets": {
    "default": ["primary-reasoner"],
    "all": ["primary-reasoner"]
  }
}
```

`model` may be any selector OMP's normal model resolver understands, including configured role aliases.

## Selecting participants

```text
/council primary-reasoner local-worker -- Review this design.
/council provider-a/model-a provider-b/model-b -- Review this design.
/council default -- Review this design.
/council tag:reasoning -- Review this design.
```

A direct model selector used in a command is one-shot unless you also add it to `council.json`.

## Shadow Council

```text
/council
/council default -- Should this API move behind a repository layer?
/council tag:reasoning --deep --role architecture -- Review this architecture.
```

Modes:

- `--quick` — independent round only
- default / `--debate` — independent + one anonymized rebuttal
- `--deep` — independent + rebuttal + final reconsideration

Role presets: `general`, `architecture`, `debug`, `security`, `refactor`.

Lenses rotate between seats/run numbers; they are not permanently tied to a model or provider.

## Shadow Arena

```text
/arena
/arena default -- Implement this refactor and prove it works.
/arena model-a model-b model-c --profile rust -- Implement this migration.
```

Arena flow:

1. Each candidate runs as a normal OMP subagent in an isolated workspace.
2. `apply:false` prevents integration into the parent checkout.
3. `merge:false` requests patch-mode capture.
4. Candidates return structured implementation/test evidence.
5. A separate judge sees only Candidate A/B/C evidence, never their model identities.
6. The judge ranks candidates by correctness and verification first.
7. Provider/model identities are revealed only after judging.
8. Nothing changes in your checkout until `/arena apply`.

### Rust profile

Candidates are asked to run, when feasible:

```text
cargo fmt --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`--profile auto` detects a root `Cargo.toml`; otherwise it uses general verification.

## Apply Arena winner

```text
/arena apply
```

1. Find the blind judge's winner.
2. Refuse an empty/truncated reported diff.
3. Write a temporary patch.
4. Run `git apply --check`.
5. Ask for confirmation.
6. Run `git apply` only after confirmation.

## Lifecycle commands

```text
/council status
/council cancel
/council history
/council clear
/council setup
/council config

/arena status
/arena cancel
/arena history
/arena apply
/arena clear
/arena setup
/arena config
```

`cancel` is shared: `/council cancel` can cancel an active Arena and vice versa.

`clear` refuses while a run is active; cancel first.

`cancel` calls `ctx.abort()`, waits briefly for idle, then deletes runtime agent files. Orchestration eval is kept foregrounded (`timeout: 0`) so session abort cancels waited `agent()` handles. Generated cells also call `handle.cancel()` on member failure.

## Run dumps

Each finished, failed, or cancelled run writes `~/.omp/agent/council-runs/<id>.json` (or `$OMP_AGENT_DIR/council-runs`). The file has the question, seats, costs, and the full structured `final` payload (opinions, rebuttals, Arena candidates/judgement). Session `/council history` lists the last 10 in this session plus those paths. `--tmp` still dumps output. It does not write `council.json`.

## Autocomplete

After `/council ` or `/arena `, the first row is an optional placeholder (`[question]` / `[task]`) so flags do not look required. Ghost text uses that placeholder. Flag rows insert the flag (`--deep`, `-t`) and put the explanation in the description column. `-t` and `--tmp` are one option. `help` is one row, not `help` / `--help` / `-h`.

`--role` and `--profile` then complete their values (`architecture`, `rust`, …). A completed `status` / `cancel` / `apply` stops suggesting. Bare `--` treats the rest as the prompt.

## Live UI

Kickoff is a full-width chat rule: `─ Council · C10 ─` (or Arena), bold title plus run id, nothing else. `display: true` so OMP actually paints it. Chair plumbing stays in LLM content.

The widget sits above the editor as its own panel (`╭ ╮ │ ╰ ╯`). Header is `Council · C10` or `Arena · A1`. Seat lines show elapsed time and cost while the run is live. A `total` wall-time plus summed cost line appears only after done, cancelled, or failed. Cap 14 lines. OMP only exposes above/below editor widget slots; header API is a no-op.

Turn the wave off:

```text
OMP_COUNCIL_SHIMMER=0
```

or in `~/.omp/agent/council.json`:

```json
{ "shimmer": false }
```

Esc asks to abort the run and child agents. `/council cancel` does the same without the prompt.

## Environment overrides

```text
PI_CODING_AGENT_DIR   alternate OMP agent directory
OMP_AGENT_DIR         alternate agent directory fallback
OMP_COUNCIL_CONFIG    exact path for council.json
OMP_COUNCIL_SHIMMER   0/false/off disables the live header wave
```


## Limits / notes

- 2–8 candidate models per run (`MAX_PARTICIPANTS`).
- The model picker uses `ctx.models.list()`, so it only shows models OMP considers authenticated/available in the current session.
- A restrictive parent-agent `spawns:` policy can reject the uniquely named runtime agents. Ordinary top-level OMP sessions normally allow subagents.
- Arena isolation requires `task.isolation.enabled`. If that setting is false, isolated `agent()` calls fail at preflight.
- Runtime agent files are uniquely named and never reused. A hard process crash can leave a stale file; the next session for that instance prefix deletes leftovers.
- Command handlers still cannot call `eval` directly. Kickoff is a custom Council/Arena card (`triggerTurn`), not `sendUserMessage(question)`. Eval instructions go on the chair system prompt via `before_agent_start`. The intercepted eval input is a one-line `Bun.file` stub; the real cell is a run-scoped `.js` next to the runtime agents. Stray `task`/extra `eval` calls are blocked. `session_stop` continues while the kickoff eval is still pending.
- Results bind to the intercepted eval `toolCallId` plus `{ kind, runId }`, not "the next eval result".
- Explicit `model:` pins still inherit OMP `retry.fallbackChains.default`. There is no eval/agent API to empty that chain, so a 503 on the chosen model can land on Grok 4.5 (or whatever is in your default chain). The widget flags `via <model>` when that happens.
- Generated cells call `handle.cancel()` after the run so seats are not left running. Finished seat transcripts next to the parent session (`C9-seat1-position.jsonl` and similar) are unlinked so Agent Hub does not keep listing them. Runtime agent files are deleted so those names cannot be spawned again. A hard crash can leave a parked jsonl until the next `/council clear` or session start.

## Develop
```bash
bun install
bun test
bun run typecheck
```
