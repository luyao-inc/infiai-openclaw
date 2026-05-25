# Infiai Channel for OpenClaw

![Infiai Logo](./logo.png)

OpenClaw Gateway 的 Infiai 渠道插件。

English documentation: [README.md](https://github.com/luyao-inc/infiai-openclaw/blob/main/README.md)

## 功能

- 支持私聊与群聊
- 支持文本/图片/文件消息的收发
- `infiai_send_video` 按文件消息发送（不使用 Infiai 视频消息）
- 支持引用消息解析（用于入站上下文）
- 支持多账号并发（`channels.infiai.accounts.<id>`）
- 支持群聊仅 @ 触发
- 提供交互式配置命令：`openclaw infiai setup`

注意：当前接入的 OpenIM SDK 入口仍是单例风格（`getSDK()`）。
本插件已经避免在热重载时把其他账号的 handler 一起拆掉，但如果要做高并发、多账号长期稳定托管，仍建议继续重点验证这一层。

## 安装

从 npm 安装：

```bash
openclaw plugins install @luyao-inc/infiai-openclaw
```

本地路径安装：

```bash
openclaw plugins install /path/to/openclaw-channel
```

仓库地址：https://github.com/luyao-inc/infiai-openclaw

## 标识说明

- npm 包名：`@luyao-inc/infiai-openclaw`
- 插件 id：`openclaw-channel`（用于 `plugins.entries` / `plugins.allow`）
- 渠道 id：`infiai`（用于 `channels.infiai`）
- 配置命令：`openclaw infiai setup`

## 配置

### 方式一：交互式配置（推荐）

```bash
openclaw infiai setup
```

### 方式二：手动编辑 `~/.openclaw/openclaw.json`

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

`userID` 和 `platformID` 为可选项，未填写时会自动从 JWT token 的 `UserID` / `PlatformID` 声明解析。

`requireMention` 为可选项，默认 `true`。

`inboundWhitelist` 为可选项，不填或为空时保持当前逻辑；填了后仅处理白名单用户触发的消息：
- 给账号发单聊消息
- 在群里 @ 账号的消息

支持单账号兜底写法（不使用 `accounts`）。

`default` 账号支持环境变量兜底：

- `INFIAI_TOKEN`
- `INFIAI_WS_ADDR`
- `INFIAI_API_ADDR`

可选环境变量覆盖项：

- `INFIAI_USER_ID`
- `INFIAI_PLATFORM_ID`

托管池 / 托管机器人互发轮次上限（可选；仅进程内计数，网关重启后清零）。熔断按 **`cfg.bindings` 里当前 `accountId` 对应的 agent** 与对应 `workspace-state.json` 的 `maxDialogueRounds` 计算，**不依赖** `resolveAgentRoute`（避免路由飘到别的租户 agent 时限额失效）。

- `MANAGED_AGENT_MAX_DIALOGUE_ROUNDS_CAP` — 与 workspace-state 中 `maxDialogueRounds` 上限钳制（默认 `10`）。
- `MANAGED_AGENT_MAX_DIALOGUE_ROUNDS_DEFAULT` — workspace-state 未写 `maxDialogueRounds` 时的默认轮次（默认 `5`）。
- `MANAGED_AGENT_MANAGED_MANAGED_IDLE_RESET_SEC` — 托管↔托管计数器若连续 **秒数** 无变化，则在下次入站时惰性清零（默认 `180` 秒）。

## Agent 工具

- `infiai_send_text`
  - `target`: `user:<id>` 或 `group:<id>`
  - `text`: 文本内容
  - `accountId`（可选）：指定发送账号

- `infiai_send_image`
  - `target`: `user:<id>` 或 `group:<id>`
  - `image`: 本地路径（支持 `file://`）或 `http(s)` URL
  - `accountId`（可选）：指定发送账号

- `infiai_send_video`
  - `target`: `user:<id>` 或 `group:<id>`
  - `video`: 本地路径（支持 `file://`）或 `http(s)` URL
  - 行为：按文件消息发送（不是视频消息）
  - `name`（可选）：URL 输入时覆盖文件名
  - `accountId`（可选）：指定发送账号

- `infiai_send_file`
  - `target`: `user:<id>` 或 `group:<id>`
  - `file`: 本地路径（支持 `file://`）或 `http(s)` URL
  - `name`（可选）：URL 输入时覆盖文件名
  - `accountId`（可选）：指定发送账号

## 相关 X/Twitter 工作流

Infiai 继续负责私聊、群聊、入站消息路由、富媒体发送、引用或回复上下文、多账号登录和群聊提及触发。如果同一个 OpenClaw 工作区还需要公开 X/Twitter 数据或可见的 X/Twitter 操作，请把 TweetClaw 作为独立 OpenClaw 插件安装：

```bash
openclaw plugins install @xquik/tweetclaw
```

[TweetClaw](https://github.com/Xquik-dev/tweetclaw) 支持 scrape tweets、tweet scraper workflows、search tweets、search tweet replies、follower export、user lookup、media upload、media download、direct messages、monitor tweets、webhooks、giveaway draws，以及需要审批的 post tweets 或 post tweet replies。安装细节以 TweetClaw GitHub 仓库和 [npm package](https://www.npmjs.com/package/@xquik/tweetclaw) 为准；[ClawHub discovery page](https://clawhub.ai/plugins/@xquik/tweetclaw) 仍可用于浏览，但该 listing 暂时落后于 npm。请分开保存 Infiai 凭据和 X/Twitter 凭据，并通过 OpenClaw 审批流程复核可见的 X/Twitter 操作。

## 开发

```bash
pnpm run build
pnpm run test:connect
```

运行 `test:connect` 前请先配置 `.env`（参考 `.env.example`）。

## 许可证

本项目采用 `AGPL-3.0-only` 许可证。详见 [LICENSE](https://github.com/luyao-inc/infiai-openclaw/blob/main/LICENSE)。
