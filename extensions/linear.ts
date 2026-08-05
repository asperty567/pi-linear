import { LinearClient } from "@linear/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import {
    authorizationUrl,
    createCodeVerifier,
    isLocalRedirectUri,
    type OAuthSettings,
} from "./oauth.js";
import {
    chmod,
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { issueFilter } from "./issue-filter.js";
import { summarizeIssue, summarizeIssues } from "./issue-summary.js";
import { parseIssueReference } from "./issue-reference.js";
import { confirmLinearWrite, registerLinearAdminTools } from "./admin.js";
import { jsonToolResult } from "./tool-result.js";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

interface TokenConfig {
    accessToken: string;
    scope?: string;
}

export function configPath(): string {
    return (
        process.env.PI_LINEAR_CONFIG_PATH ??
        join(homedir(), ".pi", "agent", "linear.json")
    );
}

async function readToken(): Promise<TokenConfig | undefined> {
    try {
        const parsed: unknown = JSON.parse(
            await readFile(configPath(), "utf8"),
        );
        if (
            !parsed ||
            typeof parsed !== "object" ||
            typeof (parsed as TokenConfig).accessToken !== "string"
        )
            return undefined;
        return parsed as TokenConfig;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw new Error(
            `Unable to read Linear credentials: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function saveToken(token: TokenConfig): Promise<void> {
    const path = configPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(token, null, 2)}\n`, {
        mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
}

function settingsFromEnvironment(): OAuthSettings {
    const clientId = process.env.LINEAR_CLIENT_ID;
    const redirectUri = process.env.LINEAR_REDIRECT_URI;
    if (!clientId || !redirectUri) {
        throw new Error(
            "Set LINEAR_CLIENT_ID and LINEAR_REDIRECT_URI before running /linear-login.",
        );
    }
    if (!isLocalRedirectUri(redirectUri)) {
        throw new Error(
            "LINEAR_REDIRECT_URI must be an http localhost callback URL this extension can receive.",
        );
    }
    return {
        clientId,
        clientSecret: process.env.LINEAR_CLIENT_SECRET,
        redirectUri,
    };
}

function openBrowser(url: string): void {
    const command =
        process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "cmd"
              : "xdg-open";
    const args =
        process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
}

async function waitForCallback(
    redirectUri: string,
    expectedState: string,
): Promise<string> {
    const callback = new URL(redirectUri);
    const port = Number(callback.port || 80);
    const host = callback.hostname === "[::1]" ? "::1" : callback.hostname;
    let server: ReturnType<typeof createServer> | undefined;

    try {
        return await new Promise<string>((resolve, reject) => {
            const complete = (error?: Error, code?: string) => {
                clearTimeout(timeout);
                server?.close();
                if (error) reject(error);
                else resolve(code!);
            };
            const timeout = setTimeout(
                () =>
                    complete(
                        new Error(
                            "Timed out waiting for the Linear OAuth callback.",
                        ),
                    ),
                CALLBACK_TIMEOUT_MS,
            );
            server = createServer((request, response) => {
                const requestUrl = new URL(request.url ?? "/", redirectUri);
                if (requestUrl.pathname !== callback.pathname) {
                    response.writeHead(404).end("Not found");
                    return;
                }
                const error = requestUrl.searchParams.get("error");
                const state = requestUrl.searchParams.get("state");
                const code = requestUrl.searchParams.get("code");
                if (error || state !== expectedState || !code) {
                    response
                        .writeHead(400, {
                            "Content-Type": "text/html; charset=utf-8",
                        })
                        .end(
                            "<h1>Linear authorization failed</h1><p>You can close this window.</p>",
                        );
                    complete(
                        new Error(
                            error
                                ? `Linear authorization failed: ${error}`
                                : "Invalid OAuth callback.",
                        ),
                    );
                    return;
                }
                response
                    .writeHead(200, {
                        "Content-Type": "text/html; charset=utf-8",
                    })
                    .end(
                        "<h1>Linear connected</h1><p>You can close this window and return to Pi.</p>",
                    );
                complete(undefined, code);
            });
            server.once("error", (error) =>
                complete(
                    new Error(
                        `Unable to listen for the OAuth callback: ${error.message}`,
                    ),
                ),
            );
            server.listen(port, host);
        });
    } finally {
        server?.close();
    }
}

async function exchangeCode(
    settings: OAuthSettings,
    code: string,
    verifier: string,
): Promise<TokenConfig> {
    const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: settings.redirectUri,
        client_id: settings.clientId,
        code_verifier: verifier,
    });
    if (settings.clientSecret) form.set("client_secret", settings.clientSecret);
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
    });
    const payload: unknown = await response.json();
    if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as { access_token?: unknown }).access_token !== "string"
    ) {
        const message =
            payload &&
            typeof payload === "object" &&
            typeof (payload as { error?: unknown }).error === "string"
                ? (payload as { error: string }).error
                : `HTTP ${response.status}`;
        throw new Error(`Linear token exchange failed: ${message}`);
    }
    const token = payload as { access_token?: unknown; scope?: unknown };
    if (typeof token.access_token !== "string")
        throw new Error(
            "Linear token exchange did not return an access token.",
        );
    return {
        accessToken: token.access_token,
        ...(typeof token.scope === "string" ? { scope: token.scope } : {}),
    };
}

async function authenticatedClient(): Promise<LinearClient> {
    const apiKey = process.env.LINEAR_API_KEY;
    if (apiKey) return new LinearClient({ apiKey });

    const token = await readToken();
    if (!token)
        throw new Error(
            "Linear is not connected. Set LINEAR_API_KEY or run /linear-login.",
        );
    return new LinearClient({ accessToken: token.accessToken });
}

async function findIssue(linear: LinearClient, input: string): Promise<any> {
    const reference = parseIssueReference(input);
    if (reference.type === "uuid") return linear.issue(reference.id);

    const results: any = await linear.issues({
        first: 1,
        filter: {
            number: { eq: reference.number },
            team: { key: { eq: reference.teamKey } },
        },
    });
    return results.nodes?.[0];
}

function renderLinearResult(
    result: { details?: unknown },
    options: { expanded: boolean },
    theme: { fg(color: string, text: string): string },
    summary: string,
) {
    const text = options.expanded
        ? JSON.stringify(result.details, null, 2)
        : `${summary} ${keyHint("app.tools.expand", "to expand")}`;
    return new Text(
        theme.fg(options.expanded ? "toolOutput" : "success", text),
        0,
        0,
    );
}

export default function (pi: ExtensionAPI) {
    registerLinearAdminTools(pi, authenticatedClient);

    pi.registerCommand("linear-login", {
        description:
            "Connect Pi to Linear with OAuth (requires LINEAR_CLIENT_ID and LINEAR_REDIRECT_URI).",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI)
                throw new Error(
                    "/linear-login requires an interactive Pi session.",
                );
            const settings = settingsFromEnvironment();
            const state = randomBytes(32).toString("base64url");
            const verifier = createCodeVerifier();
            const url = authorizationUrl(settings, state, verifier);
            const callback = waitForCallback(settings.redirectUri, state);
            openBrowser(url);
            ctx.ui.notify("Opening Linear sign-in in your browser…", "info");
            const code = await callback;
            await saveToken(await exchangeCode(settings, code, verifier));
            ctx.ui.notify("Linear connected.", "info");
        },
    });

    pi.registerCommand("linear-logout", {
        description: "Remove the locally stored Linear OAuth token.",
        handler: async () => {
            try {
                await unlink(configPath());
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
        },
    });

    pi.registerTool({
        name: "linear_get_issue",
        label: "Linear Get Issue",
        description:
            "Read a Linear issue by UUID, identifier such as ENG-123, or Linear issue URL. Requires /linear-login.",
        promptSnippet: "Read a Linear issue by UUID, identifier, or Linear issue URL",
        promptGuidelines: [
            "Use linear_get_issue with an issue URL supplied by the user directly; do not search first just to obtain its UUID.",
        ],
        parameters: Type.Object({
            identifier: Type.String({
                description:
                    "Linear issue UUID, identifier such as ENG-123, or Linear issue URL",
            }),
        }),
        async execute(_id, { identifier }) {
            const linear = await authenticatedClient();
            const issue = await findIssue(linear, identifier);
            if (!issue)
                throw new Error(`Linear issue not found: ${identifier}`);
            return jsonToolResult(await summarizeIssue(issue));
        },
        renderResult(result, options, theme) {
            const issue = result.details as
                | {
                      identifier?: string;
                      title?: string;
                      state?: { name?: string };
                  }
                | undefined;
            return renderLinearResult(
                result,
                options,
                theme,
                `${issue?.identifier ?? "Issue"}: ${issue?.title ?? "loaded"}${issue?.state?.name ? ` (${issue.state.name})` : ""}`,
            );
        },
    });

    pi.registerTool({
        name: "linear_search_issues",
        label: "Linear Search Issues",
        description:
            "Search Linear issues by text and optional filters. Returns at most 50 matching issues. Requires /linear-login.",
        promptSnippet: "Search Linear issues by text or filters",
        parameters: Type.Object({
            query: Type.Optional(
                Type.String({ description: "Text to search for" }),
            ),
            assigneeEmail: Type.Optional(
                Type.String({ description: "Assignee email address" }),
            ),
            team: Type.Optional(
                Type.String({ description: "Team key, such as ENG" }),
            ),
            state: Type.Optional(
                Type.String({ description: "Workflow state name, such as In Progress" }),
            ),
            project: Type.Optional(
                Type.String({ description: "Project name" }),
            ),
            label: Type.Optional(
                Type.String({ description: "Issue label name" }),
            ),
            priority: Type.Optional(
                Type.Integer({
                    minimum: 0,
                    maximum: 4,
                    description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
                }),
            ),
            limit: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
            ),
        }),
        async execute(
            _id,
            {
                query,
                assigneeEmail,
                team,
                state,
                project,
                label,
                priority,
                limit = 20,
            },
        ) {
            const linear = await authenticatedClient();
            const filter = issueFilter({
                assigneeEmail,
                team,
                state,
                project,
                label,
                priority,
            });
            const results: any = query
                ? await linear.searchIssues(query, { first: limit, filter })
                : await linear.issues({ first: limit, filter });
            return jsonToolResult({
                nodes: await summarizeIssues(results.nodes ?? []),
            });
        },
        renderResult(result, options, theme) {
            const count =
                (result.details as { nodes?: unknown[] } | undefined)?.nodes
                    ?.length ?? 0;
            return renderLinearResult(
                result,
                options,
                theme,
                `${count} Linear issue${count === 1 ? "" : "s"} found`,
            );
        },
    });

    pi.registerTool({
        name: "linear_comment_issue",
        label: "Linear Comment on Issue",
        description:
            "Post a Markdown comment on a Linear issue. This is an external write. Requires /linear-login.",
        promptSnippet: "Post a Markdown comment on a Linear issue",
        promptGuidelines: [
            "Use linear_comment_issue with an issue URL supplied by the user directly; do not search first just to obtain its UUID.",
        ],
        parameters: Type.Object({
            identifier: Type.String({
                description:
                    "Linear issue UUID, identifier such as ENG-123, or Linear issue URL",
            }),
            body: Type.String({ description: "Markdown comment body to post", maxLength: 10_000 }),
        }),
        async execute(_id, { identifier, body }, _signal, _onUpdate, ctx) {
            const linear = await authenticatedClient();
            const issue = await findIssue(linear, identifier);
            if (!issue)
                throw new Error(`Linear issue not found: ${identifier}`);
            await confirmLinearWrite(ctx, "Post Linear comment?", {
                issueId: issue.id,
                issueIdentifier: issue.identifier,
                body,
            });
            const result: any = await linear.createComment({
                issueId: issue.id,
                body,
            });
            const comment: any = await result?.comment;
            if (
                !result?.success || !comment || comment.body !== body ||
                comment.issueId !== issue.id
            ) throw new Error("Linear comment creation did not produce exact readback.");
            return jsonToolResult({
                id: comment.id,
                body: comment.body,
                createdAt: comment.createdAt,
                issue: identifier,
            });
        },
        renderResult(result, options, theme) {
            const issue =
                (result.details as { issue?: string } | undefined)?.issue ??
                "issue";
            return renderLinearResult(
                result,
                options,
                theme,
                `Comment posted to ${issue}`,
            );
        },
    });
}
