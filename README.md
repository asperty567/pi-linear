# pi-linear

A [Pi](https://github.com/badlogic/pi-mono) package that connects Pi to Linear through OAuth and exposes tools for:

- reading an issue (`linear_get_issue`)
- searching issues by text, assignee email, team, state, project, label, or priority (`linear_search_issues`)
- posting a comment (`linear_comment_issue`)
- listing teams and workflow states (`linear_list_teams`)
- searching users without exposing email addresses (`linear_search_users`)
- creating private teams and managing verified owners (`linear_create_team`, `linear_add_team_owner`, `linear_remove_team_member`)
- creating, updating, and archiving workflow states (`linear_create_workflow_state`, `linear_update_workflow_state`, `linear_archive_workflow_state`)
- archiving an empty team (`linear_archive_empty_team`)

Workspace mutation tools require a stable command ID, exact user approval, preflight identity checks, and authoritative readback. Destructive tools refuse non-empty states or teams and refuse to remove the last team owner.

`linear_get_issue` includes up to 50 attachment links and their metadata. Tool output is compact by default in Pi’s TUI; expand a tool row to inspect its full JSON result.

## Install

From a checkout:

```sh
pi install /path/to/pi-linear
```

For one run:

```sh
pi -e /path/to/pi-linear
```

## Personal API key (recommended for local use)

Create a personal API key in Linear under **Settings → Security & Access → Personal API keys**, then start Pi with it:

```sh
export LINEAR_API_KEY="lin_api_..."
pi
```

The key is used directly by the Linear SDK and is never written to disk. It takes precedence over a stored OAuth token.

## OAuth setup

Use OAuth when you can create a Linear OAuth application. Register a local callback, for example `http://localhost:3000/oauth/callback`.
2. Start Pi with its credentials in the environment:

   ```sh
   export LINEAR_CLIENT_ID="..."
   export LINEAR_CLIENT_SECRET="..." # optional for public OAuth applications
   export LINEAR_REDIRECT_URI="http://localhost:3000/oauth/callback"
   pi
   ```

3. Run `/linear-login`. Pi starts a temporary callback server, opens Linear in the browser, validates OAuth `state`, and uses PKCE (`S256`) when exchanging the authorization code.

The access token is stored only at `~/.pi/agent/linear.json` with owner-only permissions. Set `PI_LINEAR_CONFIG_PATH` to use a different location. Run `/linear-logout` to remove it.

`LINEAR_REDIRECT_URI` must exactly match the application redirect URI and must be an `http://localhost`, `http://127.0.0.1`, or `http://[::1]` URL so the extension can safely receive the callback.

## Development

```sh
npm install
npm run typecheck
npm test
```

To enable changelogger functionality, run:

```sh
npx changelogger install
```
