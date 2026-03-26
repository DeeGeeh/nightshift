import { CONFIG } from "./config.ts";
import type { LinearIssue } from "./linear.ts";

const GIT_AUTHOR = {
  GIT_AUTHOR_NAME: "Nightshift",
  GIT_AUTHOR_EMAIL: "nightshift-bot@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Nightshift",
  GIT_COMMITTER_EMAIL: "nightshift-bot@users.noreply.github.com",
};

const GIT_ENV = { ...process.env, ...GIT_AUTHOR };

export async function sh(cmd: string, cwd: string = CONFIG.repoPath): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Command failed (${code}): ${cmd}\n${err}`);
  return out.trim();
}

/** Spawn with argument array — no shell interpretation, safe from injection */
export async function spawn(args: string[], cwd: string = CONFIG.repoPath): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Command failed (${code}): ${args.join(" ")}\n${err}`);
  return out.trim();
}

export async function cleanWorkingTree() {
  await sh("git reset HEAD -- . 2>/dev/null || true");
  await sh("git checkout -- . 2>/dev/null || true");
  await sh("git clean -fd 2>/dev/null || true");
}

export async function prepareBranch(identifier: string, prefix?: string): Promise<string> {
  const base = CONFIG.defaultBranch;
  const branch = `${prefix ?? CONFIG.branchPrefix}${identifier.toLowerCase()}`;
  await cleanWorkingTree();
  await sh(`git checkout ${base}`);
  await sh(`git fetch origin ${base}`);
  await sh(`git reset --hard origin/${base}`);
  try { await sh(`git branch -D ${branch}`); } catch { /* fine */ }
  await sh(`git checkout -b ${branch}`);
  return branch;
}

export async function branchHasCommits(branch: string): Promise<boolean> {
  try {
    const log = await sh(`git log ${CONFIG.defaultBranch}..${branch} --oneline`);
    return log.length > 0;
  } catch { return false; }
}

export async function getDiffStats(branch: string): Promise<string> {
  try {
    return await sh(`git diff --stat ${CONFIG.defaultBranch}..${branch}`);
  } catch { return ""; }
}

export async function getCommitLog(branch: string): Promise<string> {
  try {
    return await sh(`git log ${CONFIG.defaultBranch}..${branch} --pretty=format:"- %s"`);
  } catch { return ""; }
}

export interface PRResult {
  prUrl: string;
  diffStats: string;
  commitLog: string;
}

export async function pushAndCreatePR(branch: string, issue: LinearIssue): Promise<PRResult> {
  await sh(`git push -u origin ${branch}`);

  const diffStats = await getDiffStats(branch);
  const commitLog = await getCommitLog(branch);

  const prTitle = `fix: ${issue.identifier} - ${issue.title}`;
  const prBody = [
    `## Summary`,
    `Automated fix for [${issue.identifier}](${issue.url})`,
    "",
    `**Issue:** ${issue.title}`,
    issue.description ? `\n**Description:**\n${issue.description}` : "",
    "",
    `## Changes`,
    commitLog || "_No commit messages found_",
    "",
    `## Files Changed`,
    "```",
    diffStats || "_No diff stats available_",
    "```",
    "",
    "---",
    "_This PR was created by the [Nightshift](https://github.com) AI engineering team._",
    "_Please review before merging._",
  ].join("\n");

  const prUrl = await spawn([
    "gh", "pr", "create",
    "--title", prTitle,
    "--body", prBody,
    "--base", CONFIG.defaultBranch,
    "--head", branch,
  ]);

  return { prUrl, diffStats, commitLog };
}

export async function pushCleanupPR(branch: string): Promise<PRResult> {
  await sh(`git push -u origin ${branch}`);

  const diffStats = await getDiffStats(branch);
  const commitLog = await getCommitLog(branch);

  // Extract a title from the first commit message
  const firstCommit = commitLog.split("\n")[0]?.replace(/^- /, "") ?? "DRY refactor";

  const prTitle = `refactor: ${firstCommit}`;
  const prBody = [
    `## Summary`,
    `Automated DRY cleanup by Nightshift during idle time.`,
    "",
    `## Changes`,
    commitLog || "_No commit messages found_",
    "",
    `## Files Changed`,
    "```",
    diffStats || "_No diff stats available_",
    "```",
    "",
    "---",
    "_This is an automated code cleanup PR. Duplicated code was extracted into a shared utility._",
    "_Please review before merging._",
  ].join("\n");

  const prUrl = await spawn([
    "gh", "pr", "create",
    "--title", prTitle,
    "--body", prBody,
    "--base", CONFIG.defaultBranch,
    "--head", branch,
  ]);

  return { prUrl, diffStats, commitLog };
}

export async function checkoutPRBranch(branch: string) {
  await cleanWorkingTree();
  await sh(`git fetch origin ${branch}`);
  await sh(`git checkout ${branch}`);
  await sh(`git reset --hard origin/${branch}`);
}

export async function pushUpdates(branch: string) {
  await sh(`git push origin ${branch}`);
}

export async function returnToMain() {
  await cleanWorkingTree();
  await sh(`git checkout ${CONFIG.defaultBranch}`);
}
