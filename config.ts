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
  seenCommentsFile: process.env.SEEN_COMMENTS_FILE ?? "./seen-comments.json",
  context7ApiKey: process.env.CONTEXT7_API_KEY ?? null,
  retriage: process.env.RETRIAGE === "true",

  // Git
  defaultBranch: process.env.DEFAULT_BRANCH ?? "main",
  branchPrefix: process.env.BRANCH_PREFIX ?? "autofix/",

  // Idle cleanup
  cleanupEnabled: process.env.CLEANUP_ENABLED !== "false",
  cleanupCooldownMs: Number(process.env.CLEANUP_COOLDOWN_MS ?? 60 * 60_000), // 1 hour
  cleanupBranchPrefix: process.env.CLEANUP_BRANCH_PREFIX ?? "cleanup/",

  // Agent limits
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 30 * 60_000), // 30 min

  // CI gate
  ciTimeoutMs: Number(process.env.CI_TIMEOUT_MS ?? 10 * 60_000), // 10 min
  maxCIRetries: Number(process.env.MAX_CI_RETRIES ?? 2),

  // Manual overrides
  forceIssue: process.env.FORCE_ISSUE ?? null,
  once: process.env.ONCE === "true" || process.argv.includes("--once"),

  // Nightshift schedule (24h format, local time)
  // Agent works between START and STOP, sleeps the rest.
  // Default: work 18:00–05:00, giving ~5h buffer for quota to reset by 10:00.
  shiftStart: Number(process.env.SHIFT_START ?? 18),  // 6 PM
  shiftStop: Number(process.env.SHIFT_STOP ?? 5),     // 5 AM
} as const;