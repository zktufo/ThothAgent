# ThothAgent

> A self-improving framework for domain-specific AI agents with layered memory, adaptive retrieval, and session-aware orchestration.

ThothAgent is a configurable runtime for building vertical AI copilots that improve over time through persistent memory, provider-based retrieval, tool feedback loops, and structured session lifecycle management.

## Why ThothAgent

- Build domain-specific agents instead of one-off chatbots
- Persist long-term memory across sessions with layered memory architecture
- Route memory through pluggable external providers instead of hard-coded storage
- Keep session continuity with SQLite-backed history, summaries, and compaction
- Combine tools, retrieval, and memory into a single agent runtime
- Evolve agent behavior over time through explicit memory writes and conversation insights

## Core Capabilities

- Layered memory: `MEMORY.md`, `USER.md`, `DOMAIN.md`, working state, and external retrieval
- Adaptive retrieval: provider-driven `memory_search` with hybrid lexical/embedding scoring
- Session orchestration: active session routing, indexing, archival summaries, and compaction
- Tool runtime: native tool catalog, secure execution harness, and structured trace logging
- Pluggable providers: local file provider by default, extensible for remote memory backends
- Multi-surface control: CLI, TUI, gateway, and web control UI

## Quick Start

```bash
git clone https://github.com/zktufo/ThothAgent.git
cd ThothAgent
npm install
npm run build
node dist/cli/main.js tui
```

## Project Structure

```text
src/
├── agent/              # prompt composition and agent-facing memory formatting
├── cli/                # CLI, TUI entrypoints, and configure flows
├── core/               # MCP integration and skill registry
├── gateway/            # websocket/http gateway and web control surface backend
├── harness/            # guarded exec/read/write tool harness
├── home/               # ~/.PetAgent bootstrap and runtime home layout
├── infra/              # logging, metrics, scheduler, tracing, maintenance
├── llm/                # provider adapters and tool-loop runtime
├── memory/             # unified memory facade
│   └── layered/        # layered memory, retrieval, providers, and prompt injection
├── model_manager/      # model routing and provider configuration
├── runtime/            # tool manager and agent runtime loop
├── session/            # session store, compression, routing, archiving
└── tools/              # built-in tool adapters
```

## Runtime Data Layout

```text
~/.PetAgent/
├── AGENTS.md
├── PetAgent.json
├── agents/
│   └── main/
│       ├── SOUL.md
│       ├── USER.md
│       ├── MEMORY.md
│       ├── DOMAIN.md
│       ├── memory/
│       │   ├── daily/
│       │   └── layered/
│       │       ├── retrieval_memory.db
│       │       └── working_state.json
│       └── sessions/
│           ├── session.sqlite
│           └── session.json
└── workspace/
```

## External Memory Providers

ThothAgent treats external memory as a provider capability rather than a fixed local database.

- Default provider: `local-file`
- Config path: `memory.externalProvider` in `~/.PetAgent/PetAgent.json`
- Search path: `memory_search` calls the currently configured provider abstraction
- Future-ready: remote providers such as Honcho can be added without rewriting the tool layer

## Self-Improvement Loop

ThothAgent is designed to improve over time through a simple but extensible loop:

1. The agent completes a turn
2. High-value turns trigger background memory persistence
3. Explicit `memory` writes are stored as durable retrieval records
4. Session summaries and conversation insights become searchable long-term memory
5. Later turns can recall and reuse those insights through provider-backed retrieval

## Web Control UI

The built-in web UI provides:

- chat surface with live session sync
- dashboard view for runtime state
- Apple-inspired glass UI system
- multimodal input entrypoints
- animated message timeline and trace visibility

## Development

```bash
npm run build
npm run typecheck
npm run memory:test
```

## Star History

<a href="https://www.star-history.com/?repos=zktufo%2FThothAgent&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=zktufo/ThothAgent&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=zktufo/ThothAgent&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=zktufo/ThothAgent&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT
