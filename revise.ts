/**
 * PR Revision Handler
 *
 * When a human reviewer leaves comments on a nightshift PR, this module
 * checks out the branch, runs a lightweight orchestrator agent to address
 * the feedback, and pushes the result back to the same PR.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { frontendDev, backendDev, codeReviewer } from "./team.ts";
import { withContext7 } from "./mcps.ts";
import { CONFIG } from "./config.ts";
import {
  checkoutPRBranch,
  pushUpdates,
  returnToMain,
  getDiffStats,
  getCommitLog,
  sh,
} from "./git.ts";
import { runCIGate } from "./ci-gate.ts";
import type { TeamResult } from "./po.ts";
import {
  type PendingFeedback,
  formatCommentForAgent,
  markCommentsProcessed,
  replyToPR,
} from "./pr-feedback.ts";

export async function processRevision(feedback: PendingFeedback): Promise<TeamResult> {
  const tag = `[REV:#${feedback.prNumber}]`;

  try {
    await checkoutPRBranch(feedback.branch);
    const headBefore = await sh(`git rev-parse HEAD`);

    const commentsText = feedback.comments.map(formatCommentForAgent).join("\n");
    const issueTag = feedback.issueIdentifier?.toLowerCase() ?? `pr-${feedback.prNumber}`;

    const prompt = `
You are addressing review feedback on a PR created by your team.

## PR
**${feedback.prTitle}**
Branch: \`${feedback.branch}\`
URL: ${feedback.prUrl}

## Review Comments to Address
${commentsText}

## Your Team
- **frontend-dev**: React/Next.js/Tailwind — use for UI component, page, or styling changes
- **backend-dev**: monorepo/build/backend — use for non-UI changes
- **code-reviewer**: reviews the diff — must approve before we ship

## Process
1. Run \`git diff main\` to understand the current state of this PR
2. Read each review comment carefully — understand what the reviewer wants
3. Pick the right developer and delegate with SPECIFIC instructions per comment:
   - Which file(s) to change
   - What the reviewer wants
   - Reference the existing code context
4. Send to code-reviewer
5. If NEEDS_CLEANUP, send developer back (max 2 rounds)

## Important
- Commit message: "fix(${issueTag}): address review feedback"
- Only address what reviewers asked for — don't add extra changes
- If a comment is just praise/approval ("LGTM", "looks good"), skip it — no changes needed
- If a comment asks for something out of scope (new feature, major refactor), ESCALATE
- Do NOT push or create a PR — just commit

## Output
<result>
OUTCOME: [SHIPPED / ESCALATED]
SUMMARY: [what was changed per comment]
</result>

SHIPPED = feedback addressed, new commit(s) ready
ESCALATED = feedback requires human judgment
`.trim();

    let agentOutput = "";

    const runAgent = async () => {
      for await (const message of query({
        prompt,
        options: {
          model: "sonnet",
          allowedTools: ["Read", "Glob", "Grep", "Agent"],
          mcpServers: withContext7(),
          permissionMode: "bypassPermissions",
          cwd: CONFIG.repoPath,
          maxTurns: 100,
          settingSources: ["project" as const],
          agents: {
            "frontend-dev": frontendDev,
            "backend-dev": backendDev,
            "code-reviewer": codeReviewer,
          },
        } as any,
      })) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if ("text" in block && block.text) {
              agentOutput += block.text + "\n";
              if (block.text.includes("OUTCOME:") || block.text.includes("Decision:")) {
                console.log(`${tag} ${block.text.slice(0, 120)}`);
              }
            } else if ("name" in block && block.name === "Agent") {
              const sub = (block.input as any)?.subagent_type ?? (block.input as any)?.description ?? "?";
              console.log(`${tag} 📨 Delegated to: ${sub}`);
            }
          }
        }
      }
    };

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Revision timed out after ${CONFIG.agentTimeoutMs / 60_000}min`)), CONFIG.agentTimeoutMs)
    );
    await Promise.race([runAgent(), timeout]);

    // Parse outcome
    const resultMatch = agentOutput.match(/<result>([\s\S]*?)<\/result>/i);
    const resultBlock = resultMatch?.[1]?.trim() ?? "";
    const shipped = resultBlock.includes("OUTCOME: SHIPPED");

    const cleanSummary = resultBlock
      .replace(/<[^>]+>/g, "")
      .replace(/OUTCOME:\s*\w+\s*/i, "")
      .replace(/SUMMARY:\s*/i, "")
      .trim();

    const headAfter = await sh(`git rev-parse HEAD`);
    const hasNewCommits = headBefore !== headAfter;
    const commentIds = feedback.comments.map(c => c.id);

    if (shipped && hasNewCommits) {
      await pushUpdates(feedback.branch);

      // ── CI Gate ──
      const ci = await runCIGate(feedback.prNumber, feedback.branch, `fix(${issueTag})`, tag);
      if (!ci.passed) {
        console.log(`${tag} CI failing after revision — may need human review`);
      }

      const diffStats = await getDiffStats(feedback.branch);
      const commitLog = await getCommitLog(feedback.branch);

      markCommentsProcessed(commentIds);

      await replyToPR(
        feedback.prNumber,
        `🤖 Addressed review feedback:\n\n${cleanSummary.slice(0, 500)}${ci.passed ? "" : `\n\n⚠️ CI is still failing: ${ci.summary}`}`
      );

      console.log(`${tag} ${ci.passed ? "✅" : "⚠️"} Pushed revision${ci.passed ? "" : " (CI failing)"}`);
      await returnToMain();

      return {
        outcome: ci.passed ? "done" : "needs-human",
        prUrl: feedback.prUrl,
        summary: ci.passed ? cleanSummary : `CI failing: ${ci.summary}`,
        diffStats,
        commitLog,
      };
    }

    // Escalated or no new commits
    markCommentsProcessed(commentIds);

    if (!shipped) {
      await replyToPR(
        feedback.prNumber,
        `🤖 Reviewed feedback but escalating to humans — changes need human judgment.\n\n${cleanSummary.slice(0, 300)}`
      );
    } else {
      // Said SHIPPED but no commits — probably only praise/approval comments
      console.log(`${tag} No new commits (comments may not require changes)`);
    }

    await returnToMain();
    return { outcome: shipped ? "done" : "needs-human", summary: cleanSummary };

  } catch (err: any) {
    console.error(`${tag} Revision error:`, err.message);
    try { await returnToMain(); } catch { /* best effort */ }
    return { outcome: "failed", summary: err.message };
  }
}
