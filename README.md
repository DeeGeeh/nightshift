# Nightshift

Autonomous AI engineering team that works your Linear backlog while you sleep. Polls for tickets, triages, investigates, fixes, and opens PRs — all using your Claude Max subscription during off-hours so your quota is fresh when you wake up.

Built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk). Runs on Bun.

## How it works

```
6 PM                                              5 AM
  |<-------------- nightshift active ------------->|
  |                                                |
  |  Poll Linear -> triage -> investigate ->       |  quota recovers
  |  plan -> implement -> review -> CI gate ->     |  while you sleep
  |  open PR -> check for review feedback ->       |
  |  repeat                                        |
```

1. Polls Linear for `backlog`/`unstarted`/`triage` issues (or issues labeled `auto-fix`)
2. Quick triage via Haiku decides if the ticket is suitable for autonomous work
3. Product Owner agent (Sonnet) orchestrates a team of subagents to fix it
4. Pushes branch, waits for CI to pass (fixes failures automatically, up to 2 retries)
5. Opens a PR for you to review in the morning
6. At shift start, checks open PRs for review comments and addresses feedback
7. When idle, runs DRY cleanup refactors on the codebase

## The team

```
Ticket from Linear
  |
  +-- Product Owner (Sonnet) -- orchestrates, decides at each step
       |
       +-- Triage Analyst (Haiku)    -- worth our time?
       +-- Senior Engineer (Sonnet)  -- investigate root cause (read-only)
       +-- Tech Lead (Sonnet)        -- write implementation plan (read-only)
       +-- Frontend Dev (Sonnet)     -- React/Next.js/Tailwind implementation
       +-- Backend Dev (Sonnet)      -- monorepo/build/backend implementation
       +-- Polish Dev (Sonnet)       -- UI micro-detail cleanup (optional)
       +-- Code Reviewer (Sonnet)    -- review diff before shipping
```

The PO is a real agent, not a pipeline. It reads each subagent's output and decides what to do next — skip steps, retry, go back, or escalate to humans.

## Setup

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt install gh && gh auth login
claude login                       # authenticate with your Max account

cd ~/nightshift
cp .env.example .env               # fill in LINEAR_API_KEY, GITHUB_TOKEN, REPO_PATH
bun install
```

No Anthropic API key needed — the Agent SDK uses your `claude login` session directly.

## Run

```bash
bun run start                      # full nightshift
bun run dry-run                    # triage only, no fixes
FORCE_ISSUE=ABC-123 bun run start  # process one specific issue
ONCE=true bun run start            # single poll cycle then exit
```

If started during the day, it sleeps until `SHIFT_START`.

## Config

All config is via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `SHIFT_START` | `18` | Hour shift begins (24h) |
| `SHIFT_STOP` | `5` | Hour shift ends |
| `POLL_INTERVAL_MS` | `60000` | Linear poll interval |
| `MAX_CONCURRENT` | `1` | Parallel tickets |
| `CI_TIMEOUT_MS` | `600000` | Max wait for CI checks (10 min) |
| `MAX_CI_RETRIES` | `2` | CI fix attempts before giving up |
| `CLEANUP_ENABLED` | `true` | DRY refactoring during idle time |
| `DRY_RUN` | `false` | Log actions without executing |

## File structure

```
main.ts          polling loop, shift scheduling, idle orchestration
config.ts        env vars
linear.ts        Linear GraphQL client (issues, comments, labels, state)
git.ts           branch management, PR creation via gh CLI
seen.ts          processed-issues tracker (seen-issues.json, 30-day TTL)
triage.ts        quick Haiku triage (standalone, pre-PO filter)
team.ts          subagent definitions (AgentDefinition objects)
po.ts            Product Owner orchestrator (runs the team per ticket)
ci-gate.ts       CI check polling, failure log fetching, fix agent, retry loop
pr-feedback.ts   discover open PRs with unprocessed review comments
revise.ts        address review feedback on existing PRs
cleanup.ts       idle-time DRY refactoring (find duplication, extract utilities)
mcps.ts          MCP server configs (Context7)
```

## Safety

- **PRs only** — never merges, always waits for human review
- **CI gate** — waits for checks to pass, attempts to fix failures, marks as needs-human if it can't
- **PO judgment** — can bail at any step, escalate to humans
- **Code review gate** — strict reviewer with cleanup loop before shipping
- **Shift schedule** — only runs during configured hours, 30 min wind-down buffer
- **Deduplication** — `seen-issues.json` prevents reprocessing, `seen-comments.json` tracks handled review feedback
