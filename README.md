# Nuggets
A TypeScript holographic memory engine for small, durable agent facts, plus the original Pi messaging gateway prototype. Nuggets stores short key-value facts in fixed-size HRR-style complex vectors, recalls them locally, and now records promotion decisions before writing facts into permanent context.
![Logo](https://github.com/NeoVertex1/nuggets/blob/d180ee6df491d2db741eed0bf254ba917a4c12e2/images/Gemini_Generated_Image_mgaktymgaktymgak.png)

## Package Status

This checkout contains:

- `src/nuggets/` — the zero-dependency core memory engine
- `.pi/extensions/` — Pi agent extensions for memory and proactive scheduling
- `src/gateway/` — the original Telegram/WhatsApp gateway
- `gateway/` — an older standalone gateway package copy kept for compatibility
- `scripts/capacity-benchmark.ts` — repeatable HRR capacity measurement

It does not currently include a `nuggets-memory/` plugin workspace, an MCP server entrypoint, or a Python package/CLI. If those surfaces are added later, they should be documented with the exact package path and install command that exists in this repository.

The active development branch in this fork is `memory-governance`; see [`docs/fork-workflow.md`](docs/fork-workflow.md) for fork-safe remotes and publishing rules.

## Why Nuggets?

LLM agents forget everything between sessions. RAG systems fix this but need vector databases, embedding APIs, and infrastructure. Nuggets takes a different approach:

- **Holographic memory** — facts are stored as superposed complex-valued vectors using Holographic Reduced Representations (HRR). Recall is algebraic, sub-millisecond, and runs locally with zero external dependencies.
- **Governed promotion** — repeated recall is recorded in a promotion ledger. Facts can be blocked for low confidence, low margin, contradictions, expiry, or missing provenance.
- **Proactive** — the assistant doesn't just respond. It checks in periodically, runs scheduled tasks, and sends reminders — all through the same Telegram or WhatsApp chat.

Think of it as an AI that lives in your pocket, remembers what matters, and reaches out when it has something useful to say.

## What's Inside

### Holographic Memory Engine (`src/nuggets/`)

The core of the system. Pure TypeScript, zero dependencies.

Each "nugget" is a topic-scoped memory (e.g., `user`, `project`, `agent`). Facts are key-value pairs compressed into a fixed-size complex vector via HRR binding. Multiple facts superpose into one mathematical object but remain individually retrievable.

- **remember** — bind a key-value pair into the holographic vector
- **recall** — unbind a query and decode via cosine similarity, with token-overlap matching, calibrated confidence, top-k candidates, entropy, capacity pressure, and abstention
- **forget** — subtract a binding from the superposition
- **promote** — facts are evaluated through a promotion ledger before being written to `MEMORY.md`
- **memory kinds** — facts are auto-classified into `user` (preferences), `project` (files, commands, repo context), or `agent` (self-knowledge) scopes. Recall searches across kinds in priority order.

Storage is a simple JSON file per kind at `~/.nuggets/` (e.g., `user.nugget.json`, `project.nugget.json`). Vectors are never serialized — they're rebuilt deterministically from a seeded PRNG, so the files stay tiny. A migration script (`npm run migrate:memory`) splits legacy single-file memory into the new kind-based layout.

### Messaging Gateway (`src/gateway/`)

A multi-channel message router that connects your AI to Telegram and WhatsApp.

- **Process pool** — one Pi subprocess per user, reused across messages, reaped after 5 min idle
- **JSONL RPC** — communicates with Pi via stdin/stdout, no sockets or HTTP
- **Message queue** — serializes concurrent messages per user to prevent race conditions
- **Heartbeat** — checks in every 30 min during waking hours. If there's nothing to say, it stays quiet
- **Cron scheduler** — 5-field cron expressions for recurring messages, reminders, and one-shot timers
- **Quiet hours** — no proactive messages between 10 PM and 8 AM (configurable)

### Pi Extensions (`.pi/extensions/`)

Hooks into the Pi agent lifecycle:

- **nuggets.ts** — gives Pi a `nuggets` tool for remember/recall/forget with memory kind routing, auto-captures file paths and user preferences from conversation, injects memory into system prompt
- **proactive.ts** — gives Pi a `schedule` tool so it can create reminders and recurring tasks on its own

## Setup

### Prerequisites

- Node.js 18+
- [Pi](https://github.com/mariozechner/pi) — the AI coding agent that powers the assistant. Install globally:
  ```bash
  npm install -g @mariozechner/pi-coding-agent
  ```
- An [Anthropic API key](https://console.anthropic.com/) (the Max plan does **not** work — Anthropic blocked third-party OAuth in Jan 2026)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram chat ID (from [@userinfobot](https://t.me/userinfobot))

### Quick Start

```bash
npm install -g @mariozechner/pi-coding-agent   # install Pi (if not already)
git clone https://github.com/NeoVertex1/nuggets.git
cd nuggets
npm install
npm run setup
npm run dev:gateway
```

Core-only checks do not require the Telegram/WhatsApp gateway to run:

```bash
npm run typecheck:core
npm test
npm run bench:capacity
```

### Setup Wizard

`npm run setup` walks you through configuration interactively and is the recommended path for first run because it writes `.env` for you:

```
  Nuggets Setup Wizard
  ====================

  ── AI Provider ──────────────────────────────────────

  Note: Anthropic Max plan does NOT work (third-party OAuth
  was blocked Jan 2026). You need an API key from:
  https://console.anthropic.com/

  Paste your sk-ant-... key:
  Anthropic API key: sk-ant-api03-...

  ── Telegram ─────────────────────────────────────────

  Create a bot via @BotFather on Telegram, paste the token:
  Bot token: 123456789:AAF...

  Send /start to @userinfobot on Telegram to get your chat ID:
  Chat ID: 987654321

  ── WhatsApp (optional) ──────────────────────────────

  Your JID (e.g. 1234567890@s.whatsapp.net) — press Enter to skip:
  WhatsApp JID:

  ── Pi Model (optional) ──────────────────────────────

  Model ID (press Enter for Pi's default):
  Model:

  ✓ .env written successfully.

  Ready! Run `npm run dev` to start.
```

The wizard validates inputs (API key format, token format, numeric chat ID), shows masked current values if `.env` already exists, and writes the file atomically.

### Getting Your Telegram Credentials

1. **Bot token** — open Telegram, search for [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. You'll get a token like `123456789:AAF7_NRCOM2nxZt...`
2. **Chat ID** — search for [@userinfobot](https://t.me/userinfobot), send `/start`. It replies with your numeric chat ID.
3. Run `npm run setup`, paste both values, and you're done.

## How It Works

```
You (Telegram/WhatsApp)
  │
  ▼
Gateway ── router ── message queue (per user)
  │                      │
  ├── heartbeat          ▼
  ├── cron          Pi subprocess (JSONL RPC)
  │                      │
  │                 ┌────┴─────┐
  │              nuggets    schedule
  │              extension  extension
  │                 │          │
  │            ~/.nuggets/   .gateway/cron/
  │           (HRR memory)  (job store)
  │                 │
  │            promoteFacts()
  │                 │
  │            MEMORY.md
  │         (permanent context)
  ▼
EventQueue ◄── cron fires ── "0 9 * * *"
           ◄── heartbeat ─── every 30 min
           ◄── timer ──────── one-shot
```

**Message flow**: You send a message → gateway routes it to your Pi process → Pi checks nuggets memory for context → Pi responds → gateway delivers the reply.

**Proactive flow**: Heartbeat timer fires → Pi checks memory for anything worth following up on → if yes, sends you a message. If not, stays silent.

**Memory promotion**: After enough sessions, facts that keep getting recalled are evaluated by `promoteFacts()`. The promotion ledger records whether each fact was promoted or blocked, and why. Promoted facts are written to `MEMORY.md`; blocked facts remain in the nugget but do not become permanent context.

## Architecture

```
src/
  nuggets/              Memory engine (pure TypeScript, zero deps)
    core.ts             HRR math: bind, unbind, orthogonalize, sharpen
    memory.ts           Nugget class: remember, recall, forget (+ token-overlap matching)
    shelf.ts            NuggetShelf: multi-nugget manager with kind-aware routing
    kinds.ts            Memory kind types, auto-classification heuristics
    promote.ts          MEMORY.md promotion ledger and quality gates
    index.ts            Public API

  migrate-memory.ts     Migration: legacy single nugget → kind-based layout

  gateway/              Messaging gateway
    main.ts             Entry point — wires everything together
    config.ts           Environment config + helpers
    router.ts           Message routing + proactive event handling
    pi-rpc.ts           Pi subprocess communication (JSONL RPC)
    pi-pool.ts          Per-user process pool with idle eviction
    telegram.ts         Telegram bot (grammY)
    whatsapp.ts         WhatsApp client (Baileys)
    event-queue.ts      Proactive event bus
    cron.ts             5-field cron scheduler + request file watcher
    heartbeat.ts        Per-user periodic check-ins

  setup.ts              Interactive setup wizard

.pi/extensions/
  nuggets.ts            Memory tool + auto-capture + system prompt injection
  proactive.ts          Schedule tool + cron file bridge
```

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Interactive setup wizard — creates `.env` |
| `npm run dev` | Alias for `npm run dev:gateway` |
| `npm run dev:gateway` | Start the gateway (Telegram + WhatsApp) |
| `npm test` | Run tests |
| `npm run typecheck:core` | Type-check only the core memory engine |
| `npm run bench:capacity` | Run repeatable capacity/abstention benchmark |
| `npm run migrate:memory` | Migrate legacy single-file memory to kind-based layout |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile to `dist/` |

## Testing

```bash
npm test
```

Tests cover HRR math (bind/unbind accuracy, orthogonalization), nugget operations (remember/recall/forget lifecycle), and shelf management.

## License

MIT
npm run migrate:memory` | Migrate legacy single-file memory to kind-based layout |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile to `dist/` |

## Testing

```bash
npm test
```

Tests cover HRR math (bind/unbind accuracy, orthogonalization), nugget operations (remember/recall/forget lifecycle), and shelf management.

## License

MIT
