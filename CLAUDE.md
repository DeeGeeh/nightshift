# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Nightshift is an autonomous AI engineering team that watches a Linear backlog during off-hours (default 6 PM – 5 AM), triages tickets, fixes bugs, and opens PRs. It runs on a Claude Max subscription via the Agent SDK — no API key needed, just `claude login`.

## Commands

```bash
bun install              # install dependencies
bun run start            # full nightshift (polls Linear, fixes bugs, opens PRs)
bun run dry-run          # triage only, no fixes (DRY_RUN=true)
FORCE_ISSUE=ABC-123 bun run start   # process a single issue then exit
ONCE=true bun run start              # run one poll cycle then exit
```

There are no tests, no linter, and no build step. The project runs TypeScript directly via Bun.

## Architecture

The system is a **multi-agent team** built on `@anthropic-ai/claude-agent-sdk`. It is NOT a pipeline — the Product Owner agent makes decisions at each step and can skip, retry, or bail.

### Agent Hierarchy

```
main.ts (polling loop + shift scheduler)
  └─ po.ts — Product Owner (Sonnet) — orchestrator, runs as main query()
       ├─ triage-analyst (Haiku) — 1-turn assessment, no tools
       ├─ senior-engineer (Sonnet) — read-only investigation, Context7
       ├─ tech-lead (Sonnet) — read-only planning, Context7
       ├─ frontend-dev (Sonnet) — React/Next.js implementation, full tools
       ├─ backend-dev (Sonnet) — infra/build/backend implementation, full tools
       ├─ polish-dev (Sonnet) — UI micro-detail cleanup, full tools
       └─ code-reviewer (Sonnet) — reviews git diff, read-only + Bash
```

All subagent definitions live in `team.ts` as `AgentDefinition` objects. The PO invokes them via the SDK's `Agent` tool with `agents: { ... }` config.

### Key Flows

1. **Ticket flow** (`main.ts` → `triage.ts` → `po.ts`): Poll Linear → quick Haiku triage → if suitable, hand to PO → PO runs team → push branch + open PR via `git.ts`
2. **Idle cleanup** (`main.ts` → `cleanup.ts`): When no tickets, runs a cleanup-dev + code-reviewer cycle to find DRY violations and open refactor PRs
3. **Shift scheduling** (`main.ts`): Sleeps outside configured hours, 30-min wind-down buffer before shift end

### Module Responsibilities

- `config.ts` — all env vars, parsed once at startup. Required: `LINEAR_API_KEY`, `GITHUB_TOKEN`, `REPO_PATH`
- `linear.ts` — GraphQL client for Linear (fetch issues, update state, add labels/comments, create documents)
- `git.ts` — branch management, commit checking, PR creation via `gh`. Commits as "Nightshift" bot identity
- `seen.ts` — `seen-issues.json` persistence with 30-day TTL, prevents reprocessing
- `mcps.ts` — Context7 MCP server config (HTTP if API key provided, otherwise npx fallback)
- `triage.ts` — standalone quick triage using Haiku (separate from the team's triage-analyst)

### Important Patterns

- The PO outputs results in `<result>OUTCOME: SHIPPED/ESCALATED/ABANDONED</result>` blocks — `po.ts` parses these to decide next action (push PR, label issue, etc.)
- All agents run against `CONFIG.repoPath` (the target repo being fixed), NOT this nightshift repo
- `git.ts:sh()` runs shell commands; `git.ts:spawn()` uses argument arrays to avoid injection
- Labels `auto-fix` and `needs-human` on Linear issues track outcomes
- The `seen.ts` map is the source of truth for "have we already looked at this issue"
