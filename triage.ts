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
      prompt: `Is this software ticket suitable for an AI team to fix autonomously?

${issue.identifier}: ${issue.title}
${issue.description ?? "(none)"}
Labels: ${issue.labels.nodes.map(l => l.name).join(", ") || "none"}

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