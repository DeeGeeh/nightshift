#!/usr/bin/env bun

import { CONFIG } from "./config.ts";
import { fetchNewIssues, addLabelToIssue } from "./linear.ts";
import { hasSeen, markSeen, seenCount } from "./seen.ts";
import { quickTriage } from "./triage.ts";
import { assignToTeam } from "./po.ts";

const activeIssues = new Set<string>();

async function poll() {
  try {
    const issues = await fetchNewIssues();

    const fresh = issues.filter((i) => {
      if (hasSeen(i.id)) return false;
      if (activeIssues.has(i.id)) return false;
      if (i.labels.nodes.some((l) => l.name === "needs-human")) return false;
      if (i.labels.nodes.some((l) => l.name === "auto-fix")) return false;
      return true;
    });

    if (fresh.length === 0) return;
    console.log(`\n📋 ${fresh.length} new ticket(s)`);

    for (const issue of fresh) {
      const tag = `[${issue.identifier}]`;

      // Quick pre-filter (~$0.001) before spinning up the team
      console.log(`${tag} Quick triage: ${issue.title}`);
      const triage = await quickTriage(issue);
      console.log(
        `${tag} → ${triage.canAutoFix ? "✅ suitable" : "❌ not suitable"} ` +
        `(${triage.confidence}) — ${triage.reason}`
      );

      if (!triage.canAutoFix || triage.confidence === "low") {
        await addLabelToIssue(issue.id, "needs-human");
        markSeen(issue, "needs-human");
        continue;
      }

      if (CONFIG.dryRun) {
        console.log(`${tag} [DRY RUN] Would assign to AI team`);
        markSeen(issue, "auto-fix");
        continue;
      }

      if (activeIssues.size >= CONFIG.maxConcurrent) {
        console.log(`${tag} Team is busy (max concurrent reached)`);
        break;
      }

      // Hand the ticket to the Product Owner
      activeIssues.add(issue.id);
      console.log(`${tag} 📨 Assigning to AI engineering team...`);

      assignToTeam(issue)
        .catch((err) => console.error(`${tag} Unhandled:`, err))
        .finally(() => activeIssues.delete(issue.id));
    }
  } catch (err: any) {
    console.error("Poll error:", err.message);
  }
}

// ─── Startup ─────────────────────────────────────────────────────────

console.log(`
╔═══════════════════════════════════════════════╗
║       AI Engineering Team                      ║
╠═══════════════════════════════════════════════╣
║                                                ║
║  Team:                                         ║
║    👔 Product Owner    — orchestrates           ║
║    🔍 Triage Analyst   — quick assessment       ║
║    🧪 Senior Engineer  — investigation          ║
║    📐 Tech Lead        — planning               ║
║    💻 Developer        — implementation          ║
║    🔎 Code Reviewer    — quality gate            ║
║                                                ║
║  MCPs:  Context7 (all agents)                  ║
║  Skills: loaded from .claude/skills/           ║
║                                                ║
║  Repo:    ${CONFIG.repoPath.slice(-33).padEnd(33)} ║
║  Team:    ${(CONFIG.teamKey ?? "all").padEnd(33)} ║
║  Poll:    ${(CONFIG.pollIntervalMs / 1000 + "s").padEnd(33)} ║
║  Dry run: ${String(CONFIG.dryRun).padEnd(33)} ║
║  Tracked: ${(seenCount() + " issues").padEnd(33)} ║
╚═══════════════════════════════════════════════╝
`);

poll();
setInterval(poll, CONFIG.pollIntervalMs);
