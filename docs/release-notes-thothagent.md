# ThothAgent 2026.5.6-beta1

## Release Summary

ThothAgent is now published as a self-improving framework for domain-specific AI agents. This beta marks the transition from a single-vertical prototype into a reusable runtime built around layered memory, adaptive retrieval, session continuity, and multi-surface control.

## Highlights

- Rebranded the runtime, CLI, web control UI, and package distribution under the unified `ThothAgent` identity.
- Published the first npm-installable package as `thoth-agent` with the `thoth` CLI entrypoint.
- Upgraded the memory architecture to combine built-in memory files with provider-based external retrieval.
- Improved session orchestration with SQLite-backed history, active session indexing, and better multi-client continuity.
- Refined the web control experience into a cleaner Apple-inspired glass UI with stronger chat usability.

## Included In This Beta

### Self-Improving Memory Stack

- Built-in memory layers for `MEMORY.md`, `USER.md`, `DOMAIN.md`, and working state injection.
- External memory provider abstraction so retrieval is no longer tied to one hard-coded storage implementation.
- Durable retrieval records designed for future hybrid search, reranking, compaction, decay, and long-term recall improvements.

### Session-Aware Runtime

- SQLite-backed conversation history for stronger persistence and replay.
- Session indexing and active-session recovery for TUI and web control surfaces.
- Lifecycle-oriented memory sync hooks that keep turns, summaries, and retrieval updates aligned.

### Multi-Surface Control

- Terminal-first `thoth` CLI and TUI workflow.
- Gateway-backed web control UI for chat, dashboard, and settings surfaces.
- Cleaner structure for sharing one active agent/session model across clients.

### Foundation For Vertical Agents

- Shifted project positioning from a pet-only assistant to a general vertical-agent framework.
- Preserved the architecture needed to specialize into domains like healthcare, operations, support, research, or other expert copilots.

## Why This Release Matters

This beta is the foundation release for ThothAgent as an open-source framework. The important change is not just a rename: the project now has a clearer runtime model for memory, session state, retrieval, and extensibility, which makes it much easier to evolve into a production-grade agent platform.

## Quick Start

```bash
npm install -g thoth-agent
thoth configure
thoth tui
```

## Suggested GitHub Release Blurb

ThothAgent is a self-improving framework for domain-specific AI agents with layered memory, adaptive retrieval, and session-aware orchestration across CLI, gateway, and web UI.
