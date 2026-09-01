# backpass/ — vendored scan code

Verbatim copies of [backpass](https://github.com/kunchenguid/backpass)'s transcript
discovery layer (MIT license), so upstream improvements can be tracked with minimal
diffing. Source commit: `698d57f79c471d86ab1cb3c44a36408daaeecb72`.

## What is here

| File | Upstream path | Notes |
|---|---|---|
| `shared.js` | `src/discovery/adapters/shared.js` | verbatim |
| `interaction.js` | `src/interaction.js` | verbatim (imported by adapters for classify metadata) |
| `adapters/pi.js` | `src/discovery/adapters/pi.js` | import path fix only |
| `adapters/claude.js` | `src/discovery/adapters/claude.js` | import path fix only |
| `adapters/codex.js` | `src/discovery/adapters/codex.js` | + `export` on `flattenOutput` (our glue reuses it) |
| `adapters/grok.js` | `src/discovery/adapters/grok.js` | import path fix only |

The shared deterministic distillation rules are adapted in `src/observe/preprocess.ts`
because knowyou needs byte-offset slices and a different observation prompt. They retain
Backpass's cheap-first behavior without importing its repository-analysis pipeline.

Not vendored: the SQLite-backed adapters (`opencode`, `hermes`, `cursor-ide`, `cursor-cli`
partially) — they need a sqlite driver; add when we support those harnesses. Also not
vendored: `association.js` / `repo.js` (repo-association is a backpass concern — knowyou's
global layer scans every session regardless of cwd) and the discovery driver
(`discovery/index.js`) — knowyou has its own pipeline (byte-offset increments, no
full-file re-reads).

## Update procedure

Re-copy the files from a newer upstream commit and re-apply only the changes listed in
the table. If upstream changes an adapter's *entry format* handling, the per-harness
message mappers in `../adapters.ts` (marked "mirrors adapters/X.js read()") need the
same change.
