import { CONFIG } from "./config.ts";
import type { LinearIssue } from "./linear.ts";

const GIT_AUTHOR = {
  GIT_AUTHOR_NAME: "Nightshift",
  GIT_AUTHOR_EMAIL: "nightshift-bot@noreply",
  GIT_COMMITTER_NAME: "Nightshift",
  GIT_COMMITTER_EMAIL: "nightshift-bot@noreply",
};

export async function sh(cmd: string, cwd: string = CONFIG.repoPath): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_AUTHOR },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Command failed (${code}): ${cmd}\n${err}`);
  return out.trim();
}

export async function prepareBranch(identifier: string): Promise<string> {
  const branch = `autofix/${identifier.toLowerCase()}`;
  await sh("git fetch origin");
  await sh("git checkout main && git pull origin main");
  try { await sh(`git branch -D ${branch}`); } catch { /* fine */ }
  await sh(`git checkout -b ${branch}`);
  return branch;
}

export async function branchHasCommits(branch: string): Promise<boolean> {
  try {
    const log = await sh(`git log main..${branch} --oneline`);
    return log.length > 0;
  } catch { return false; }
}

export async function pushAndCreatePR(branch: string, issue: LinearIssue): Promise<string> {
  await sh(`git push -u origin ${branch}`);
  const prTitle = `fix: ${issue.identifier} - ${issue.title}`;
  const prBody = [
    `Automated fix for [${issue.identifier}](${issue.url})`,
    "", `**Issue:** ${issue.title}`,
    issue.description ? `\n**Description:**\n${issue.description}` : "",
    "", "---",
    "_This PR was created by the AI engineering team._",
    "_Please review before merging._",
  ].join("\n");
  return await sh(
    `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" ` +
    `--body "${prBody.replace(/"/g, '\\"')}" --base main --head ${branch}`
  );
}

export async function returnToMain() {
  await sh("git checkout main");
}
