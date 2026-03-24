# AI Engineering Team

An autonomous AI engineering team that watches your Linear backlog,
picks up tickets it can handle, and ships PRs.

## How it works

This isn't a pipeline — it's a **team**. A Product Owner agent receives
each ticket and manages specialists, making decisions at each step.

```
Linear backlog
  │
  ├─ Quick triage (Haiku, $0.001)
  │   "Is this worth the team's time?"
  │
  └─ 👔 Product Owner (Sonnet)
       │   Reads ticket, thinks, delegates, decides
       │
       ├─→ 🔍 Triage Analyst (Haiku)
       │     "Can we handle this autonomously?"
       │     PO reads result, decides: continue or escalate
       │
       ├─→ 🧪 Senior Engineer (Sonnet, read-only)
       │     Searches codebase, reads docs via Context7
       │     PO reads investigation, decides: plan or escalate
       │
       ├─→ 📐 Tech Lead (Sonnet, read-only)
       │     Writes implementation plan, verifies APIs via Context7
       │     PO reads plan, decides: implement, revise, or escalate
       │
       ├─→ 💻 Developer (Sonnet, write access)
       │     Implements plan, uses project skills, runs tests, commits
       │     PO checks: did it work?
       │
       ├─→ 🔎 Code Reviewer (Sonnet, read-only)
       │     Reviews diff for quality
       │     PO reads verdict:
       │       APPROVE → ship it
       │       NEEDS_CLEANUP → send Developer back (max 2x)
       │       REJECT → escalate
       │
       └─→ Push branch, open PR, comment on Linear
```

## Why a team, not a pipeline?

A pipeline is rigid — step 1, step 2, step 3, done. A team is adaptive:

- PO can **skip steps** for trivial tickets
- PO can **go back** if new info changes things
- PO can **ask for more** — send Senior Engineer back with questions
- PO can **reject a plan** and ask Tech Lead to revise
- PO can **stop early** when something smells wrong
- PO **thinks out loud** about decisions, leaving a trail

The PO's reasoning is visible in the logs, so you can see *why* it
made each decision — not just what it did.

## Per-agent capabilities

| Role             | Model  | Tools                          | MCPs     | Skills |
|-----------------|--------|-------------------------------|----------|--------|
| Product Owner    | Sonnet | Read, Glob, Grep, Agent       | Context7 | ✅     |
| Triage Analyst   | Haiku  | none                          | —        | —      |
| Senior Engineer  | Sonnet | Read, Glob, Grep              | Context7 | —      |
| Tech Lead        | Sonnet | Read                          | Context7 | —      |
| Developer        | Sonnet | Read, Edit, Write, Bash, Glob | Context7 | ✅     |
| Code Reviewer    | Sonnet | Read, Bash, Grep              | Context7 | —      |

Only the Developer can modify files. Only the Developer and PO load
project skills. All agents except Triage can look up live docs via Context7.

## Setup

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt install gh && gh auth login

cd ~/linear-eng-team
cp .env.example .env   # fill in keys
bun install
```

## Adding project skills

```
your-repo/.claude/skills/
  typescript/SKILL.md     # naming, patterns, do/don't
  react/SKILL.md          # component patterns, hooks
  testing/SKILL.md        # test conventions
```

## Adding more MCPs

Edit `src/mcps.ts`, then reference in `src/team.ts`:

```typescript
// mcps.ts
export function sentryServer() {
  return { "sentry": { command: "npx", args: ["-y", "@sentry/mcp-server"], env: { ... } } };
}

// team.ts — give to senior engineer
mcpServers: [withContext7(sentryServer())],
```

## Run

```bash
bun run dry-run    # triage only
bun run start      # full team
```

## File structure

```
src/
  main.ts      ← polling loop
  config.ts    ← env vars
  linear.ts    ← Linear API client
  git.ts       ← branch, commit, PR
  seen.ts      ← processed issues tracker
  triage.ts    ← cheap pre-filter
  mcps.ts      ← MCP server configs
  team.ts      ← team member definitions (subagents)
  po.ts        ← Product Owner orchestrator
```

## Cost per ticket

| What              | Model  | Cost        |
|------------------|--------|-------------|
| Pre-filter        | Haiku  | ~$0.001     |
| PO orchestration  | Sonnet | ~$0.30–0.80 |
| Investigation     | Sonnet | ~$0.20–0.50 |
| Planning          | Sonnet | ~$0.05–0.15 |
| Implementation    | Sonnet | ~$0.30–1.00 |
| Review            | Sonnet | ~$0.10–0.30 |
| **Total shipped** |        | **~$1–3**   |
| **Escalated**     |        | **~$0.50–1**|

Tickets that fail pre-triage cost ~$0.001.
