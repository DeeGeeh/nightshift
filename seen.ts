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

const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const seen: Map<string, SeenRecord> = (() => {
  if (!existsSync(CONFIG.seenFile)) return new Map();
  try {
    const data = JSON.parse(readFileSync(CONFIG.seenFile, "utf-8")) as SeenRecord[];
    return new Map(data.map((r) => [r.id, r]));
  } catch { return new Map(); }
})();

// Prune entries older than 30 days on startup
const cutoff = Date.now() - SEEN_TTL_MS;
let pruned = 0;
for (const [id, record] of seen) {
  if (new Date(record.timestamp).getTime() < cutoff) {
    seen.delete(id);
    pruned++;
  }
}
if (pruned > 0) {
  console.log(`🧹 Pruned ${pruned} stale seen record(s)`);
  save();
}

function save() {
  writeFileSync(CONFIG.seenFile, JSON.stringify([...seen.values()], null, 2));
}

export function flushSeen() {
  save();
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
