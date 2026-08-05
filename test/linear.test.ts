import assert from "node:assert/strict";
import test from "node:test";
import { authorizationUrl, createCodeChallenge, isLocalRedirectUri } from "../extensions/oauth.ts";
import { parseIssueReference } from "../extensions/issue-reference.ts";
import { issueFilter } from "../extensions/issue-filter.ts";
import { summarizeIssues } from "../extensions/issue-summary.ts";
import { registerLinearAdminTools } from "../extensions/admin.ts";

test("only accepts local HTTP OAuth redirect URIs", () => {
  assert.equal(isLocalRedirectUri("http://localhost:3000/oauth/callback"), true);
  assert.equal(isLocalRedirectUri("http://127.0.0.1:3000/oauth/callback"), true);
  assert.equal(isLocalRedirectUri("https://localhost:3000/oauth/callback"), false);
  assert.equal(isLocalRedirectUri("http://example.com/oauth/callback"), false);
});

test("parses Linear issue identifiers and URLs", () => {
  assert.deepEqual(parseIssueReference("CLINE-2368"), {
    type: "identifier",
    teamKey: "CLINE",
    number: 2368,
    identifier: "CLINE-2368",
  });
  assert.deepEqual(
    parseIssueReference("https://linear.app/cline-bot/issue/CLINE-2368/api-error-codex"),
    {
      type: "identifier",
      teamKey: "CLINE",
      number: 2368,
      identifier: "CLINE-2368",
    },
  );
  assert.throws(() => parseIssueReference("api error codex"), /Invalid Linear issue reference/);
});

test("builds supported issue filters", () => {
  assert.deepEqual(issueFilter({
    assigneeEmail: "ada@example.com",
    team: "ENG",
    state: "In Progress",
    project: "Apollo",
    label: "Bug",
    priority: 2,
  }), {
    assignee: { email: { eq: "ada@example.com" } },
    team: { key: { eq: "ENG" } },
    state: { name: { eq: "In Progress" } },
    project: { name: { eq: "Apollo" } },
    labels: { some: { name: { eq: "Bug" } } },
    priority: { eq: 2 },
  });
  assert.deepEqual(issueFilter({}), {});
});

test("search summaries do not treat an array index as an attachment flag", async () => {
  const issue = {
    id: "issue-id",
    identifier: "ENG-1",
    title: "Example",
    team: Promise.resolve(null),
    state: Promise.resolve(null),
    assignee: Promise.resolve(null),
  };

  await assert.doesNotReject(() => summarizeIssues([issue, issue]));
});

test("registers bounded Linear workspace administration tools", async () => {
  const tools = new Map<string, any>();
  const teams: any[] = [];
  let createCalls = 0;
  const client = {
    organization: Promise.resolve({ id: "workspace-1", name: "Workspace", urlKey: "workspace" }),
    async teams({ filter }: any) {
      const key = filter?.key?.eq;
      return { nodes: key ? teams.filter((team) => team.key === key) : teams };
    },
    async createTeam(input: any) {
      createCalls += 1;
      const team = makeTeam({ id: "team-1", ...input });
      teams.push(team);
      return { success: true, team: Promise.resolve(team), teamId: team.id };
    },
  };
  registerLinearAdminTools(testPi(tools), async () => client as any);

  assert.deepEqual([...tools.keys()], [
    "linear_list_teams",
    "linear_search_users",
    "linear_create_team",
    "linear_add_team_owner",
    "linear_remove_team_member",
    "linear_create_workflow_state",
    "linear_update_workflow_state",
    "linear_archive_workflow_state",
    "linear_archive_empty_team",
  ]);

  const create = tools.get("linear_create_team");
  const first = await create.execute("call-1", {
    commandId: "team-command-1",
    expectedWorkspaceId: "workspace-1",
    name: "Company Tasks",
    key: "TASK",
  });
  assert.equal(first.details.created, true);
  assert.equal(first.details.team.key, "TASK");
  assert.equal(first.details.team.private, true);

  const second = await create.execute("call-2", {
    commandId: "team-command-1",
    expectedWorkspaceId: "workspace-1",
    name: "Company Tasks",
    key: "TASK",
  });
  assert.equal(second.details.idempotent, true);
  assert.equal(createCalls, 1);

  await assert.rejects(
    create.execute("call-3", {
      commandId: "team-command-2",
      expectedWorkspaceId: "workspace-1",
      name: "Different Name",
      key: "TASK",
    }),
    /already exists with conflicting settings/,
  );
});

test("workspace writes fail closed without interactive one-use confirmation", async () => {
  const tools = new Map<string, any>();
  let createCalls = 0;
  const client = {
    organization: Promise.resolve({ id: "workspace-1" }),
    async teams() { return { nodes: [] }; },
    async createTeam() { createCalls += 1; return { success: true }; },
  };
  registerLinearAdminTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any, async () => client as any);
  await assert.rejects(
    tools.get("linear_create_team").execute("call-1", {
      commandId: "team-no-confirmation",
      expectedWorkspaceId: "workspace-1",
      name: "Company Tasks",
      key: "TASK",
    }),
    /interactive one-use confirmation/,
  );
  assert.equal(createCalls, 0);
});

test("creates and updates workflow states with exact readback", async () => {
  const tools = new Map<string, any>();
  const states: any[] = [];
  const team = makeTeam({ id: "team-1", name: "Company Tasks", key: "TASK", private: true, states });
  const client = {
    organization: Promise.resolve({ id: "workspace-1" }),
    async teams() { return { nodes: [team] }; },
    async team(id: string) { return id === team.id ? team : undefined; },
    async createWorkflowState(input: any) {
      const state = { id: `state-${states.length + 1}`, position: 0, archivedAt: null, ...input };
      states.push(state);
      return { success: true, workflowState: Promise.resolve(state), workflowStateId: state.id };
    },
    async updateWorkflowState(id: string, input: any) {
      const state = states.find((candidate) => candidate.id === id);
      Object.assign(state, input);
      return { success: true, workflowState: Promise.resolve(state), workflowStateId: state.id };
    },
  };
  registerLinearAdminTools(testPi(tools), async () => client as any);

  const created = await tools.get("linear_create_workflow_state").execute("call-1", {
    commandId: "state-command-1",
    expectedWorkspaceId: "workspace-1",
    teamId: "team-1",
    name: "Review",
    type: "started",
    color: "#5E6AD2",
    position: 40,
  });
  assert.equal(created.details.state.name, "Review");
  assert.equal(created.details.state.type, "started");

  const updated = await tools.get("linear_update_workflow_state").execute("call-2", {
    commandId: "state-command-2",
    expectedWorkspaceId: "workspace-1",
    teamId: "team-1",
    stateId: created.details.state.id,
    expectedName: "Review",
    expectedType: "started",
    expectedColor: "#5E6AD2",
    expectedPosition: 40,
    name: "In Review",
    color: "#4F46E5",
  });
  assert.equal(updated.details.state.name, "In Review");
  assert.equal(updated.details.state.color, "#4F46E5");
});

test("adds an owner and refuses to remove the last team owner", async () => {
  const tools = new Map<string, any>();
  const memberships: any[] = [{ id: "membership-pi", userId: "pi-user", owner: true }];
  const team: any = makeTeam({ id: "team-1", name: "Company Tasks", key: "TASK", private: true });
  team.memberships = async () => ({ nodes: memberships, pageInfo: { hasNextPage: false } });
  const users: Record<string, any> = {
    "pi-user": { id: "pi-user", name: "Pi", active: true, app: false, owner: true, organization: Promise.resolve({ id: "workspace-1" }) },
    "owner-user": { id: "owner-user", name: "Owner", active: true, app: false, owner: true, organization: Promise.resolve({ id: "workspace-1" }) },
  };
  const client = {
    organization: Promise.resolve({ id: "workspace-1" }),
    async teams() { return { nodes: [team] }; },
    async team(id: string) { return id === team.id ? team : undefined; },
    async user(id: string) { return users[id]; },
    async createTeamMembership(input: any) {
      memberships.push({ id: "membership-owner", userId: input.userId, owner: input.owner });
      return { success: true };
    },
    async deleteTeamMembership(id: string) {
      const index = memberships.findIndex((membership) => membership.id === id);
      memberships.splice(index, 1);
      return { success: true };
    },
  };
  registerLinearAdminTools(testPi(tools), async () => client as any);

  const added = await tools.get("linear_add_team_owner").execute("call-1", {
    commandId: "member-add-1",
    expectedWorkspaceId: "workspace-1",
    teamId: team.id,
    userId: "owner-user",
    expectedUserName: "Owner",
  });
  assert.equal(added.details.membership.owner, true);

  const removedPi = await tools.get("linear_remove_team_member").execute("call-2", {
    commandId: "member-remove-1",
    expectedWorkspaceId: "workspace-1",
    teamId: team.id,
    userId: "pi-user",
    expectedUserName: "Pi",
    expectedOwner: true,
  });
  assert.equal(removedPi.details.removed, true);

  await assert.rejects(
    tools.get("linear_remove_team_member").execute("call-3", {
      commandId: "member-remove-2",
      expectedWorkspaceId: "workspace-1",
      teamId: team.id,
      userId: "owner-user",
      expectedUserName: "Owner",
      expectedOwner: true,
    }),
    /last team owner/,
  );
});

test("archives only exact empty workflow states and command-created teams", async () => {
  const tools = new Map<string, any>();
  const teams: any[] = [];
  const states: any[] = [];
  let team: any;
  const state: any = {
    id: "state-1",
    name: "Unused",
    type: "started",
    color: "#5E6AD2",
    position: 1,
    archivedAt: null,
    async issues() { return { nodes: [], pageInfo: { hasNextPage: false } }; },
  };
  const client = {
    organization: Promise.resolve({ id: "workspace-1" }),
    async teams({ filter }: any) {
      const key = filter?.key?.eq;
      return { nodes: key ? teams.filter((candidate) => candidate.key === key) : teams };
    },
    async createTeam(input: any) {
      team = makeTeam({ ...input, states });
      team.issues = async () => ({ nodes: [], pageInfo: { hasNextPage: false } });
      team.projects = async () => ({ nodes: [], pageInfo: { hasNextPage: false } });
      team.ledInitiativeCount = 0;
      teams.push(team);
      return { success: true };
    },
    async team(id: string) { return id === team?.id ? team : undefined; },
    async workflowState(id: string) { return id === state.id ? state : undefined; },
    async archiveWorkflowState(id: string) {
      assert.equal(id, state.id);
      state.archivedAt = new Date();
      return { success: true };
    },
    async deleteTeam(id: string) {
      assert.equal(id, team.id);
      team.archivedAt = new Date();
      return { success: true };
    },
  };
  registerLinearAdminTools(testPi(tools), async () => client as any);

  const createdTeam = await tools.get("linear_create_team").execute("call-0", {
    commandId: "create-team-for-archive",
    expectedWorkspaceId: "workspace-1",
    name: "Company Tasks",
    key: "TASK",
  });
  state.teamId = createdTeam.details.team.id;
  states.push(state);

  const archivedState = await tools.get("linear_archive_workflow_state").execute("call-1", {
    commandId: "archive-state-1",
    expectedWorkspaceId: "workspace-1",
    teamId: team.id,
    stateId: state.id,
    expectedName: state.name,
    expectedType: state.type,
    expectedColor: state.color,
    expectedPosition: state.position,
  });
  assert.equal(archivedState.details.archived, true);

  const archivedTeam = await tools.get("linear_archive_empty_team").execute("call-2", {
    commandId: "archive-team-1",
    expectedWorkspaceId: "workspace-1",
    createCommandId: "create-team-for-archive",
    teamId: team.id,
    expectedName: team.name,
    expectedKey: team.key,
  });
  assert.equal(archivedTeam.details.archived, true);
});

function testPi(tools: Map<string, any>) {
  return {
    registerTool(tool: any) {
      const execute = tool.execute.bind(tool);
      tool.execute = (id: string, input: unknown) => execute(id, input, undefined, undefined, {
        hasUI: true,
        ui: { confirm: async () => true },
      });
      tools.set(tool.name, tool);
    },
  } as any;
}

function makeTeam(input: { id: string; name: string; key: string; private: boolean; states?: any[] }) {
  const states = input.states ?? [];
  return {
    ...input,
    issueCount: 0,
    ledInitiativeCount: 0,
    archivedAt: null,
    organization: Promise.resolve({ id: "workspace-1" }),
    async states() { return { nodes: states, pageInfo: { hasNextPage: false } }; },
  };
}

test("creates a PKCE authorization URL", () => {
  const url = new URL(authorizationUrl({
    clientId: "client-id",
    redirectUri: "http://localhost:3000/oauth/callback",
  }, "state-value", "verifier-value"));

  assert.equal(url.origin, "https://linear.app");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3000/oauth/callback");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("scope"), "read,write");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createCodeChallenge("verifier-value"));
});
