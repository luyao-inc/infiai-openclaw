# Infiai Channel for OpenClaw

![Infiai Logo](./logo.png)

Infiai channel plugin for OpenClaw Gateway.

Chinese documentation: [README.zh-CN.md](https://github.com/luyao-inc/infiai-openclaw/blob/main/README.zh-CN.md)

## Features

- Direct chat and group chat support
- Inbound and outbound text/image/file messages
- `infiai_send_video` is intentionally sent as a file message
- Quote/reply message parsing for inbound context
- Multi-account login via `channels.infiai.accounts.<id>`
- Group trigger policy with optional mention-only mode
- Interactive setup command: `openclaw infiai setup`

Note: the current OpenIM SDK entrypoint exposed to this plugin is still singleton-style (`getSDK()`).
The plugin now avoids tearing down other account handlers during hot reload, but very high-concurrency multi-account deployments should still be validated carefully.

## Installation

Install from npm:

```bash
openclaw plugins install @luyao-inc/infiai-openclaw
```

Or install from local path:

```bash
openclaw plugins install /path/to/openclaw-channel
```

Repository: https://github.com/luyao-inc/infiai-openclaw

## Identity Mapping

- npm package name: `@luyao-inc/infiai-openclaw`
- plugin id: `openclaw-channel` (used in `plugins.entries` and `plugins.allow`)
- channel id: `infiai` (used in `channels.infiai`)
- setup command: `openclaw infiai setup`

## Configuration

### Option 1: Interactive setup (recommended)

```bash
openclaw infiai setup
```

### Option 2: Edit `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "infiai": {
      "accounts": {
        "default": {
          "enabled": true,
          "token": "your_token",
          "wsAddr": "ws://127.0.0.1:10001",
          "apiAddr": "http://127.0.0.1:10002"
        }
      }
    }
  }
}
```

`userID` and `platformID` are optional. If omitted, they are auto-derived from JWT token claims (`UserID` and `PlatformID`).

`requireMention` is optional and defaults to `true`.

`inboundWhitelist` is optional. If omitted or empty, inbound handling keeps existing behavior.
If set, only these users can trigger processing:
- direct messages to the account
- group messages where they `@` the account

Single-account fallback (without `accounts`) is supported.

Environment fallback is supported for the `default` account:

- `INFIAI_TOKEN`
- `INFIAI_WS_ADDR`
- `INFIAI_API_ADDR`

Optional env overrides:

- `INFIAI_USER_ID`
- `INFIAI_PLATFORM_ID`

### Silent-reply compatibility

An exact OpenClaw `NO_REPLY` is a silent-success control signal, not a model failure. After dispatch, the plugin checks the current assistant snapshot and resolves it by surface: real-user DMs, open-platform calls, voice calls, and explicit group mentions use a fixed localized visible fallback; managed bot-to-bot and background surfaces remain silent. This uses code defaults and adds no runtime configuration. Authentication, rate-limit, timeout, and genuinely empty failures still use the normal `model_error` path.

Managed-pool / bot-to-bot round cap (optional; in-process only, resets on gateway restart). The cap uses the **Infiai `bindings` agent for the current `accountId`**, not `resolveAgentRoute`, so limits follow each tenant’s `workspace-state.json` even when session routing points at another agent.

- `MANAGED_AGENT_MAX_DIALOGUE_ROUNDS_CAP` — upper bound for `maxDialogueRounds` from workspace-state (default `10`).
- `MANAGED_AGENT_MAX_DIALOGUE_ROUNDS_DEFAULT` — default rounds when workspace-state omits `maxDialogueRounds` (default `5`).
- `MANAGED_AGENT_MANAGED_MANAGED_IDLE_RESET_SEC` — if a managed↔managed reply counter is unchanged for this many **seconds**, it is reset on the next inbound (default `180`).

## Agent Tools

- `infiai_send_text`
  - `target`: `user:<id>` or `group:<id>`
  - `text`: message text
  - `accountId` (optional): select sending account

- `infiai_send_image`
  - `target`: `user:<id>` or `group:<id>`
  - `image`: local path (`file://` supported) or `http(s)` URL
  - `accountId` (optional): select sending account

- `infiai_send_video`
  - `target`: `user:<id>` or `group:<id>`
  - `video`: local path (`file://` supported) or `http(s)` URL
  - behavior: sent as a file message (not Infiai video message)
  - `name` (optional): override filename for URL input
  - `accountId` (optional): select sending account

- `infiai_send_file`
  - `target`: `user:<id>` or `group:<id>`
  - `file`: local path (`file://` supported) or `http(s)` URL
  - `name` (optional): override filename for URL input
  - `accountId` (optional): select sending account

## Development

```bash
pnpm run build
pnpm run test:connect
```

For `test:connect`, configure `.env` first (see `.env.example`).

## License

AGPL-3.0-only. See [LICENSE](https://github.com/luyao-inc/infiai-openclaw/blob/main/LICENSE).
