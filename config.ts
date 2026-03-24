function env(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

export const CONFIG = {
  linearApiKey: env("LINEAR_API_KEY"),
  // No ANTHROPIC_API_KEY needed — Agent SDK uses your `claude login` session
  githubToken: env("GITHUB_TOKEN"),
  repoPath: env("REPO_PATH"),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  teamKey: process.env.LINEAR_TEAM_KEY ?? null,
  maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 1),
  dryRun: process.env.DRY_RUN === "true",
  seenFile: process.env.SEEN_FILE ?? "./seen-issues.json",
  context7ApiKey: process.env.CONTEXT7_API_KEY ?? null,
} as const;