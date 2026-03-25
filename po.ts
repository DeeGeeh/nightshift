/**
 * Product Owner Agent
 *
 * The PO is the orchestrator — the main agent that receives a ticket
 * and manages the team. It's not a hardcoded pipeline. The PO:
 *
 *   1. Reads the ticket
 *   2. Delegates to triage-analyst → decides if worth pursuing
 *   3. Delegates to senior-engineer → gets investigation
 *   4. Reads investigation, decides if team can handle it
 *   5. Delegates to tech-lead → gets a plan
 *   6. Reads plan, decides if it's sound
 *   7. Delegates to developer → gets implementation
 *   8. Delegates to code-reviewer → gets review
 *   9. If cleanup needed, sends developer back with feedback
 *  10. Decides if ready to ship
 *
 * The PO makes a DECISION after each step. It can bail out at any point,
 * escalate to humans, ask for more investigation, reject a plan, etc.
 * This is what makes it a team, not a pipeline.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  triageAnalyst,
  seniorEngineer,
  techLead,
  frontendDev,
  backendDev,
  polishDev,
  codeReviewer,
} from "./team.ts";
import { withContext7 } from "./mcps.ts";
import { CONFIG } from "./config.ts";
import type { LinearIssue } from "./linear.ts";
import { addComment, addLabelToIssue, updateIssueState } from "./linear.ts";
import { prepareBranch, branchHasCommits, pushAndCreatePR, returnToMain } from "./git.ts";
import { markSeen } from "./seen.ts";

/**
 * Hand a ticket to the Product Owner and let it run the team.
 */
export async function assignToTeam(issue: LinearIssue): Promise<void> {
  const tag = `[${issue.identifier}]`;

  try {
    await updateIssueState(issue.id, "in progress");
    await addComment(issue.id, "🤖 AI engineering team picked up this ticket.");
    markSeen(issue, "in-progress");

    const branch = await prepareBranch(issue.identifier);
    console.log(`${tag} Branch: ${branch}`);

    // ── Launch the Product Owner ──
    // The PO is the main agent. It has access to all team members as subagents.
    // It reads the ticket, delegates work, evaluates results, and decides next steps.

    const poPrompt = `
You are the Product Owner of a small AI engineering team. You just received a ticket from the backlog.

## Ticket
**${issue.identifier}: ${issue.title}**
${issue.description ?? "(no description provided)"}
URL: ${issue.url}

## Your Team
You have these team members available as subagents:

- **triage-analyst**: Quick assessment — is this ticket suitable for our team to handle autonomously? Always start here.
- **senior-engineer**: Deep investigation — searches the codebase, reads docs, identifies root cause. Read-only.
- **tech-lead**: Creates a precise implementation plan from the investigation. Read-only.
- **frontend-dev**: Implements frontend fixes — React components, Next.js pages/routes, Tailwind styling, UI logic. Expert in App Router, Server Components, modern React.
- **backend-dev**: Implements backend/infra fixes — monorepo config, build tooling, API routes, server logic, CI/CD. Expert in Turborepo and backend patterns.
- **polish-dev**: UI polish and cleanup — alignment, spacing, consistency, visual micro-details. Use after the main fix for a quality pass (optional).
- **code-reviewer**: Reviews the git diff for quality. Strict — must pass before shipping.

## How You Work

You manage this ticket through its lifecycle by delegating to the right people at the right time. After each delegation, you READ the result and DECIDE what to do next.

Your workflow (adapt as needed — you're the PO, use judgment):

1. **Triage**: Send the ticket to triage-analyst. If not suitable, STOP and say so.
2. **Investigate**: Send to senior-engineer with the ticket details. Read their report.
   - If confidence is low or complexity is high, STOP — this needs a human.
   - If you need more info, you can send them back with specific questions.
3. **Plan**: Send investigation to tech-lead. Read their plan.
   - If the plan seems risky or too broad, STOP.
   - If you want changes to the plan, tell the tech-lead what to adjust.
4. **Implement**: Pick the right developer based on the investigation:
   - **frontend-dev** for UI components, pages, styling, client/server component issues.
   - **backend-dev** for build config, monorepo, API routes, server logic.
   - When in doubt, check which files are affected — if they're in \`app/\`, \`components/\`, or have JSX/TSX, use frontend-dev.
   - If they report problems, decide: retry with adjusted instructions, or escalate.
   - Optionally send to **polish-dev** after the main fix for a visual quality pass.
5. **Review**: Send to code-reviewer. Read their verdict.
   - APPROVE → you're done, report success.
   - NEEDS_CLEANUP → send cleanup instructions back to developer, then re-review. Max 2 rounds.
   - REJECT → either try a different approach or escalate to humans.

## Decision Making

After each step, think out loud about:
- What did we learn?
- Are we on track or should we stop?
- What's the right next step?

You're empowered to:
- Skip steps if the ticket is trivial enough
- Go back to a previous step if new info changes things
- Stop at any point and escalate to humans
- Ask a team member to redo their work with different instructions

## Output

When you're done (success or not), output exactly:

<result>
OUTCOME: [SHIPPED / ESCALATED / ABANDONED]
SUMMARY: [2-3 sentences of what happened]
</result>

SHIPPED = fix committed, ready for PR.
ESCALATED = too complex or risky, needs human.
ABANDONED = not worth fixing or not a real bug.

## Important
- The commit message must be: "fix(${issue.identifier.toLowerCase()}): <description>"
- Do NOT push or create a PR — that happens after you're done.
- Quality matters more than speed. If unsure, escalate.
`.trim();

    let poOutput = "";
    let outcome: "SHIPPED" | "ESCALATED" | "ABANDONED" | "UNKNOWN" = "UNKNOWN";

    for await (const message of query({
      prompt: poPrompt,
      options: {
        model: "sonnet",
        allowedTools: [
          "Read", "Glob", "Grep", "Agent",  // PO can read code + delegate
          "mcp__context7__resolve-library-id",
          "mcp__context7__get-library-docs",
        ],
        mcpServers: withContext7(),
        permissionMode: "bypassPermissions",
        cwd: CONFIG.repoPath,
        maxTurns: 200,  // PO needs room — it's running a whole team
        settingSources: ["project" as const],  // load CLAUDE.md, skills

        // ── The Team ──
        agents: {
          "triage-analyst": triageAnalyst,
          "senior-engineer": seniorEngineer,
          "tech-lead": techLead,
          "frontend-dev": frontendDev,
          "backend-dev": backendDev,
          "polish-dev": polishDev,
          "code-reviewer": codeReviewer,
        },
      } as any,
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            poOutput += block.text + "\n";
            // Log PO's thinking in real-time
            if (block.text.includes("OUTCOME:") || block.text.includes("→") || block.text.includes("Decision:")) {
              console.log(`${tag} PO: ${block.text.slice(0, 120)}`);
            }
          } else if ("name" in block && block.name === "Agent") {
            const sub = (block.input as any)?.subagent_type ?? (block.input as any)?.description ?? "?";
            console.log(`${tag} 📨 PO delegated to: ${sub}`);
          }
        }
      }
    }

    // ── Parse outcome ──
    if (poOutput.includes("OUTCOME: SHIPPED")) outcome = "SHIPPED";
    else if (poOutput.includes("OUTCOME: ESCALATED")) outcome = "ESCALATED";
    else if (poOutput.includes("OUTCOME: ABANDONED")) outcome = "ABANDONED";

    // ── Extract summary ──
    const resultMatch = poOutput.match(/<result>([\s\S]*?)<\/result>/i);
    const summary = resultMatch?.[1]?.trim() ?? poOutput.slice(-500);

    // ── Act on outcome ──
    switch (outcome) {
      case "SHIPPED": {
        if (!(await branchHasCommits(branch))) {
          console.log(`${tag} PO said SHIPPED but no commits found`);
          await addComment(issue.id, "🤖 Team attempted a fix but no changes were committed.");
          await addLabelToIssue(issue.id, "needs-human");
          markSeen(issue, "failed");
          break;
        }

        try {
          const prUrl = await pushAndCreatePR(branch, issue);
          console.log(`${tag} ✅ PR: ${prUrl}`);
          await addComment(
            issue.id,
            `✅ AI team shipped a fix: ${prUrl}\n\n${summary.replace(/<[^>]+>/g, "").slice(0, 500)}`
          );
          await updateIssueState(issue.id, "in review");
          await addLabelToIssue(issue.id, "auto-fix");
          markSeen(issue, "done");
        } catch (err: any) {
          console.error(`${tag} PR failed:`, err.message);
          await addComment(issue.id, `⚠️ Fix on \`${branch}\` but PR failed:\n\`\`\`\n${err.message}\n\`\`\``);
          markSeen(issue, "done");
        }
        break;
      }

      case "ESCALATED": {
        console.log(`${tag} ⬆️ Escalated to humans`);
        await addComment(
          issue.id,
          `🤖 AI team investigated but is escalating to humans.\n\n${summary.replace(/<[^>]+>/g, "").slice(0, 500)}`
        );
        await addLabelToIssue(issue.id, "needs-human");
        markSeen(issue, "failed");
        break;
      }

      case "ABANDONED": {
        console.log(`${tag} 🗑️ Abandoned`);
        await addComment(
          issue.id,
          `🤖 AI team assessed this ticket and decided not to pursue it.\n\n${summary.replace(/<[^>]+>/g, "").slice(0, 500)}`
        );
        await addLabelToIssue(issue.id, "needs-human");
        markSeen(issue, "failed");
        break;
      }

      default: {
        console.log(`${tag} ❓ PO finished without clear outcome`);
        await addComment(issue.id, "🤖 AI team session ended without a clear result. Needs human review.");
        await addLabelToIssue(issue.id, "needs-human");
        markSeen(issue, "failed");
      }
    }

    await returnToMain();

  } catch (err: any) {
    console.error(`${tag} Team error:`, err.message);
    await addComment(issue.id, `❌ AI team failed:\n\`\`\`\n${err.message}\n\`\`\``);
    await addLabelToIssue(issue.id, "needs-human");
    markSeen(issue, "failed");
    try { await returnToMain(); } catch { /* best effort */ }
  }
}
