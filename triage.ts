import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { LinearIssue } from "./linear.ts";

export interface TriageResult {
  canAutoFix: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Quick triage via the Agent SDK using Haiku.
 * Uses your `claude login` session — no API key needed.
 * Cheap and fast: ~1 turn, minimal tokens.
 */
export async function quickTriage(issue: LinearIssue): Promise<TriageResult> {
  let output = "";

  try {
    for await (const message of query({
      prompt: `You are triaging tickets for an AI engineering team that works on a small codebase owned by a 2-person team. Tickets are often brief — that's normal and NOT a reason to reject.

Decide if this ticket can be worked on autonomously by an AI team that can read code, make changes, and open PRs.

ACCEPT (canAutoFix: true) if:
- It's a bug fix, build fix, refactor, small feature, test, docs, or similar bounded task
- Even if the description is sparse — the AI team can investigate the codebase to fill in gaps
- Even if it touches multiple files — as long as the intent is clear enough to start

REJECT (canAutoFix: false) ONLY if:
- It requires external credentials, API keys, or third-party service setup the AI can't access
- It's a massive architectural redesign with no clear direction
- It explicitly needs human decision-making (design choices, business logic decisions with no clear answer)

Ignore existing labels like 'needs-human' or 'auto-fix' — those may be stale from previous runs.

${issue.identifier}: ${issue.title}
${issue.description ?? "(no description)"}

Answer ONLY JSON: {"canAutoFix": bool, "confidence": "high"/"medium"/"low", "reason": "one sentence"}`,
      options: {
        model: "haiku",
        maxTurns: 1,
        allowedTools: [],
      } as Options,
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if ("text" in block && block.text) output += block.text;
        }
      }
    }

    // Extract JSON from output (might have preamble text)
    const jsonMatch = output.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as TriageResult;
    }
    return { canAutoFix: false, confidence: "low", reason: "No JSON in triage response" };
  } catch (err: any) {
    console.error("  Triage error:", err.message);
    return { canAutoFix: false, confidence: "low", reason: `Triage failed: ${err.message}` };
  }
}