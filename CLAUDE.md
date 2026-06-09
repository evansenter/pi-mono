# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project-specific rules

`AGENTS.md` at the repo root contains the authoritative development rules for this project (for both humans and agents). Read it. The most important points are reproduced and expanded below, but `AGENTS.md` is the source of truth for code quality, changelog, release, and the multi-file checklist for adding a new LLM provider.

## Repository layout

This is an npm-workspaces monorepo (`pi-monorepo`). All publishable code lives under `packages/*`, and **all packages share a single lockstep version number** — a release bumps every package together.

| Package | npm name | Role |
|---------|----------|------|
| `packages/ai` | `@mariozechner/pi-ai` | Unified multi-provider LLM API (streaming, tools, token/cost tracking, cross-provider handoff). Foundation everything else builds on. |
| `packages/agent` | `@mariozechner/pi-agent-core` | Stateful agent runtime (tool calling, state management, event streaming) built on `pi-ai`. |
| `packages/coding-agent` | `@mariozechner/pi-coding-agent` | The `pi` coding agent CLI. Built on `pi-agent-core` + `pi-tui`. |
| `packages/tui` | `@mariozechner/pi-tui` | Terminal UI library with differential rendering. |
| `packages/mom` | `@mariozechner/pi-mom` | Self-managing Slack bot that delegates to the coding agent. |
| `packages/pods` | `@mariozechner/pi` (bin `pi-pods`) | CLI for managing vLLM deployments on GPU pods. |
| `packages/web-ui` | `@mariozechner/pi-web-ui` | Web components (lit + Tailwind v4) for AI chat interfaces. |

Dependency direction: `ai` → `agent` → `coding-agent` → (`mom`); `tui` is consumed by `coding-agent` and `web-ui`. The repo build order respects this.

## Commands

Run these from the **repo root** unless noted:

```bash
npm install          # Install all workspace dependencies
npm run build        # Build all packages in dependency order (required before check)
npm run check        # Biome (lint+format, --write) + tsgo type check + browser smoke + web-ui check
./test.sh            # Run all tests with API keys stripped (skips LLM-dependent tests)
./pi-test.sh         # Run the pi coding agent from source (works from any directory)
npm run dev          # Watch-build all packages concurrently
```

- `npm run check` **requires `npm run build` first** — web-ui uses `tsc`, which needs compiled `.d.ts` files from dependencies.
- `npm run check` does **not** run tests. After code changes (not doc-only changes), run `npm run check`, read the full output, and fix all errors, warnings, and infos before committing.
- Type checking uses `tsgo` (`@typescript/native-preview`), not `tsc`, except for web-ui.

### Tests

- Most packages use **Vitest**; `packages/tui` uses the **node test runner** (`node --test --import tsx`).
- Run tests **from the package root**, not the repo root.
- Run a single test file (from the package dir):
  ```bash
  npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
  ```
- `./test.sh` backs up `~/.pi/agent/auth.json`, unsets all provider API-key env vars, and sets `PI_NO_LOCAL_LLM=1` so LLM-dependent tests are skipped. This mirrors CI.
- If you create or modify a test file, you MUST run it and iterate until it passes.

### Manually testing the coding agent's TUI

Drive the interactive TUI in a controlled terminal with `tmux` (`./pi-test.sh` starts pi from source). See the "Testing pi Interactive Mode with tmux" section of `AGENTS.md` for the full recipe. Use `./pi-test.sh --no-env` to run without API keys.

## Code conventions

Formatting/linting is enforced by Biome (`biome.json`): **tab indentation (width 3), 120-char lines**. A Husky `pre-commit` hook runs `npm run check` (plus a browser smoke check when `packages/ai`, `packages/web-ui`, or lockfiles changed) and restages formatted files.

- `git commit --no-verify` is **never** allowed.
- No `any` types unless absolutely necessary (Biome's `noExplicitAny` is off, but the project rule still forbids it).
- **Never use inline/dynamic imports** — no `await import(...)`, no `import("pkg").Type` in type positions. Always use top-level imports. (Exception: the lazy provider-loader wrappers in `packages/ai/src/providers/register-builtins.ts`, which deliberately defer loading provider implementations.)
- Don't downgrade or remove code to satisfy type errors from outdated dependencies — upgrade the dependency instead.
- Don't preserve backward compatibility unless explicitly asked.
- Keybindings must always be configurable. Never hardcode `matchesKey(keyData, "ctrl+x")`; add a default to the matching object (`DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS`).
- Check `node_modules` for an external library's real type definitions instead of guessing.
- Reading files: use the read tool with offset/limit, never `sed`/`cat`.

## Architecture notes

### packages/ai — provider abstraction
The unifying entry point is `stream()` in `src/stream.ts`, which dispatches by `Api` type to a provider in `src/providers/`. Each provider converts pi's standard message/tool format to the provider wire format and parses responses back into a standardized `AssistantMessageEventStream` of events (`text`, `tool_call`, `thinking`, `usage`, `stop`). This normalization is what enables **cross-provider handoff** (continuing a conversation on a different provider mid-session). Core types live in `src/types.ts`; providers are lazily registered in `src/providers/register-builtins.ts`; credential detection is in `src/env-api-keys.ts`. The model catalog `src/models.generated.ts` is generated by `scripts/generate-models.ts` (Biome ignores generated files). Adding a provider touches ~7 areas — follow the checklist in `AGENTS.md`.

### packages/agent — agent runtime
The agent works with `AgentMessage` (a superset of LLM messages, extensible via declaration merging). The required `convertToLlm` function bridges `AgentMessage[]` to the `Message[]` the LLM understands, with an optional `transformContext()` step before it. See `src/agent.ts`, `src/agent-loop.ts`, and the README for the message-flow diagram.

### packages/coding-agent — the `pi` CLI
Entry: `src/cli.ts` / `src/main.ts`. Runs in four modes (`src/modes/`): **interactive** (TUI), **print/JSON** (`print-mode.ts`), **RPC** (process integration), and an **SDK** (`src/core/sdk.ts`) for embedding. Built-in tools (read, bash, edit, write, find, grep, ls) live in `src/core/tools/`. The design philosophy is a minimal core that users extend via TypeScript **Extensions**, **Skills**, **Prompt Templates**, and **Themes**, packaged as "pi packages" shared over npm/git — rather than baking features into core. Config dir is `.pi` (see `piConfig` in its `package.json`); this repo's own `.pi/` holds dogfooded extensions and prompt templates.

### packages/tui
A from-scratch differential renderer: only changed regions are redrawn, using CSI 2026 synchronized output for flicker-free updates. Components implement a `render()` interface and accept theme objects. See `src/tui.ts` and `src/components/`.

## Git & contribution workflow

- This repo uses an approval gate for new contributors (open an issue, get `lgtm`) — see `CONTRIBUTING.md`.
- Do **not** edit `CHANGELOG.md` files as a contributor; maintainers add entries. (When working as a maintainer agent, follow the changelog rules in `AGENTS.md`: entries go under `## [Unreleased]`, released sections are immutable.)
- Include `fixes #<n>` / `closes #<n>` in commit messages when there's a related issue or PR.
- CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run build` → `npm run check` → `npm test` on Node 22. It installs `fd`/`ripgrep` and cairo/pango system libs, so match that environment when reproducing failures.
- No emojis in commits, issues, PR comments, or code. Technical prose only.
