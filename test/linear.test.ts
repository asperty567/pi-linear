import assert from "node:assert/strict";
import test from "node:test";
import { authorizationUrl, createCodeChallenge, isLocalRedirectUri } from "../extensions/oauth.ts";
import { parseIssueReference } from "../extensions/issue-reference.ts";
import { issueFilter } from "../extensions/issue-filter.ts";
import { summarizeIssues } from "../extensions/issue-summary.ts";

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
