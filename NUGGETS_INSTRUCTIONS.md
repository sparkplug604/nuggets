# Nuggets — Holographic Memory for LLM Agents

## What is Nuggets?

Nuggets is a **fast key-value memory** backed by Holographic Reduced Representations (HRR). It stores facts as superposed complex-valued tensors and retrieves them algebraically in microseconds. It is NOT a database, vector store, or RAG system — it is a fixed-capacity associative cache.

Think of it as **L1 cache for your agent**: tiny, fast, lossy, and associative.

## Current Interface

This repository is currently a TypeScript project. It does not include a Python package or installed `nuggets` CLI in this checkout. Use the TypeScript API from `src/nuggets/`, the Pi extension in `.pi/extensions/nuggets.ts`, or the project scripts below.

```bash
npm test                    # run unit tests
npm run typecheck:core      # type-check only the memory engine
npm run bench:capacity      # measure recall accuracy and abstention under load
npm run dev:gateway         # run the Telegram/WhatsApp gateway prototype
```

If a CLI or MCP server is added later, document the exact package name, bin name, and install command here.

## The recall-first pattern

**Always try `nuggets recall` before expensive operations.** This is the core usage pattern:

1. Agent gets a question or needs to find something
2. call `NuggetShelf.recall(...)` or the Pi `nuggets` tool — check memory first (free, instant)
3. If found → use the answer
4. If not found → do the expensive search/API call/file read
5. call `remember(...)` with a short key, value, and source — cache for next time

## When to use it

- **Before file searches**: Check if you already know where something is
- **Caching learned facts**: Project patterns, user preferences, code locations
- **Remembering past fixes**: Store diagnosis + fix for recurring bugs
- **Cross-session memory**: Facts persist to `~/.nuggets/` and survive restarts

## When NOT to use it

- Large documents or code blocks (values should be short strings)
- More than ~250 facts per nugget (create multiple nuggets instead)
- Anything requiring exact text retrieval (HRR is approximate and may abstain under uncertainty)
- Structured queries, joins, or filtering (use a real database)

## Suggested nugget organization

| Nugget name | What to store | Examples |
|---|---|---|
| `project` | Build commands, tech stack, deploy process | "test command" → "pytest src/ -v" |
| `prefs` | User preferences and conventions | "indent style" → "2 spaces" |
| `locations` | Where things are defined | "auth handler" → "src/auth/middleware.ts:47" |
| `debug` | Past bug diagnoses | "CORS error" → "add origin to allowlist in config.ts" |

## TypeScript API

```ts
import { Nugget } from "./src/nuggets/index.js";

const n = new Nugget({ name: "my_memory", autoSave: false });
n.remember("test command", "npm test", { source: "project docs" });
const result = n.recall("what is the test command");
console.log(result.answer, result.confidence, result.abstained);
```

## Capacity guidelines

| Dimension (D) | Facts per nugget | Memory |
|---|---|---|
| 1024 | ~128 | ~16 KB |
| 2048 (default) | ~180 | ~32 KB |
| 4096 | ~256 | ~64 KB |
| 8192 | ~360 | ~128 KB |

When a nugget gets full, create a new one with a different topic. Broadcast recall searches across all of them automatically.
