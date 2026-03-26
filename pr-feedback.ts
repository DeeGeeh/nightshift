/**
 * PR Feedback Discovery
 *
 * Finds open nightshift PRs that have unprocessed review comments.
 * Tracks which comments have been processed via seen-comments.json
 * so we don't re-process the same feedback.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { CONFIG } from "./config.ts";
import { sh, spawn } from "./git.ts";

export const NIGHTSHIFT_MARKER = "<!-- nightshift-bot -->";

export interface PRComment {
  id: number;
  body: string;
  author: string;
  path?: string;
  line?: number;
  createdAt: string;
}

export interface PendingFeedback {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  branch: string;
  issueIdentifier: string | null;
  comments: PRComment[];
}

// ─── Seen comment tracker ────────────────────────────────────────────

const seenComments: Set<number> = (() => {
  if (!existsSync(CONFIG.seenCommentsFile)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(CONFIG.seenCommentsFile, "utf-8")) as number[]);
  } catch { return new Set(); }
})();

function saveSeenComments() {
  writeFileSync(CONFIG.seenCommentsFile, JSON.stringify([...seenComments]));
}

export function markCommentsProcessed(ids: number[]) {
  for (const id of ids) seenComments.add(id);
  saveSeenComments();
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractIssueIdentifier(branch: string): string | null {
  if (branch.startsWith(CONFIG.branchPrefix)) {
    return branch.slice(CONFIG.branchPrefix.length).toUpperCase();
  }
  return null;
}

let _repoSlug: string | null = null;
async function getRepoSlug(): Promise<string> {
  if (!_repoSlug) {
    _repoSlug = await sh(`gh repo view --json nameWithOwner -q .nameWithOwner`);
  }
  return _repoSlug;
}

export function formatCommentForAgent(c: PRComment): string {
  const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ""}\`` : "general";
  return `- **@${c.author}** [${location}]: ${c.body}`;
}

// ─── Fetch ───────────────────────────────────────────────────────────

export async function fetchPendingFeedback(): Promise<PendingFeedback[]> {
  const slug = await getRepoSlug();

  const prsRaw = await sh(
    `gh pr list --state open --json number,title,url,headRefName --limit 50`
  );
  const prs = JSON.parse(prsRaw) as Array<{
    number: number;
    title: string;
    url: string;
    headRefName: string;
  }>;

  const nightshiftPRs = prs.filter(pr =>
    pr.headRefName.startsWith(CONFIG.branchPrefix) ||
    pr.headRefName.startsWith(CONFIG.cleanupBranchPrefix)
  );

  if (nightshiftPRs.length === 0) return [];

  const results: PendingFeedback[] = [];

  for (const pr of nightshiftPRs) {
    const comments: PRComment[] = [];

    // Inline review comments (on specific lines/files)
    try {
      const raw = await sh(
        `gh api repos/${slug}/pulls/${pr.number}/comments --paginate`
      );
      for (const c of JSON.parse(raw) as any[]) {
        if (seenComments.has(c.id)) continue;
        if (c.body?.includes(NIGHTSHIFT_MARKER)) continue;
        comments.push({
          id: c.id,
          body: c.body,
          author: c.user?.login ?? "unknown",
          path: c.path,
          line: c.line ?? c.original_line,
          createdAt: c.created_at,
        });
      }
    } catch { /* skip on error */ }

    // General PR comments (conversation thread)
    try {
      const raw = await sh(
        `gh api repos/${slug}/issues/${pr.number}/comments --paginate`
      );
      for (const c of JSON.parse(raw) as any[]) {
        if (seenComments.has(c.id)) continue;
        if (c.body?.includes(NIGHTSHIFT_MARKER)) continue;
        comments.push({
          id: c.id,
          body: c.body,
          author: c.user?.login ?? "unknown",
          createdAt: c.created_at,
        });
      }
    } catch { /* skip on error */ }

    if (comments.length > 0) {
      results.push({
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        branch: pr.headRefName,
        issueIdentifier: extractIssueIdentifier(pr.headRefName),
        comments,
      });
    }
  }

  return results;
}

// ─── Reply ───────────────────────────────────────────────────────────

export async function replyToPR(prNumber: number, body: string) {
  const fullBody = `${NIGHTSHIFT_MARKER}\n## NIGHTSHIFT\n${body}`;
  await spawn(["gh", "pr", "comment", String(prNumber), "--body", fullBody]);
}
