import type { LinearClient } from "@linear/sdk";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { jsonToolResult } from "./tool-result.js";

const WORKFLOW_TYPES = new Set(["backlog", "unstarted", "started", "completed", "canceled"]);
const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const HEX_COLOR = /^#[0-9A-F]{6}$/;
const result = jsonToolResult;

type ClientFactory = () => Promise<LinearClient>;
type TeamLike = {
  id: string;
  name: string;
  key: string;
  private: boolean;
  description?: string | null;
  triageEnabled?: boolean;
  cyclesEnabled?: boolean;
  issueCount?: number;
  ledInitiativeCount?: number;
  archivedAt?: Date | null;
  states(input?: unknown): Promise<{ nodes?: WorkflowStateLike[]; pageInfo?: { hasNextPage?: boolean } }>;
  memberships?(input?: unknown): Promise<{ nodes?: MembershipLike[]; pageInfo?: { hasNextPage?: boolean } }>;
  issues?(input?: unknown): Promise<{ nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } }>;
  projects?(input?: unknown): Promise<{ nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } }>;
};
type MembershipLike = {
  id: string;
  userId?: string;
  owner: boolean;
  archivedAt?: Date | null;
};
type WorkflowStateLike = {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
  description?: string | null;
  archivedAt?: Date | null;
  issues?(input?: unknown): Promise<{ nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } }>;
};

function commandId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error("A bounded stable command ID is required.");
  return normalized;
}

function deterministicUuid(operation: string, stableCommandId: string): string {
  const bytes = createHash("sha256").update(`pi-linear-admin:${operation}:${stableCommandId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function requireWorkspace(client: LinearClient, expectedWorkspaceId: string): Promise<void> {
  const workspace: any = await client.organization;
  if (!workspace || workspace.id !== expectedWorkspaceId) {
    throw new Error(`Linear workspace conflict: expected ${expectedWorkspaceId}, current ${workspace?.id ?? "unavailable"}.`);
  }
}

async function requireTeamWorkspace(team: any, expectedWorkspaceId: string): Promise<void> {
  const workspace = await team.organization;
  if (!workspace || workspace.id !== expectedWorkspaceId) throw new Error("Linear team belongs to a different or unavailable workspace.");
}

export async function confirmLinearWrite(ctx: any, title: string, fields: Record<string, unknown>): Promise<void> {
  if (!ctx?.hasUI) throw new Error("Linear writes require an interactive one-use confirmation.");
  const approved = await ctx.ui.confirm(title, JSON.stringify(fields, null, 2));
  if (!approved) throw new Error("Linear write was not approved.");
}
const confirmWrite = confirmLinearWrite;

function teamKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!TEAM_KEY.test(normalized)) throw new Error("Linear team key must be 2-10 uppercase letters or digits and start with a letter.");
  return normalized;
}

function name(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) throw new Error(`${label} must be 1-80 characters.`);
  return normalized;
}

function color(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!HEX_COLOR.test(normalized)) throw new Error("Linear workflow color must be a six-digit uppercase hex color.");
  return normalized;
}

function workflowType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!WORKFLOW_TYPES.has(normalized)) {
    throw new Error("Linear workflow type must be backlog, unstarted, started, completed, or canceled.");
  }
  return normalized;
}

async function findTeam(client: LinearClient, key: string): Promise<TeamLike | undefined> {
  const connection: any = await client.teams({ first: 2, filter: { key: { eq: key } } });
  if (!Array.isArray(connection.nodes)) throw new Error("Linear team lookup is incomplete.");
  const nodes = connection.nodes as TeamLike[];
  if (nodes.length > 1) throw new Error(`Linear returned more than one team for key ${key}.`);
  return nodes[0];
}

async function getTeam(client: LinearClient, teamId: string, expectedWorkspaceId: string): Promise<TeamLike> {
  const team: any = await client.team(teamId);
  if (!team || team.id !== teamId || team.archivedAt) throw new Error(`Linear team is unavailable: ${teamId}`);
  await requireTeamWorkspace(team, expectedWorkspaceId);
  return team as TeamLike;
}

async function statesFor(team: TeamLike): Promise<WorkflowStateLike[]> {
  const connection = await team.states({ first: 50 });
  if (!Array.isArray(connection.nodes) || connection.pageInfo?.hasNextPage !== false) throw new Error("Linear workflow state inventory is incomplete.");
  const nodes = connection.nodes.filter((state) => !state.archivedAt);
  if (nodes.length > 50) throw new Error("Linear workflow state inventory exceeded its bound.");
  return nodes.sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}

async function summarizeTeam(team: TeamLike) {
  return {
    id: team.id,
    name: team.name,
    key: team.key,
    private: team.private,
    issueCount: team.issueCount ?? null,
    description: team.description ?? null,
    triageEnabled: team.triageEnabled ?? null,
    cyclesEnabled: team.cyclesEnabled ?? null,
    states: (await statesFor(team)).map(summarizeState),
  };
}

function summarizeState(state: WorkflowStateLike) {
  return {
    id: state.id,
    name: state.name,
    type: state.type,
    color: state.color,
    position: state.position,
  };
}

async function membershipsFor(team: TeamLike): Promise<MembershipLike[]> {
  if (typeof team.memberships !== "function") throw new Error("Linear team membership inventory is unavailable.");
  const connection = await team.memberships({ first: 50 });
  if (!Array.isArray(connection.nodes) || connection.pageInfo?.hasNextPage !== false) throw new Error("Linear team membership inventory is incomplete or exceeded its bound.");
  return connection.nodes.filter((membership) => !membership.archivedAt);
}

async function matchingState(team: TeamLike, stateName: string): Promise<WorkflowStateLike | undefined> {
  const matches = (await statesFor(team)).filter((state) => state.name.toLowerCase() === stateName.toLowerCase());
  if (matches.length > 1) throw new Error(`Linear team has duplicate workflow states named ${stateName}.`);
  return matches[0];
}

async function stateById(team: TeamLike, stateId: string): Promise<WorkflowStateLike> {
  const state = (await statesFor(team)).find((candidate) => candidate.id === stateId);
  if (!state) throw new Error(`Linear workflow state ${stateId} is not active in team ${team.id}.`);
  return state;
}

export function registerLinearAdminTools(pi: ExtensionAPI, getClient: ClientFactory): void {
  pi.registerTool({
    name: "linear_list_teams",
    label: "Linear List Teams",
    description: "List accessible Linear teams and their active workflow states. Read-only. Requires /linear-login.",
    promptSnippet: "List Linear teams and workflow states",
    parameters: Type.Object({}),
    async execute() {
      const client = await getClient();
      const workspace: any = await client.organization;
      const connection: any = await client.teams({ first: 50 });
      if (!Array.isArray(connection.nodes) || connection.pageInfo?.hasNextPage !== false) throw new Error("Linear team inventory is incomplete.");
      const teams = connection.nodes.filter((team: TeamLike) => !team.archivedAt);
      if (teams.length > 50) throw new Error("Linear team inventory exceeded its bound.");
      return result({ workspace: { id: workspace.id, name: workspace.name, urlKey: workspace.urlKey }, teams: await Promise.all(teams.map((team: TeamLike) => summarizeTeam(team))) });
    },
  });

  pi.registerTool({
    name: "linear_search_users",
    label: "Linear Search Users",
    description: "Search accessible Linear users by name and return bounded non-secret identity data. Read-only. Requires /linear-login.",
    promptSnippet: "Search Linear users by name",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Case-insensitive name fragment" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
    }),
    async execute(_id, { query, limit = 20 }) {
      const client = await getClient();
      const normalized = query?.trim();
      const connection: any = await client.users({
        first: limit,
        ...(normalized ? { filter: { name: { containsIgnoreCase: normalized } } } : {}),
      });
      const users = (connection.nodes ?? []).map((user: any) => ({
        id: user.id,
        name: user.name,
        active: user.active ?? null,
        app: user.app ?? null,
        workspaceOwner: user.owner ?? null,
        isAuthenticatedUser: user.isMe ?? null,
        admin: user.admin ?? null,
      }));
      return result({ users });
    },
  });

  pi.registerTool({
    name: "linear_create_team",
    label: "Linear Create Team",
    description: "Create one private Linear team with fixed safe defaults, deterministic retry identity, conflict checks, and authoritative readback. External workspace write. Requires exact user approval and /linear-login.",
    promptSnippet: "Create a private Linear team after exact user approval",
    promptGuidelines: ["Use linear_create_team only after the latest explicit user approval names the exact workspace ID, private team name, key, and command ID; this is an external workspace write."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable command ID for deterministic retry identity" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      name: Type.String({ description: "Private team name" }),
      key: Type.String({ description: "2-10 character uppercase team key" }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const expected = {
        id: deterministicUuid("create-team", id),
        name: name(input.name, "Linear team name"),
        key: teamKey(input.key),
        private: true,
        triageEnabled: true,
        cyclesEnabled: false,
        description: "First harness-neutral company Task cohort.",
      };
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      const exact = (team: TeamLike) =>
        team.id === expected.id && team.name === expected.name && team.private === true &&
        team.triageEnabled === true && team.cyclesEnabled === false && team.description === expected.description;
      const existing = await findTeam(client, expected.key);
      if (existing) {
        await requireTeamWorkspace(existing, input.expectedWorkspaceId);
        if (!exact(existing) || existing.archivedAt) throw new Error(`Linear team ${expected.key} already exists with conflicting settings or command identity.`);
        return result({ commandId: id, created: false, idempotent: true, team: await summarizeTeam(existing) });
      }

      await confirmWrite(ctx, "Create private Linear team?", {
        commandId: id, workspaceId: input.expectedWorkspaceId, teamId: expected.id,
        name: expected.name, key: expected.key, private: true, triageEnabled: true, cyclesEnabled: false,
        description: expected.description,
      });
      let failure: unknown;
      try {
        const payload: any = await client.createTeam(expected);
        if (!payload?.success) throw new Error("Linear did not create the team.");
      } catch (error) {
        failure = error;
      }
      const readback = await findTeam(client, expected.key);
      if (readback) await requireTeamWorkspace(readback, input.expectedWorkspaceId);
      if (!readback || !exact(readback)) {
        throw new Error(`Linear team creation did not produce exact readback${failure ? ": result was ambiguous" : ""}.`, { cause: failure });
      }
      return result({ commandId: id, created: true, recoveredAfterAmbiguousResult: Boolean(failure), team: await summarizeTeam(readback) });
    },
  });

  pi.registerTool({
    name: "linear_add_team_owner",
    label: "Linear Add Team Owner",
    description: "Add one verified active user as a Linear team owner with deterministic retry identity and authoritative readback. External workspace write. Requires exact user approval and /linear-login.",
    promptSnippet: "Add a verified Linear team owner after exact user approval",
    promptGuidelines: ["Use linear_add_team_owner only after the latest explicit user approval names the workspace, team, user ID, expected user name, and command ID; this is an external workspace write."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable command ID" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      teamId: Type.String({ description: "Exact Linear team UUID" }),
      userId: Type.String({ description: "Exact Linear user UUID" }),
      expectedUserName: Type.String({ description: "Exact current Linear user name" }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      const user: any = await client.user(input.userId);
      const userWorkspace: any = await user?.organization;
      if (
        !user || user.id !== input.userId || user.name !== name(input.expectedUserName, "Expected Linear user name") ||
        user.active !== true || user.app !== false || user.owner !== true || userWorkspace?.id !== input.expectedWorkspaceId
      ) throw new Error("Linear human workspace-owner identity is unavailable, inactive, or changed.");
      const team = await getTeam(client, input.teamId, input.expectedWorkspaceId);
      let memberships = await membershipsFor(team);
      let membership = memberships.find((candidate) => candidate.userId === input.userId);
      if (membership?.owner) {
        return result({ commandId: id, changed: false, idempotent: true, membership: { id: membership.id, userId: membership.userId, owner: true } });
      }
      await confirmWrite(ctx, membership ? "Promote Linear team owner?" : "Add Linear team owner?", {
        commandId: id, workspaceId: input.expectedWorkspaceId, teamId: team.id,
        userId: user.id, userName: user.name, owner: true,
        membershipId: membership?.id ?? deterministicUuid("add-team-owner", id),
      });
      let failure: unknown;
      try {
        const payload: any = membership
          ? await client.updateTeamMembership(membership.id, { owner: true })
          : await client.createTeamMembership({
              id: deterministicUuid("add-team-owner", id), teamId: team.id, userId: input.userId, owner: true,
            });
        if (!payload?.success) throw new Error("Linear did not add the team owner.");
      } catch (error) { failure = error; }
      memberships = await membershipsFor(team);
      membership = memberships.find((candidate) => candidate.userId === input.userId);
      if (!membership?.owner) throw new Error(`Linear team-owner mutation did not produce exact readback${failure ? " after an ambiguous result" : ""}.`, { cause: failure });
      return result({ commandId: id, changed: true, recoveredAfterAmbiguousResult: Boolean(failure), membership: { id: membership.id, userId: membership.userId, owner: true } });
    },
  });

  pi.registerTool({
    name: "linear_remove_team_member",
    label: "Linear Remove Team Member",
    description: "Remove one exact Linear team member while preserving at least one team owner. Destructive external write. Requires exact user approval and /linear-login.",
    promptSnippet: "Remove a Linear team member after exact user approval",
    promptGuidelines: ["Use linear_remove_team_member only after the latest exact destructive approval names the workspace, team, user ID, expected user name, and owner flag; never remove the last team owner."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable command ID" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      teamId: Type.String({ description: "Exact Linear team UUID" }),
      userId: Type.String({ description: "Exact Linear user UUID" }),
      expectedUserName: Type.String({ description: "Exact current Linear user name" }),
      expectedOwner: Type.Boolean({ description: "Expected current team-owner flag" }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      const user: any = await client.user(input.userId);
      const userWorkspace: any = await user?.organization;
      if (
        !user || user.id !== input.userId || user.name !== name(input.expectedUserName, "Expected Linear user name") ||
        user.app !== false || userWorkspace?.id !== input.expectedWorkspaceId
      ) throw new Error("Linear human user identity is unavailable or changed.");
      const team = await getTeam(client, input.teamId, input.expectedWorkspaceId);
      let memberships = await membershipsFor(team);
      const membership = memberships.find((candidate) => candidate.userId === input.userId);
      if (!membership) return result({ commandId: id, removed: false, idempotent: true, userId: input.userId });
      if (membership.owner !== input.expectedOwner) throw new Error("Linear team membership owner flag changed before removal.");
      if (membership.owner && memberships.filter((candidate) => candidate.owner).length < 2) throw new Error("Linear refused to remove the last team owner.");
      await confirmWrite(ctx, "Remove Linear team member?", {
        commandId: id, workspaceId: input.expectedWorkspaceId, teamId: team.id,
        userId: user.id, userName: user.name, membershipId: membership.id, currentOwner: membership.owner,
      });
      let failure: unknown;
      try {
        const payload: any = await client.deleteTeamMembership(membership.id);
        if (!payload?.success) throw new Error("Linear did not remove the team membership.");
      } catch (error) { failure = error; }
      memberships = await membershipsFor(team);
      if (memberships.some((candidate) => candidate.userId === input.userId)) {
        throw new Error(`Linear team membership removal did not produce exact readback${failure ? ": result was ambiguous" : ""}.`, { cause: failure });
      }
      return result({ commandId: id, removed: true, recoveredAfterAmbiguousResult: Boolean(failure), userId: input.userId });
    },
  });

  pi.registerTool({
    name: "linear_create_workflow_state",
    label: "Linear Create Workflow State",
    description: "Create one Linear workflow state with team/name/type conflict checks and authoritative readback. External workspace write. Requires exact user approval and /linear-login.",
    promptSnippet: "Create a Linear workflow state after exact user approval",
    promptGuidelines: ["Use linear_create_workflow_state only after the latest explicit user approval names the workspace, team, state name, type, color, position, and command ID; this is an external workspace write."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable command ID for deterministic retry identity" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      teamId: Type.String({ description: "Exact Linear team UUID" }),
      name: Type.String({ description: "Workflow state name" }),
      type: Type.String({ description: "backlog, unstarted, started, completed, or canceled" }),
      color: Type.String({ description: "Six-digit hex color, such as #5E6AD2" }),
      position: Type.Number({ minimum: 0, maximum: 1000 }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const expected = {
        id: deterministicUuid("create-workflow-state", id),
        name: name(input.name, "Linear workflow state name"),
        type: workflowType(input.type),
        color: color(input.color),
        position: input.position,
      };
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      const team = await getTeam(client, input.teamId, input.expectedWorkspaceId);
      const existing = await matchingState(team, expected.name);
      if (existing) {
        if (
          existing.id !== expected.id ||
          existing.name !== expected.name ||
          existing.type !== expected.type ||
          existing.color.toUpperCase() !== expected.color ||
          existing.position !== expected.position
        ) {
          throw new Error(`Linear workflow state ${expected.name} already exists with conflicting settings.`);
        }
        return result({ commandId: id, created: false, idempotent: true, state: summarizeState(existing) });
      }

      await confirmWrite(ctx, "Create Linear workflow state?", {
        commandId: id, workspaceId: input.expectedWorkspaceId, teamId: team.id, ...expected,
      });
      let failure: unknown;
      try {
        const payload: any = await client.createWorkflowState({
          teamId: team.id,
          ...expected,
        });
        if (!payload?.success) throw new Error("Linear did not create the workflow state.");
      } catch (error) {
        failure = error;
      }
      const readback = await matchingState(team, expected.name);
      if (
        !readback ||
        readback.id !== expected.id ||
        readback.name !== expected.name ||
        readback.type !== expected.type ||
        readback.color.toUpperCase() !== expected.color ||
        readback.position !== expected.position
      ) {
        throw new Error(`Linear workflow state creation did not produce exact readback${failure ? ": result was ambiguous" : ""}.`, { cause: failure });
      }
      return result({ commandId: id, created: true, recoveredAfterAmbiguousResult: Boolean(failure), state: summarizeState(readback) });
    },
  });

  pi.registerTool({
    name: "linear_update_workflow_state",
    label: "Linear Update Workflow State",
    description: "Update one named Linear workflow state and require exact readback. External workspace write. Requires exact user approval and /linear-login.",
    promptSnippet: "Update a Linear workflow state after exact user approval",
    promptGuidelines: ["Use linear_update_workflow_state only after the latest explicit user approval names the workspace, team, exact current state snapshot, requested fields, and command ID; this is an external workspace write."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable command ID" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      teamId: Type.String({ description: "Exact Linear team UUID" }),
      stateId: Type.String({ description: "Exact Linear workflow state UUID" }),
      expectedName: Type.String({ description: "Exact current state name" }),
      expectedType: Type.String({ description: "Exact current state type" }),
      expectedColor: Type.String({ description: "Exact current state color" }),
      expectedPosition: Type.Number({ description: "Exact current state position" }),
      name: Type.Optional(Type.String({ description: "New state name" })),
      color: Type.Optional(Type.String({ description: "New six-digit hex color" })),
      position: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      const team = await getTeam(client, input.teamId, input.expectedWorkspaceId);
      const before = await stateById(team, input.stateId);
      const expectedSnapshot = {
        name: name(input.expectedName, "Expected workflow state name"),
        type: workflowType(input.expectedType),
        color: color(input.expectedColor),
        position: input.expectedPosition,
      };
      if (
        before.name !== expectedSnapshot.name || before.type !== expectedSnapshot.type ||
        before.color.toUpperCase() !== expectedSnapshot.color || before.position !== expectedSnapshot.position
      ) throw new Error("Linear workflow state changed before update.");
      const patch = {
        ...(input.name === undefined ? {} : { name: name(input.name, "Linear workflow state name") }),
        ...(input.color === undefined ? {} : { color: color(input.color) }),
        ...(input.position === undefined ? {} : { position: input.position }),
      };
      if (Object.keys(patch).length === 0) throw new Error("At least one workflow state update field is required.");
      await confirmWrite(ctx, "Update Linear workflow state?", {
        commandId: id, workspaceId: input.expectedWorkspaceId, teamId: team.id,
        stateId: before.id, current: expectedSnapshot, requested: patch,
      });
      let failure: unknown;
      try {
        const payload: any = await client.updateWorkflowState(before.id, patch);
        if (!payload?.success) throw new Error("Linear did not update the workflow state.");
      } catch (error) { failure = error; }
      const after = await stateById(team, before.id);
      for (const [key, value] of Object.entries(patch)) {
        const observed = (after as any)[key];
        if (key === "color" ? String(observed).toUpperCase() !== value : observed !== value) {
          throw new Error(`Linear workflow state update did not produce exact readback for ${key}${failure ? " after an ambiguous result" : ""}.`, { cause: failure });
        }
      }
      return result({ commandId: id, updated: true, recoveredAfterAmbiguousResult: Boolean(failure), state: summarizeState(after) });
    },
  });

  pi.registerTool({
    name: "linear_archive_workflow_state",
    label: "Linear Archive Workflow State",
    description: "Archive one empty Linear workflow state after exact identity and issue checks. Destructive external write. Requires exact user approval and /linear-login.",
    promptSnippet: "Archive an empty Linear workflow state after exact user approval",
    promptGuidelines: ["Use linear_archive_workflow_state only after the latest exact destructive approval names the workspace, team, full current state snapshot, and command ID; verify zero issues and terminal readback."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable command ID" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      teamId: Type.String({ description: "Exact Linear team UUID" }),
      stateId: Type.String({ description: "Exact Linear workflow state UUID" }),
      expectedName: Type.String({ description: "Exact current state name" }),
      expectedType: Type.String({ description: "Exact current state type" }),
      expectedColor: Type.String({ description: "Exact current state color" }),
      expectedPosition: Type.Number({ description: "Exact current state position" }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      await getTeam(client, input.teamId, input.expectedWorkspaceId);
      const state: any = await client.workflowState(input.stateId);
      if (!state || state.teamId !== input.teamId) throw new Error("Linear workflow state is unavailable or belongs to another team.");
      if (
        state.name !== name(input.expectedName, "Expected workflow state name") ||
        state.type !== workflowType(input.expectedType) || state.color.toUpperCase() !== color(input.expectedColor) ||
        state.position !== input.expectedPosition
      ) throw new Error("Linear workflow state changed before archive.");
      if (state.archivedAt) return result({ commandId: id, archived: false, idempotent: true, state: summarizeState(state) });
      if (typeof state.issues !== "function") throw new Error("Linear workflow state issue inventory is unavailable.");
      const issues = await state.issues({ first: 1, includeArchived: true });
      if (!Array.isArray(issues.nodes) || issues.pageInfo?.hasNextPage !== false) throw new Error("Linear workflow state issue inventory is incomplete.");
      if (issues.nodes.length > 0) throw new Error("Linear workflow state is not empty and cannot be archived safely.");
      await confirmWrite(ctx, "Archive empty Linear workflow state?", {
        commandId: id, workspaceId: input.expectedWorkspaceId, teamId: input.teamId,
        state: summarizeState(state), destructive: true,
      });
      let failure: unknown;
      try {
        const payload: any = await client.archiveWorkflowState(state.id);
        if (!payload?.success) throw new Error("Linear did not archive the workflow state.");
      } catch (error) { failure = error; }
      const readback: any = await client.workflowState(state.id);
      if (
        !readback?.archivedAt || readback.id !== state.id || readback.teamId !== input.teamId ||
        readback.name !== state.name || readback.type !== state.type ||
        readback.color.toUpperCase() !== state.color.toUpperCase() || readback.position !== state.position
      ) throw new Error(`Linear workflow state archive did not produce exact terminal readback${failure ? " after an ambiguous result" : ""}.`, { cause: failure });
      return result({ commandId: id, archived: true, recoveredAfterAmbiguousResult: Boolean(failure), state: summarizeState(readback) });
    },
  });

  pi.registerTool({
    name: "linear_archive_empty_team",
    label: "Linear Archive Empty Team",
    description: "Archive an empty Linear team after exact key and issue-count checks. Destructive external write. Requires exact user approval and /linear-login.",
    promptSnippet: "Archive an empty Linear team after exact user approval",
    promptGuidelines: ["Use linear_archive_empty_team only after the latest exact destructive approval names the workspace, original create command ID, team UUID, name, and key; verify no issues, projects, or led initiatives."],
    parameters: Type.Object({
      commandId: Type.String({ description: "Stable archive command ID" }),
      expectedWorkspaceId: Type.String({ description: "Exact Linear workspace UUID" }),
      createCommandId: Type.String({ description: "Original linear_create_team command ID" }),
      teamId: Type.String({ description: "Exact Linear team UUID" }),
      expectedName: Type.String({ description: "Exact current team name" }),
      expectedKey: Type.String({ description: "Exact current team key" }),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const id = commandId(input.commandId);
      const originalId = commandId(input.createCommandId);
      const client = await getClient();
      await requireWorkspace(client, input.expectedWorkspaceId);
      const direct: any = await client.team(input.teamId);
      if (direct) await requireTeamWorkspace(direct, input.expectedWorkspaceId);
      if (!direct || direct.id !== deterministicUuid("create-team", originalId)) throw new Error("Linear team was not created by the approved command identity.");
      if (direct.name !== name(input.expectedName, "Expected Linear team name") || direct.key !== teamKey(input.expectedKey) || !direct.private) {
        throw new Error("Linear team identity changed before archive.");
      }
      if (direct.archivedAt) return result({ commandId: id, archived: false, idempotent: true, team: { id: direct.id, name: direct.name, key: direct.key } });
      if (typeof direct.issues !== "function" || typeof direct.projects !== "function") throw new Error("Linear team resource inventory is unavailable.");
      const issues: any = await direct.issues({ first: 1, includeArchived: true });
      const projects: any = await direct.projects({ first: 1, includeArchived: true });
      if (!Array.isArray(issues.nodes) || issues.pageInfo?.hasNextPage !== false || typeof direct.issueCount !== "number") throw new Error("Linear team issue inventory is incomplete.");
      if (!Array.isArray(projects.nodes) || projects.pageInfo?.hasNextPage !== false) throw new Error("Linear team project inventory is incomplete.");
      if (issues.nodes.length || direct.issueCount !== 0) throw new Error("Linear team has issues and cannot be archived safely.");
      if (projects.nodes.length) throw new Error("Linear team has projects and cannot be archived safely.");
      if (direct.ledInitiativeCount !== 0) throw new Error("Linear team led-initiative count is unavailable or nonzero; archive is unsafe.");
      await confirmWrite(ctx, "Archive empty command-created Linear team?", {
        commandId: id, createCommandId: originalId, workspaceId: input.expectedWorkspaceId,
        teamId: direct.id, name: direct.name, key: direct.key, destructive: true,
      });
      let failure: unknown;
      try {
        const payload: any = await client.deleteTeam(direct.id);
        if (!payload?.success) throw new Error("Linear did not archive the team.");
      } catch (error) { failure = error; }
      const readback: any = await client.team(direct.id);
      if (readback) await requireTeamWorkspace(readback, input.expectedWorkspaceId);
      if (
        !readback?.archivedAt || readback.id !== direct.id ||
        readback.name !== direct.name || readback.key !== direct.key
      ) throw new Error(`Linear team archive did not produce exact terminal readback${failure ? " after an ambiguous result" : ""}.`, { cause: failure });
      return result({ commandId: id, archived: true, recoveredAfterAmbiguousResult: Boolean(failure), team: { id: direct.id, name: direct.name, key: direct.key } });
    },
  });
}
