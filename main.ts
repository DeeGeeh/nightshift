#!/usr/bin/env bun

/**
 *  ╔═╗╔═╗╦╔═╗╦ ╦╔╦╗╔═╗╦ ╦╦╔═╗╔╦╗
 *  ║║║║ ║║║ ╦╠═╣ ║ ╚═╗╠═╣║╠═╝ ║
 *  ╝╚╝╩ ╩╩╚═╝╩ ╩ ╩ ╚═╝╩ ╩╩╩   ╩
 *
 *  Nightshift — AI engineering team that works while you sleep.
 *  Watches Linear, triages tickets, fixes bugs, opens PRs.
 *  Goes to sleep before you wake up so your quota is fresh.
 */

import { CONFIG } from "./config.ts";
import { fetchNewIssues, fetchIssueByIdentifier, addLabelToIssue, createDocument } from "./linear.ts";
import { hasSeen, markSeen, seenCount, flushSeen } from "./seen.ts";
import { quickTriage } from "./triage.ts";
import { assignToTeam } from "./po.ts";
import type { TeamResult } from "./po.ts";
import { runCodeCleanup } from "./cleanup.ts";
import { fetchPendingFeedback } from "./pr-feedback.ts";
import { processRevision } from "./revise.ts";

const activeIssues = new Set<string>();
let shuttingDown = false;
let shiftStartedAt: Date | null = null;
let lastCleanupAt = 0;
let lastFeedbackCheckAt = 0;

// ─── Shift Changelog ────────────────────────────────────────────────

interface ShiftActivity {
  identifier: string;
  title: string;
  outcome: string;
  prUrl?: string;
  summary?: string;
  diffStats?: string;
  commitLog?: string;
}
const shiftLog: ShiftActivity[] = [];

async function printShiftSummary() {
  if (shiftLog.length === 0) return;

  const now = new Date();
  const startTime = shiftStartedAt ? formatTime(shiftStartedAt) : "??:??";
  const endTime = formatTime(now);
  const shipped = shiftLog.filter(e => e.outcome === "done");
  const escalated = shiftLog.filter(e => e.outcome === "needs-human");
  const failed = shiftLog.filter(e => e.outcome === "failed");

  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(60));
  lines.push(`  NIGHTSHIFT CHANGELOG  |  ${startTime} - ${endTime}  |  ${now.toLocaleDateString("en-GB")}`);
  lines.push("=".repeat(60));

  if (shipped.length > 0) {
    lines.push("");
    lines.push(`  SHIPPED (${shipped.length})`);
    lines.push("  " + "-".repeat(40));
    for (const entry of shipped) {
      lines.push(`  ${entry.identifier}: ${entry.title}`);
      if (entry.prUrl) lines.push(`    PR: ${entry.prUrl}`);
      if (entry.summary) lines.push(`    ${entry.summary.slice(0, 200)}`);
      if (entry.commitLog) {
        for (const commit of entry.commitLog.split("\n").slice(0, 5)) {
          lines.push(`    ${commit}`);
        }
      }
      if (entry.diffStats) {
        const statLines = entry.diffStats.split("\n");
        const summaryLine = statLines[statLines.length - 1];
        if (summaryLine) lines.push(`    ${summaryLine.trim()}`);
      }
      lines.push("");
    }
  }

  if (escalated.length > 0) {
    lines.push(`  ESCALATED (${escalated.length})`);
    lines.push("  " + "-".repeat(40));
    for (const entry of escalated) {
      lines.push(`  ${entry.identifier}: ${entry.title}`);
      if (entry.summary) lines.push(`    ${entry.summary.slice(0, 150)}`);
      lines.push("");
    }
  }

  if (failed.length > 0) {
    lines.push(`  FAILED (${failed.length})`);
    lines.push("  " + "-".repeat(40));
    for (const entry of failed) {
      lines.push(`  ${entry.identifier}: ${entry.title}`);
      if (entry.summary) lines.push(`    ${entry.summary.slice(0, 150)}`);
      lines.push("");
    }
  }

  lines.push("  " + "-".repeat(40));
  lines.push(`  Total: ${shiftLog.length} | Shipped: ${shipped.length} | Escalated: ${escalated.length} | Failed: ${failed.length}`);
  lines.push("=".repeat(60));
  lines.push("");

  console.log(lines.join("\n"));

  // Post to Linear as a document
  try {
    const md = buildShiftMarkdown(shiftLog, startTime, endTime, now);
    const title = `Nightshift Changelog — ${now.toLocaleDateString("en-GB")} ${startTime}–${endTime}`;
    const url = await createDocument(title, md);
    console.log(`  📄 Posted to Linear: ${url}`);
  } catch (err: any) {
    console.error(`  Failed to post changelog to Linear: ${err.message}`);
  }

  shiftLog.length = 0;
}

function buildShiftMarkdown(
  log: ShiftActivity[],
  startTime: string,
  endTime: string,
  now: Date,
): string {
  const shipped = log.filter(e => e.outcome === "done");
  const escalated = log.filter(e => e.outcome === "needs-human");
  const failed = log.filter(e => e.outcome === "failed");

  const lines: string[] = [];
  lines.push(`# Nightshift Changelog`);
  lines.push(`**${now.toLocaleDateString("en-GB")}** | ${startTime} – ${endTime}`);
  lines.push(`**Total: ${log.length}** | Shipped: ${shipped.length} | Escalated: ${escalated.length} | Failed: ${failed.length}`);
  lines.push("");

  if (shipped.length > 0) {
    lines.push(`## Shipped (${shipped.length})`);
    for (const entry of shipped) {
      lines.push(`### ${entry.identifier}: ${entry.title}`);
      if (entry.prUrl) lines.push(`PR: ${entry.prUrl}`);
      if (entry.summary) lines.push(`> ${entry.summary.slice(0, 300)}`);
      if (entry.commitLog) {
        lines.push("```");
        lines.push(entry.commitLog.split("\n").slice(0, 5).join("\n"));
        lines.push("```");
      }
      if (entry.diffStats) {
        const statLines = entry.diffStats.split("\n");
        const summaryLine = statLines[statLines.length - 1];
        if (summaryLine) lines.push(`\`${summaryLine.trim()}\``);
      }
      lines.push("");
    }
  }

  if (escalated.length > 0) {
    lines.push(`## Escalated (${escalated.length})`);
    for (const entry of escalated) {
      lines.push(`- **${entry.identifier}**: ${entry.title}`);
      if (entry.summary) lines.push(`  > ${entry.summary.slice(0, 200)}`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push(`## Failed (${failed.length})`);
    for (const entry of failed) {
      lines.push(`- **${entry.identifier}**: ${entry.title}`);
      if (entry.summary) lines.push(`  > ${entry.summary.slice(0, 200)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Schedule ────────────────────────────────────────────────────────

function isOnShift(): boolean {
  const now = new Date();
  const hour = now.getHours();
  const { shiftStart, shiftStop } = CONFIG;

  if (shiftStart < shiftStop) {
    return hour >= shiftStart && hour < shiftStop;
  } else {
    return hour >= shiftStart || hour < shiftStop;
  }
}

function nextShiftStart(): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(CONFIG.shiftStart, 0, 0, 0);

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Idle Cleanup ────────────────────────────────────────────────────

async function tryIdleCleanup() {
  if (!CONFIG.cleanupEnabled || activeIssues.size > 0 || CONFIG.once || CONFIG.forceIssue) return;

  const now = Date.now();
  if (now - lastCleanupAt < CONFIG.cleanupCooldownMs) return;

  lastCleanupAt = now;
  console.log("\n🧹 Idle — running code cleanup scan...");
  try {
    const result = await runCodeCleanup();
    if (result.outcome !== "skipped") {
      shiftLog.push({
        identifier: "CLEANUP",
        title: result.summary ?? "DRY refactor",
        outcome: result.outcome,
        prUrl: result.prUrl,
        summary: result.summary,
        diffStats: result.diffStats,
        commitLog: result.commitLog,
      });
    }
  } catch (err: any) {
    console.error("Cleanup error:", err.message);
  }
}

// ─── PR Feedback ─────────────────────────────────────────────────────

async function checkPRFeedback() {
  if (activeIssues.size > 0 || CONFIG.forceIssue) return;

  const now = Date.now();
  if (now - lastFeedbackCheckAt < 5 * 60_000) return; // 5 min cooldown
  lastFeedbackCheckAt = now;

  try {
    const pending = await fetchPendingFeedback();
    if (pending.length === 0) return;

    console.log(`\n🔄 ${pending.length} PR(s) with review feedback`);

    for (const feedback of pending) {
      if (shuttingDown) break;
      if (activeIssues.size > 0) break;

      const tag = feedback.issueIdentifier ?? `PR#${feedback.prNumber}`;
      console.log(`[${tag}] ${feedback.comments.length} review comment(s) on: ${feedback.prTitle}`);

      if (CONFIG.dryRun) {
        console.log(`[${tag}] [DRY RUN] Would process review feedback`);
        for (const c of feedback.comments) {
          console.log(`  @${c.author}: ${c.body.slice(0, 100)}`);
        }
        continue;
      }

      const result = await processRevision(feedback);
      shiftLog.push({
        identifier: tag,
        title: `Review feedback: ${feedback.prTitle}`,
        outcome: result.outcome,
        prUrl: feedback.prUrl,
        summary: result.summary,
        diffStats: result.diffStats,
        commitLog: result.commitLog,
      });
    }
  } catch (err: any) {
    console.error("PR feedback check error:", err.message);
  }
}

// ─── Poll ────────────────────────────────────────────────────────────

async function poll() {
  if (shuttingDown) return;

  // Don't start new work outside shift hours (unless --once or FORCE_ISSUE)
  if (!CONFIG.once && !CONFIG.forceIssue && !isOnShift()) return;

  // Don't pick up new tickets if we're close to shift end (30 min buffer)
  if (!CONFIG.once && !CONFIG.forceIssue) {
    const now = new Date();
    const stopToday = new Date(now);
    stopToday.setHours(CONFIG.shiftStop, 0, 0, 0);
    if (CONFIG.shiftStart > CONFIG.shiftStop) {
      if (now.getHours() >= CONFIG.shiftStart) {
        stopToday.setDate(stopToday.getDate() + 1);
      }
    }
    const msUntilStop = stopToday.getTime() - now.getTime();
    if (msUntilStop > 0 && msUntilStop < 30 * 60_000) {
      if (activeIssues.size > 0) {
        console.log(`\u23f0 Shift ending in ${formatDuration(msUntilStop)}, waiting for active work to finish...`);
      } else {
        console.log(`\u23f0 Shift ending in ${formatDuration(msUntilStop)}, not picking up new tickets.`);
      }
      return;
    }
  }

  try {
    // ── FORCE_ISSUE mode: process a single specific issue ──
    if (CONFIG.forceIssue) {
      const issue = await fetchIssueByIdentifier(CONFIG.forceIssue);
      if (!issue) {
        console.error(`Issue ${CONFIG.forceIssue} not found`);
        return;
      }
      console.log(`\n🎯 Force processing: ${issue.identifier} — ${issue.title}`);
      activeIssues.add(issue.id);
      try {
        const result = await assignToTeam(issue);
        shiftLog.push({
          identifier: issue.identifier, title: issue.title,
          outcome: result.outcome, prUrl: result.prUrl,
          summary: result.summary, diffStats: result.diffStats,
          commitLog: result.commitLog,
        });
      } catch (err: any) {
        console.error(`[${issue.identifier}] Unhandled:`, err);
        shiftLog.push({ identifier: issue.identifier, title: issue.title, outcome: "failed" });
      } finally {
        activeIssues.delete(issue.id);
      }
      return;
    }

    // ── Normal polling mode ──
    const issues = await fetchNewIssues();

    if (issues.length === 0) {
      console.log(`\n\u{1f4ed} No issues found in Linear (backlog/unstarted/triage)`);
      await checkPRFeedback();
      await tryIdleCleanup();
      return;
    }

    const fresh = issues.filter((i) => {
      if (hasSeen(i.id)) return false;
      if (activeIssues.has(i.id)) return false;
      if (!CONFIG.retriage) {
        if (i.labels.nodes.some((l) => l.name === "needs-human")) return false;
        if (i.labels.nodes.some((l) => l.name === "auto-fix")) return false;
      }
      return true;
    });

    if (fresh.length === 0) {
      console.log(`\n\u{1f4ed} ${issues.length} issue(s) found but all already triaged or in progress`);
      await checkPRFeedback();
      await tryIdleCleanup();
      return;
    }
    console.log(`\n\u{1f4cb} ${fresh.length} new ticket(s)`);

    for (const issue of fresh) {
      if (shuttingDown) break;
      const tag = `[${issue.identifier}]`;

      console.log(`${tag} Quick triage: ${issue.title}`);
      const triage = await quickTriage(issue);
      console.log(
        `${tag} \u2192 ${triage.canAutoFix ? "\u2705 suitable" : "\u274c not suitable"} ` +
        `(${triage.confidence}) \u2014 ${triage.reason}`
      );

      if (!triage.canAutoFix || triage.confidence === "low") {
        await addLabelToIssue(issue.id, "needs-human");
        markSeen(issue, "needs-human");
        shiftLog.push({ identifier: issue.identifier, title: issue.title, outcome: "needs-human", summary: triage.reason });
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

      activeIssues.add(issue.id);
      console.log(`${tag} \u{1f4e8} Assigning to AI engineering team...`);

      assignToTeam(issue)
        .then((result: TeamResult) => {
          shiftLog.push({
            identifier: issue.identifier, title: issue.title,
            outcome: result.outcome, prUrl: result.prUrl,
            summary: result.summary, diffStats: result.diffStats,
            commitLog: result.commitLog,
          });
        })
        .catch((err: any) => {
          console.error(`${tag} Unhandled:`, err);
          shiftLog.push({ identifier: issue.identifier, title: issue.title, outcome: "failed" });
        })
        .finally(() => activeIssues.delete(issue.id));
    }
  } catch (err: any) {
    console.error("Poll error:", err.message);
  }
}

// ─── Graceful shutdown ──────────────────────────────────────────────

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Shutting down gracefully...`);

  if (activeIssues.size > 0) {
    console.log(`Waiting for ${activeIssues.size} active issue(s) to finish (max 2 min)...`);
    const deadline = Date.now() + 120_000;
    while (activeIssues.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
    }
    if (activeIssues.size > 0) {
      console.log(`${activeIssues.size} issue(s) still active, forcing exit.`);
    }
  }

  await printShiftSummary();
  flushSeen();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Main loop with shift awareness ─────────────────────────────────

let wasOffShift = false;
let polling = false;

async function tick() {
  if (shuttingDown) return;
  if (isOnShift() || CONFIG.once || CONFIG.forceIssue) {
    if (wasOffShift) {
      shiftStartedAt = new Date();
      console.log(`\n\u{1f319} Shift started at ${formatTime(shiftStartedAt)}. Nightshift is active.\n`);
      wasOffShift = false;
      lastFeedbackCheckAt = 0; // force PR feedback check at shift start
    }
    if (polling) return;
    polling = true;
    try {
      await poll();
    } finally {
      polling = false;
    }
  } else {
    if (!wasOffShift) {
      await printShiftSummary();
      const next = nextShiftStart();
      const until = formatDuration(next.getTime() - Date.now());
      console.log(`\n\u2600\ufe0f  Off shift. Sleeping until ${formatTime(next)} (${until}). Your quota is recovering.\n`);
      wasOffShift = true;
    }
  }
}

// ─── Startup ─────────────────────────────────────────────────────────

const shiftLabel = CONFIG.shiftStart > CONFIG.shiftStop
  ? `${CONFIG.shiftStart}:00 \u2192 ${String(CONFIG.shiftStop).padStart(2, "0")}:00 (overnight)`
  : `${CONFIG.shiftStart}:00 \u2192 ${CONFIG.shiftStop}:00`;

const mode = CONFIG.forceIssue ? `force: ${CONFIG.forceIssue}` : CONFIG.once ? "once" : CONFIG.dryRun ? "dry-run" : "normal";

console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551          \u{1f319} N I G H T S H I F T \u{1f319}           \u2551
\u2551       AI engineering team that never sleeps    \u2551
\u2551          (well, it sleeps during the day)      \u2551
\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563
\u2551                                                \u2551
\u2551  Team:                                         \u2551
\u2551    \u{1f454} Product Owner    \u2014 orchestrates           \u2551
\u2551    \u{1f50d} Triage Analyst   \u2014 quick assessment       \u2551
\u2551    \u{1f9ea} Senior Engineer  \u2014 investigation          \u2551
\u2551    \u{1f4d0} Tech Lead        \u2014 planning               \u2551
\u2551    \u{1f4bb} Developer        \u2014 implementation          \u2551
\u2551    \u{1f50e} Code Reviewer    \u2014 quality gate            \u2551
\u2551                                                \u2551
\u2551  Schedule: ${shiftLabel.padEnd(36)} \u2551
\u2551  Repo:     ${CONFIG.repoPath.slice(-33).padEnd(33)} \u2551
\u2551  Team:     ${(CONFIG.teamKey ?? "all").padEnd(33)} \u2551
\u2551  Poll:     ${(CONFIG.pollIntervalMs / 1000 + "s").padEnd(33)} \u2551
\u2551  Mode:     ${mode.padEnd(33)} \u2551
\u2551  Tracked:  ${(seenCount() + " issues").padEnd(33)} \u2551
\u2551  Auth:     ${"claude login session (Max)".padEnd(33)} \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
`);

if (isOnShift() || CONFIG.once || CONFIG.forceIssue) {
  shiftStartedAt = new Date();
  console.log(`\u{1f319} ${CONFIG.once || CONFIG.forceIssue ? "Running single cycle." : "Currently on shift. Working."}\n`);
} else {
  const next = nextShiftStart();
  console.log(`\u2600\ufe0f  Currently off shift. Next shift: ${formatTime(next)} (${formatDuration(next.getTime() - Date.now())})\n`);
}

tick();

if (CONFIG.once || CONFIG.forceIssue) {
  // Single poll, then exit when active work finishes
  const checkDone = setInterval(() => {
    if (activeIssues.size === 0 && !polling) {
      clearInterval(checkDone);
      printShiftSummary().then(() => {
        flushSeen();
        process.exit(0);
      });
    }
  }, 5000);
} else {
  setInterval(tick, CONFIG.pollIntervalMs);
}
