/**
 * CI Gate
 *
 * After pushing a PR, waits for CI checks to complete. If they fail,
 * runs a fix agent to address the failures, pushes, and re-checks.
 * Repeats up to maxCIRetries times before giving up.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.ts";
import { sh, pushUpdates } from "./git.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface CICheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CIResult {
  allPassed: boolean;
  noChecks: boolean;
  checks: CICheck[];
  failureSummary: string;
}

export interface CIGateResult {
  passed: boolean;
  fixAttempts: number;
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function extractPRNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

async function fetchChecks(prNumber: number): Promise<CICheck[]> {
  try {
    const raw = await sh(`gh pr view ${prNumber} --json statusCheckRollup`);
    const data = JSON.parse(raw);
    return (data.statusCheckRollup ?? []).map((c: any) => ({
      name: c.name ?? c.context ?? "unknown",
      status: (c.status ?? "UNKNOWN").toUpperCase(),
      conclusion: c.conclusion ? c.conclusion.toUpperCase() : null,
    }));
  } catch {
    return [];
  }
}

function isCompleted(check: CICheck): boolean {
  if (check.conclusion) return true;
  const s = check.status;
  return s === "COMPLETED" || s === "SUCCESS" || s === "FAILURE" || s === "ERROR" || s === "NEUTRAL";
}

// ─── Wait for CI ─────────────────────────────────────────────────────

export async function waitForCI(
  prNumber: number,
  timeoutMs: number = CONFIG.ciTimeoutMs,
): Promise<CIResult> {
  const startTime = Date.now();
  const appearedDeadline = startTime + 2 * 60_000; // 2 min for checks to appear
  const completionDeadline = startTime + timeoutMs;

  while (Date.now() < completionDeadline) {
    const checks = await fetchChecks(prNumber);

    if (checks.length === 0) {
      if (Date.now() > appearedDeadline) {
        // No checks after 2 minutes — no CI configured
        return { allPassed: true, noChecks: true, checks: [], failureSummary: "" };
      }
      await new Promise(r => setTimeout(r, 15_000));
      continue;
    }

    const pending = checks.some(c => !isCompleted(c));
    if (!pending) {
      const failed = checks.filter(c =>
        c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "ERROR"
      );
      return {
        allPassed: failed.length === 0,
        noChecks: false,
        checks,
        failureSummary: failed.map(c => `- ${c.name}: ${c.conclusion}`).join("\n"),
      };
    }

    await new Promise(r => setTimeout(r, 30_000));
  }

  return {
    allPassed: false,
    noChecks: false,
    checks: [],
    failureSummary: "CI checks did not complete within timeout",
  };
}

// ─── Find existing PRs with failing CI ───────────────────────────────

export interface FailingPR {
  prNumber: number;
  branch: string;
  prUrl: string;
}

export async function findPRsWithFailingCI(): Promise<FailingPR[]> {
  try {
    const prsRaw = await sh(
      `gh pr list --state open --json number,url,headRefName --limit 50`
    );
    const prs = JSON.parse(prsRaw) as Array<{
      number: number;
      url: string;
      headRefName: string;
    }>;

    const nightshiftPRs = prs.filter(pr =>
      pr.headRefName.startsWith(CONFIG.branchPrefix) ||
      pr.headRefName.startsWith(CONFIG.cleanupBranchPrefix)
    );

    const failing: FailingPR[] = [];

    for (const pr of nightshiftPRs) {
      const checks = await fetchChecks(pr.number);
      if (checks.length === 0) continue;

      const allCompleted = checks.every(c => isCompleted(c));
      const hasFailure = checks.some(c =>
        c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "ERROR"
      );

      if (allCompleted && hasFailure) {
        failing.push({ prNumber: pr.number, branch: pr.headRefName, prUrl: pr.url });
      }
    }

    return failing;
  } catch {
    return [];
  }
}

// ─── CI Failure Logs ─────────────────────────────────────────────────

async function getCIFailureLogs(branch: string): Promise<string> {
  try {
    const runsRaw = await sh(
      `gh run list --branch ${branch} --status failure --limit 1 --json databaseId`
    );
    const runs = JSON.parse(runsRaw);
    if (runs.length === 0) return "";

    const runId = runs[0].databaseId;
    return await sh(`gh run view ${runId} --log-failed 2>&1 | tail -200`).catch(() => "");
  } catch {
    return "";
  }
}

// ─── CI Fix Agent ────────────────────────────────────────────────────

async function attemptCIFix(
  failureSummary: string,
  logs: string,
  commitPrefix: string,
) {
  const prompt = `
You are fixing CI failures on a PR branch.

## Failed Checks
${failureSummary}

## CI Logs
\`\`\`
${logs.slice(-3000) || "(no logs available — run the commands locally to reproduce)"}
\`\`\`

## Instructions
1. Read the CI configuration (.github/workflows/, package.json scripts, etc.) to understand what's being run
2. Run the failing commands locally to reproduce the errors
3. Read the error output carefully — fix the ROOT CAUSE, not the symptoms
4. Re-run to verify your fix works
5. Stage and commit: "${commitPrefix}: fix CI failures"

## Rules
- Only fix what CI is complaining about
- Do NOT change tests to make them pass unless the test itself has a bug — fix the code under test
- Do NOT add new features, refactor, or "improve" anything
- Do NOT skip or disable failing tests
- If you truly cannot fix the issue, just stop — do not make random changes
`.trim();

  for await (const message of query({
    prompt,
    options: {
      model: "sonnet",
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      cwd: CONFIG.repoPath,
      maxTurns: 30,
      settingSources: ["project" as const],
    } as any,
  })) {
    // Let it run — we check for commits afterward
  }
}

// ─── CI Gate (full loop) ─────────────────────────────────────────────

/**
 * Wait for CI checks, fix failures if possible, retry up to maxCIRetries.
 */
export async function runCIGate(
  prNumber: number,
  branch: string,
  commitPrefix: string,
  tag: string,
): Promise<CIGateResult> {
  console.log(`${tag} ⏳ Waiting for CI checks...`);
  let ci = await waitForCI(prNumber);
  let fixAttempts = 0;

  if (ci.noChecks) {
    console.log(`${tag} No CI checks configured — skipping gate`);
    return { passed: true, fixAttempts: 0, summary: "No CI checks" };
  }

  if (ci.allPassed) {
    console.log(`${tag} ✅ CI passed`);
    return { passed: true, fixAttempts: 0, summary: "All checks passed" };
  }

  // CI failed — attempt fixes
  while (!ci.allPassed && fixAttempts < CONFIG.maxCIRetries) {
    fixAttempts++;
    console.log(`${tag} ❌ CI failed — fix attempt ${fixAttempts}/${CONFIG.maxCIRetries}`);
    console.log(`${tag} Failed checks:\n${ci.failureSummary}`);

    const logs = await getCIFailureLogs(branch);
    const headBefore = await sh(`git rev-parse HEAD`);

    await attemptCIFix(ci.failureSummary, logs, commitPrefix);

    const headAfter = await sh(`git rev-parse HEAD`);
    if (headBefore === headAfter) {
      console.log(`${tag} Fix agent made no changes — giving up`);
      break;
    }

    await pushUpdates(branch);
    console.log(`${tag} ⏳ Re-checking CI...`);
    ci = await waitForCI(prNumber);
  }

  if (ci.allPassed) {
    console.log(`${tag} ✅ CI passed after ${fixAttempts} fix(es)`);
    return { passed: true, fixAttempts, summary: `Passed after ${fixAttempts} fix(es)` };
  }

  console.log(`${tag} ❌ CI still failing after ${fixAttempts} attempt(s)`);
  return { passed: false, fixAttempts, summary: `CI failing:\n${ci.failureSummary}` };
}
