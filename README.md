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

