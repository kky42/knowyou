<p align="center">
  <img src="assets/knowyou-logo.png" alt="knowyou logo" width="160">
</p>

<h1 align="center">knowyou</h1>

<p align="center">Quiet, shared memory for every AI agent.</p>

knowyou is a non-intrusive, agent-agnostic memory layer for Pi, Codex, Claude, and Grok. It runs in the background, distilling and consolidating session context into shared Markdown—so every agent knows why it is here, what matters next, and how you like to work.

![knowyou asynchronous data flow: supported agent sessions flow through scan, observe, consolidate, and render into shared Markdown memory](assets/knowyou-flow.png)

## Quick start

Requires [Pi](https://github.com/earendil-works/pi) to be installed and working. Pi runs the background distillation; session adapters cover Pi, Codex, Claude, and Grok.

```bash
npx knowyou@latest start
npx knowyou@latest stop
```

`start` registers the background job; `stop` removes it.

If you want an agent to read the memories, add these lines to its global instructions file—for example Pi’s `~/.pi/agent/AGENTS.md`, Codex’s `~/.codex/AGENTS.md`, or the equivalent file for another agent:

```markdown
- Read ~/.knowyou/INDEX.md for recent observations
- Read ~/.knowyou/MEMORY.md for durable memory and preferences
- Search ~/.knowyou/journals/ by keyword when older context is needed
- Never edit, delete, or write files under ~/.knowyou/
```

## Persistent memory

The OS runs knowyou periodically. There is no resident server or database—just durable files under `~/.knowyou/`:

```text
~/.knowyou/
├── INDEX.md             # recent observations, one line per entry
├── MEMORY.md            # consolidated long-term memory and preferences
├── observations/       # new distilled memories waiting to be consolidated
├── journals/            # older memory moved out of MEMORY.md
├── .state.json          # incremental scan watermarks and run state
├── config.yaml          # optional settings and overrides
└── launchd.log          # background job output
```

## Defaults and configuration

Here, `agent` means the background Pi runner that distills observations and consolidates memory—not the agents whose sessions are being read. No knowyou configuration is required when Pi works; it uses the model and reasoning effort configured in your Pi agent by default.

To override only the settings you care about, create `~/.knowyou/config.yaml`:

```yaml
agent:
  model: provider/model       # optional; otherwise Pi's default
  thinking: medium            # optional; otherwise Pi's default
  maxConcurrency: 4

scan:
  windowDays: 7
  minNewChars: 40000
  redactSecrets: true
```

Check the current state with:

```bash
npx knowyou@latest status
```

All state stays under `~/.knowyou/`. Model requests go through Pi and its normal provider/authentication.

## Supported sessions

- Pi
- Codex
- Claude
- Grok
