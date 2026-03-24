import { CONFIG } from "./config.ts";

export function context7Server() {
  if (CONFIG.context7ApiKey) {
    return {
      "context7": {
        type: "http" as const,
        url: "https://mcp.context7.com/mcp",
        headers: { "CONTEXT7_API_KEY": CONFIG.context7ApiKey },
      },
    };
  }
  return {
    "context7": {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    },
  };
}

export function withContext7(...extra: Record<string, any>[]) {
  return Object.assign({}, context7Server(), ...extra);
}
