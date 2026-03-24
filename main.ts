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
import { fetchNewIssues, addLabelToIssue } from "./linear.ts";
import { hasSeen, markSeen, seenCount } from "./seen.ts";
import { quickTriage } from "./triage.ts";
import { assignToTeam } from "./po.ts";

const activeIssues = new Set<string>();

// ─── Schedule ────────────────────────────────────────────────────────

/**
 * Is it currently within the work shift?
 * Handles overnight ranges like 18:00–05:00 (start > stop = crosses midnight).
 */
function isOnShift(): boolean {
  const now = new Date();
  const hour = now.getHours();
  const { shiftStart, shiftStop } = CONFIG;

  if (shiftStart < shiftStop) {
    // Same-day range, e.g. 09:00–17:00
    return hour >= shiftStart && hour < shiftStop;
  } else {
    // Overnight range, e.g. 18:00–05:00
    return hour >= shiftStart || hour < shiftStop;
  }
}

function nextShiftStart(): Date {
  const now = new Date();
  const target = new Date(now);
  target.setHours(CONFIG.shiftStart, 0, 0, 0);

  // If we're past today's shift start, next one is tomorrow
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

// ─── Poll ────────────────────────────────────────────────────────────

async function poll() {
  // Don't start new work outside shift hours
  if (!isOnShift()) return;

  // Don't pick up new tickets if we're close to shift end
  // (give active work time to finish — 30 min buffer)
  const now = new Date();
  const stopToday = new Date(now);
  stopToday.setHours(CONFIG.shiftStop, 0, 0, 0);
  if (CONFIG.shiftStart > CONFIG.shiftStop) {
    // Overnight: if it's past midnight, stop time is today
    // If before midnight, stop time is tomorrow
    if (now.getHours() >= CONFIG.shiftStart) {
      stopToday.setDate(stopToday.getDate() + 1);
    }
  }
  const msUntilStop = stopToday.getTime() - now.getTime();
  if (msUntilStop > 0 && msUntilStop < 30 * 60_000) {
    if (activeIssues.size > 0) {
      console.log(`⏰ Shift ending in ${formatDuration(msUntilStop)}, waiting for active work to finish...`);
    } else {
      console.log(`⏰ Shift ending in ${formatDuration(msUntilStop)}, not picking up new tickets.`);
    }
    return;
  }

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

      activeIssues.add(issue.id);
      console.log(`${tag} 📨 Assigning to AI engineering team...`);

      assignToTeam(issue)
        .catch((err: any) => console.error(`${tag} Unhandled:`, err))
        .finally(() => activeIssues.delete(issue.id));
    }
  } catch (err: any) {
    console.error("Poll error:", err.message);
  }
}

// ─── Main loop with shift awareness ─────────────────────────────────

let wasOffShift = false;

function tick() {
  if (isOnShift()) {
    if (wasOffShift) {
      console.log(`\n🌙 Shift started at ${formatTime(new Date())}. Nightshift is active.\n`);
      wasOffShift = false;
    }
    poll();
  } else {
    if (!wasOffShift) {
      const next = nextShiftStart();
      const until = formatDuration(next.getTime() - Date.now());
      console.log(`\n☀️  Off shift. Sleeping until ${formatTime(next)} (${until}). Your quota is recovering.\n`);
      wasOffShift = true;
    }
    // Still check once per tick in case active work is finishing
  }
}

// ─── Startup ─────────────────────────────────────────────────────────

const shiftLabel = CONFIG.shiftStart > CONFIG.shiftStop
  ? `${CONFIG.shiftStart}:00 → ${String(CONFIG.shiftStop).padStart(2, "0")}:00 (overnight)`
  : `${CONFIG.shiftStart}:00 → ${CONFIG.shiftStop}:00`;

console.log(`
╔═══════════════════════════════════════════════╗
║          🌙 N I G H T S H I F T 🌙           ║
║       AI engineering team that never sleeps    ║
║          (well, it sleeps during the day)      ║
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
║  Schedule: ${shiftLabel.padEnd(36)} ║
║  Repo:     ${CONFIG.repoPath.slice(-33).padEnd(33)} ║
║  Team:     ${(CONFIG.teamKey ?? "all").padEnd(33)} ║
║  Poll:     ${(CONFIG.pollIntervalMs / 1000 + "s").padEnd(33)} ║
║  Dry run:  ${String(CONFIG.dryRun).padEnd(33)} ║
║  Tracked:  ${(seenCount() + " issues").padEnd(33)} ║
║  Auth:     ${"claude login session (Max)".padEnd(33)} ║
╚═══════════════════════════════════════════════╝
`);

if (isOnShift()) {
  console.log(`🌙 Currently on shift. Working.\n`);
} else {
  const next = nextShiftStart();
  console.log(`☀️  Currently off shift. Next shift: ${formatTime(next)} (${formatDuration(next.getTime() - Date.now())})\n`);
}

tick();
setInterval(tick, CONFIG.pollIntervalMs);