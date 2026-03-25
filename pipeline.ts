/**
 * Multi-agent fix pipeline.
 *
 * Each phase runs as a separate agent with:
 *   - Fresh context (no bleed from prior phases)
 *   - Only the tools it needs
 *   - Shared Context7 MCP for docs
 *   - Project skills loaded for the fixer
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { investigator, planner, fixer, reviewer } from "./agents.ts";
import { withContext7 } from "./mcps.ts";
import { CONFIG } from "./config.ts";
import type { LinearIssue } from "./linear.ts";
import { addComment, addLabelToIssue, updateIssueState } from "./linear.ts";
import { prepareBranch, branchHasCommits, pushAndCreatePR, returnToMain } from "./git.ts";
import { markSeen } from "./seen.ts";
import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";

// ─── Agent runner ────────────────────────────────────────────────────

/**
 * Runs an agent with proper MCP + skills config.
 * The `skills` flag enables loading .claude/skills/ from the project.
 */
async function runAgent(
  name: string,
  prompt: string,
  agentDef: AgentDefinition,
  opts?: { loadProjectSkills?: boolean }
): Promise<string> {
  let output = "";

  const options: Options = {
    agent: name,
    permissionMode: "bypassPermissions",
    cwd: CONFIG.repoPath,
    model: agentDef.model ?? "sonnet",
    allowedTools: agentDef.tools ?? [],
    maxTurns: agentDef.maxTurns ?? 40,
    mcpServers: withContext7(),
    // Load project settings (CLAUDE.md, skills, etc.) when requested
    ...(opts?.loadProjectSkills && { settingSources: ["project" as const] }),
  };

  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if ("text" in block && block.text) {
          output += block.text + "\n";
        }
      }
    }
  }

  return output;
}

/** Extract content between XML-style tags. */
function extractTag(output: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = output.match(regex);
  return match ? match[1].trim() : null;
}

// ─── Pipeline ────────────────────────────────────────────────────────

export async function runPipeline(issue: LinearIssue): Promise<void> {
  const tag = `[${issue.identifier}]`;
  const MAX_CLEANUP_ROUNDS = 2;

  try {
    await updateIssueState(issue.id, "in progress");
    await addComment(issue.id, "🤖 Auto-fix agent started. Running investigation...");
    markSeen(issue, "in-progress");

    const branch = await prepareBranch(issue.identifier);
    console.log(`${tag} On branch: ${branch}`);

    const issueContext =
      `Issue ${issue.identifier}: ${issue.title}\n` +
      `${issue.description ?? "(no description)"}`;

    // ── Phase 1: Investigate (read-only, has Context7) ──
    console.log(`${tag} 🔍 Phase 1: Investigating...`);

    const investigationOutput = await runAgent(
      "investigator",
      `Investigate this bug:\n\n${issueContext}`,
      investigator
    );

    const investigation = extractTag(investigationOutput, "investigation");
    if (!investigation) {
      console.log(`${tag} Investigation produced no structured output`);
      await addComment(issue.id, "🤖 Could not complete investigation. Needs human review.");
      await addLabelToIssue(issue.id, "needs-human");
      markSeen(issue, "failed");
      await returnToMain();
      return;
    }

    if (investigation.includes("CONFIDENCE: low")) {
      console.log(`${tag} Investigation confidence too low`);
      await addComment(
        issue.id,
        "🤖 Investigated but confidence is low.\n\n```\n" +
          investigation.slice(0, 800) + "\n```"
      );
      await addLabelToIssue(issue.id, "needs-human");
      markSeen(issue, "failed");
      await returnToMain();
      return;
    }

    console.log(`${tag} ✅ Investigation complete`);

    // ── Phase 2: Plan (read-only, has Context7) ──
    console.log(`${tag} 📋 Phase 2: Planning...`);

    const planOutput = await runAgent(
      "planner",
      `Create a fix plan.\n\nBug:\n${issueContext}\n\nInvestigation:\n${investigation}`,
      planner
    );

    const plan = extractTag(planOutput, "plan");
    if (!plan || planOutput.includes("ABORT")) {
      console.log(`${tag} Planner aborted or no output`);
      await addComment(
        issue.id,
        "🤖 Not suitable for auto-fix.\n\n```\n" +
          (plan ?? planOutput).slice(0, 800) + "\n```"
      );
      await addLabelToIssue(issue.id, "needs-human");
      markSeen(issue, "failed");
      await returnToMain();
      return;
    }

    console.log(`${tag} ✅ Plan complete`);

    // ── Phase 3: Fix (write access, Context7 + project skills) ──
    console.log(`${tag} 🔧 Phase 3: Implementing...`);

    const commitMsg = `fix(${issue.identifier.toLowerCase()})`;

    await runAgent(
      "fixer",
      `Implement this fix. Commit with prefix "${commitMsg}".\n\nPlan:\n${plan}`,
      fixer,
      { loadProjectSkills: true }  // loads .claude/skills/ (typescript, react, etc.)
    );

    if (!(await branchHasCommits(branch))) {
      console.log(`${tag} No commits produced`);
      await addComment(issue.id, "🤖 Fix agent ran but produced no changes.");
      await addLabelToIssue(issue.id, "needs-human");
      markSeen(issue, "failed");
      await returnToMain();
      return;
    }

    console.log(`${tag} ✅ Fix committed`);

    // ── Phase 4: Review (read-only, Context7 for API verification) ──
    let approved = false;

    for (let round = 0; round <= MAX_CLEANUP_ROUNDS; round++) {
      const phase = round === 0 ? "Reviewing" : `Cleanup round ${round}`;
      console.log(`${tag} 🔎 Phase 4: ${phase}...`);

      const reviewOutput = await runAgent(
        "reviewer",
        `Review the changes.\n\nOriginal issue:\n${issueContext}\n\nPlan:\n${plan}`,
        reviewer
      );

      const review = extractTag(reviewOutput, "review");
      if (!review) {
        console.log(`${tag} No structured review output, assuming OK`);
        approved = true;
        break;
      }

      if (review.includes("VERDICT: APPROVE")) {
        console.log(`${tag} ✅ Review passed`);
        approved = true;
        break;
      }

      if (review.includes("VERDICT: REJECT")) {
        console.log(`${tag} ❌ Review rejected`);
        await addComment(
          issue.id,
          "🤖 Fix failed code review.\n\n```\n" + review.slice(0, 800) + "\n```"
        );
        await addLabelToIssue(issue.id, "needs-human");
        markSeen(issue, "failed");
        await returnToMain();
        return;
      }

      if (review.includes("VERDICT: NEEDS_CLEANUP") && round < MAX_CLEANUP_ROUNDS) {
        const cleanup = review.split("CLEANUP:")[1]?.split("SUMMARY:")[0]?.trim();
        if (cleanup) {
          console.log(`${tag} 🧹 Cleanup needed...`);
          await runAgent(
            "fixer",
            `Apply ONLY these cleanups, then amend the commit:\n\n${cleanup}\n\n` +
              `Run: git add -A && git commit --amend --no-edit`,
            fixer,
            { loadProjectSkills: true }
          );
        }
      }
    }

    if (!approved) {
      console.log(`${tag} Review loop exhausted`);
      await addComment(issue.id, "🤖 Couldn't pass review after cleanup. Needs human.");
      await addLabelToIssue(issue.id, "needs-human");
      markSeen(issue, "failed");
      await returnToMain();
      return;
    }

    // ── Phase 5: Push & PR ──
    console.log(`${tag} 🚀 Pushing...`);

    try {
      const prUrl = await pushAndCreatePR(branch, issue);
      console.log(`${tag} ✅ PR: ${prUrl}`);
      await addComment(issue.id, `✅ Auto-fix PR: ${prUrl}\n\nPlease review and merge.`);
      await updateIssueState(issue.id, "in review");
      markSeen(issue, "done");
    } catch (err: any) {
      console.error(`${tag} PR failed:`, err.message);
      await addComment(issue.id, `⚠️ Fix on \`${branch}\` but PR failed:\n\`\`\`\n${err.message}\n\`\`\``);
      markSeen(issue, "done");
    }

    await returnToMain();

  } catch (err: any) {
    console.error(`${tag} Pipeline error:`, err.message);
    await addComment(issue.id, `❌ Pipeline failed:\n\`\`\`\n${err.message}\n\`\`\``);
    await addLabelToIssue(issue.id, "needs-human");
    markSeen(issue, "failed");
    try { await returnToMain(); } catch { /* best effort */ }
  }
}
