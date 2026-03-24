import { CONFIG } from "./config.ts";

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: CONFIG.linearApiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as any;
  if (json.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  team: { key: string };
  state: { name: string };
  labels: { nodes: { name: string }[] };
}

export async function fetchNewIssues(): Promise<LinearIssue[]> {
  const teamFilter = CONFIG.teamKey
    ? `team: { key: { eq: "${CONFIG.teamKey}" } }`
    : "";

  const data = await gql(`
    query {
      issues(
        filter: {
          state: { type: { in: ["backlog", "unstarted", "triage"] } }
          ${teamFilter}
        }
        first: 20
        orderBy: createdAt
      ) {
        nodes {
          id identifier title description url
          team { key }
          state { name }
          labels { nodes { name } }
        }
      }
    }
  `);
  return data.issues.nodes;
}

export async function updateIssueState(issueId: string, stateName: string) {
  const data = await gql(
    `query($id: String!) {
      issue(id: $id) { team { states { nodes { id name } } } }
    }`,
    { id: issueId }
  );
  const match = data.issue.team.states.nodes.find((s: any) =>
    s.name.toLowerCase().includes(stateName.toLowerCase())
  );
  if (!match) { console.warn(`  State "${stateName}" not found`); return; }
  await gql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId: match.id }
  );
}

export async function addComment(issueId: string, body: string) {
  await gql(
    `mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) { success }
    }`,
    { id: issueId, body }
  );
}

async function getOrCreateLabel(name: string): Promise<string> {
  const data = await gql(`
    query { issueLabels(filter: { name: { eq: "${name}" } }) { nodes { id } } }
  `);
  if (data.issueLabels.nodes.length > 0) return data.issueLabels.nodes[0].id;
  const create = await gql(
    `mutation($name: String!) {
      issueLabelCreate(input: { name: $name, color: "#e5484d" }) {
        issueLabel { id } success
      }
    }`,
    { name }
  );
  return create.issueLabelCreate.issueLabel.id;
}

export async function addLabelToIssue(issueId: string, labelName: string) {
  const labelId = await getOrCreateLabel(labelName);
  const data = await gql(
    `query($id: String!) { issue(id: $id) { labels { nodes { id } } } }`,
    { id: issueId }
  );
  const existing: string[] = data.issue.labels.nodes.map((l: any) => l.id);
  if (existing.includes(labelId)) return;
  await gql(
    `mutation($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
    }`,
    { id: issueId, labelIds: [...existing, labelId] }
  );
}
