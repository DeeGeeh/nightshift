# 🌙 Nightshift

AI engineering team that fixes your bugs while you sleep.

Watches your Linear backlog, triages tickets autonomously, fixes what it
can, opens PRs for you to review in the morning. Runs on your Claude Max
subscription during off-hours so your quota is fresh when you wake up.

## How it works

```
6 PM                                              5 AM          10 AM
  │◄──────────── nightshift active ──────────────►│◄── sleep ──►│
  │                                                │              │
  │  Poll Linear → triage → investigate →          │  quota       │ you
  │  plan → fix → review → open PR                 │  recovers    │ start
  │  repeat                                        │              │ work
```

- **18:00** — Nightshift wakes up, starts polling Linear
- **04:30** — Stops picking up new tickets (30 min buffer for active work)
- **05:00** — Goes to sleep
- **05:00–10:00** — Your Max quota recovers (5h rolling window)
- **10:00** — You start your day with full quota and PRs waiting

## The team

```
📨 New ticket from Linear
  │
  └─ 👔 Product Owner (Sonnet)
       Reads ticket, thinks, delegates, decides at each step
       │
       ├─→ 🔍 Triage Analyst (Haiku) — worth our time?
       ├─→ 🧪 Senior Engineer (Sonnet) — what's the root cause?
       ├─→ 📐 Tech Lead (Sonnet) — what's the fix plan?
       ├─→ 💻 Developer (Sonnet) — implement it
       ├─→ 🔎 Code Reviewer (Sonnet) — is it good enough?
       └─→ 🚀 Push & open PR
```

The PO is an actual agent that reasons about each step — it can skip
steps, go back, reject plans, or escalate to humans. Not a rigid pipeline.

## Auth: Claude Max subscription

No API key needed. Uses your `claude login` session directly.

```bash
# One-time setup on the laptop
claude login
# Select your Max account
```

The Agent SDK authenticates through your local session.

## Setup

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt install gh && gh auth login
claude login  # authenticate with Max account

cd ~/nightshift
cp .env.example .env   # fill in Linear + GitHub keys
bun install
```

## Run

```bash
bun run dry-run    # triage only, no fixes
bun run start      # full nightshift
```

If you start it during the day, it'll print when the next shift begins
and sleep until then.

## Sofa laptop setup

```bash
# Don't sleep on lid close
sudo sed -i 's/#HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo sed -i 's/#HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind

# Run in tmux
tmux new -s nightshift
bun run start
# Ctrl+B, D to detach

# Or as a systemd service (auto-start on boot)
sudo tee /etc/systemd/system/nightshift.service << 'EOF'
[Unit]
Description=Nightshift - AI Engineering Team
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/nightshift
EnvironmentFile=/home/YOUR_USERNAME/nightshift/.env
ExecStart=/home/YOUR_USERNAME/.bun/bin/bun run src/main.ts
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nightshift
sudo systemctl start nightshift
journalctl -u nightshift -f
```

## Schedule config

```bash
# Default: work 6 PM to 5 AM
SHIFT_START=18
SHIFT_STOP=5

# Weekend warrior: run all day Saturday/Sunday
# (not yet implemented — PRs welcome)

# Night owl: work 10 PM to 4 AM
SHIFT_START=22
SHIFT_STOP=4
```

The agent stops picking up new tickets 30 minutes before shift end,
giving any active work time to finish cleanly.

## File structure

```
src/
  main.ts      ← polling loop + shift scheduling
  config.ts    ← env vars + schedule
  linear.ts    ← Linear API client
  git.ts       ← branch, commit, PR
  seen.ts      ← processed issues tracker
  triage.ts    ← quick Haiku triage (via SDK)
  mcps.ts      ← MCP configs (Context7, etc.)
  team.ts      ← team roles (subagent definitions)
  po.ts        ← Product Owner orchestrator
```

## Adding project skills

```
your-repo/.claude/skills/
  typescript/SKILL.md
  react/SKILL.md
  testing/SKILL.md
```

The Developer agent loads these automatically.

## Safety

- **PRs only** — never merges anything
- **PO judgment** — can bail at any step
- **Review gate** — code reviewer with cleanup loop
- **Shift schedule** — doesn't eat your daytime quota
- **30 min wind-down** — stops new work before shift end
- **seen-issues.json** — never reprocesses tickets