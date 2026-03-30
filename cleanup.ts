/**
 * Code Cleanup Mode
 *
 * Runs during idle time (no tickets, no active work) to find DRY
 * violations and extract shared utilities. Keeps PRs small — one
 * refactor per run, always reviewed before shipping.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { cleanupDev, codeReviewer } from "./team.ts";
import { withContext7 } from "./mcps.ts";
import { CONFIG } from "./config.ts";
import {
  prepareBranch,
  branchHasCommits,
  pushCleanupPR,
  returnToMain,
  getDiffStats,
  getCommitLog,
} from "./git.ts";
import { runCIGate, extractPRNumber } from "./ci-gate.ts";
import type { TeamResult } from "./po.ts";

export async function runCodeCleanup(): Promise<TeamResult> {
  const timestamp = Date.now().toString(36);
  const branchName = `dry-${timestamp}`;

  try {
    const branch = await prepareBranch(branchName, CONFIG.cleanupBranchPrefix);
    console.log(`[CLEANUP] Branch: ${branch}`);

    const prompt = `
You are the lead of a code cleanup session. Your goal is to find ONE good DRY refactor in this codebase and ship it.

## Your Team
- **cleanup-dev**: Scans for duplicated code and extracts shared utilities. Send them to work first.
- **code-reviewer**: Reviews the diff. Must approve before we ship.

## Workflow
1. Delegate to **cleanup-dev** with instructions to scan the codebase and find the best DRY refactor.
2. Read their result.
   - If SKIPPED → we're done, output SKIPPED.
   - If SHIPPED → send to **code-reviewer**.
3. Read the review.
   - APPROVE → output SHIPPED.
   - NEEDS_CLEANUP → send cleanup-dev back with the feedback. Max 1 retry, then re-review.
   - REJECT → output SKIPPED (don't force it).

## Output
When done, output exactly:

<result>
OUTCOME: [SHIPPED / SKIPPED]
SUMMARY: [What was refactored, or why we skipped]
</result>
`.trim();

    let agentOutput = "";
    let outcome: "SHIPPED" | "SKIPPED" | "UNKNOWN" = "UNKNOWN";

    const runAgent = async () => {
      for await (const message of query({
        prompt,
        options: {
          model: "sonnet",
          allowedTools: [
            "Read", "Glob", "Grep", "Agent",
          ],
          mcpServers: withContext7(),
          permissionMode: "bypassPermissions",
          cwd: CONFIG.repoPath,
          maxTurns: 80,
          settingSources: ["project" as const],
          agents: {
            "cleanup-dev": cleanupDev,
            "code-reviewer": codeReviewer,
          },
        } as any,
      })) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if ("text" in block && block.text) {
              agentOutput += block.text + "\n";
              if (block.text.includes("OUTCOME:") || block.text.includes("Decision:")) {
                console.log(`[CLEANUP] ${block.text.slice(0, 120)}`);
              }
            } else if ("name" in block && block.name === "Agent") {
              const sub = (block.input as any)?.subagent_type ?? (block.input as any)?.description ?? "?";
              console.log(`[CLEANUP] Delegated to: ${sub}`);
            }
          }
        }
      }
    };

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Cleanup timed out after ${CONFIG.agentTimeoutMs / 60_000}min`)), CONFIG.agentTimeoutMs)
    );
    await Promise.race([runAgent(), timeout]);

    // Parse outcome
    const resultMatch = agentOutput.match(/<result>([\s\S]*?)<\/result>/i);
    const resultBlock = resultMatch?.[1]?.trim() ?? "";
    if (resultBlock.includes("OUTCOME: SHIPPED")) outcome = "SHIPPED";
    else if (resultBlock.includes("OUTCOME: SKIPPED")) outcome = "SKIPPED";

    const cleanSummary = resultBlock
      .replace(/<[^>]+>/g, "")
      .replace(/OUTCOME:\s*\w+\s*/i, "")
      .replace(/SUMMARY:\s*/i, "")
      .replace(/LINES_SAVED:\s*\d+\s*/i, "")
      .trim();

    if (outcome === "SHIPPED" && (await branchHasCommits(branch))) {
      try {
        const pr = await pushCleanupPR(branch);
        console.log(`[CLEANUP] PR: ${pr.prUrl}`);

        // ── CI Gate ──
        let ciPassed = true;
        const prNumber = extractPRNumber(pr.prUrl);
        if (prNumber) {
          const ci = await runCIGate(prNumber, branch, "refactor", "[CLEANUP]");
          ciPassed = ci.passed;
          if (!ciPassed) {
            console.log(`[CLEANUP] CI failing — PR needs human review`);
          }
        }

        const finalDiffStats = await getDiffStats(branch);
        const finalCommitLog = await getCommitLog(branch);
        await returnToMain();
        return {
          outcome: ciPassed ? "done" : "failed",
          prUrl: pr.prUrl,
          summary: ciPassed ? cleanSummary : `CI failing — ${cleanSummary}`,
          diffStats: finalDiffStats,
          commitLog: finalCommitLog,
        };
      } catch (err: any) {
        console.error(`[CLEANUP] PR failed:`, err.message);
        await returnToMain();
        return { outcome: "failed", summary: `PR creation failed: ${err.message}` };
      }
    }

    // Nothing shipped or skipped
    console.log(`[CLEANUP] ${outcome === "SKIPPED" ? "No duplication worth extracting" : "No clear outcome"}`);
    await returnToMain();
    return { outcome: "skipped" as any, summary: cleanSummary || "No duplication found" };

  } catch (err: any) {
    console.error(`[CLEANUP] Error:`, err.message);
    try { await returnToMain(); } catch { /* best effort */ }
    return { outcome: "failed", summary: err.message };
  }
}
