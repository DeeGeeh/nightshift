import { readFileSync, writeFileSync, existsSync } from "fs";
import { CONFIG } from "./config.ts";
import type { LinearIssue } from "./linear.ts";

export type Verdict = "auto-fix" | "needs-human" | "in-progress" | "done" | "failed";

interface SeenRecord {
  id: string;
  identifier: string;
  verdict: Verdict;
  timestamp: string;
}

const seen: Map<string, SeenRecord> = (() => {
  if (!existsSync(CONFIG.seenFile)) return new Map();
  try {
    const data = JSON.parse(readFileSync(CONFIG.seenFile, "utf-8")) as SeenRecord[];
    return new Map(data.map((r) => [r.id, r]));
  } catch { return new Map(); }
})();

function save() {
  writeFileSync(CONFIG.seenFile, JSON.stringify([...seen.values()], null, 2));
}

export function hasSeen(id: string): boolean { return seen.has(id); }

export function markSeen(issue: LinearIssue, verdict: Verdict) {
  seen.set(issue.id, {
    id: issue.id,
    identifier: issue.identifier,
    verdict,
    timestamp: new Date().toISOString(),
  });
  save();
}

export function seenCount(): number { return seen.size; }
