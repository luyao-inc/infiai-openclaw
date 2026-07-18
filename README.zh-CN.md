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

### 静默回复兼容策略

OpenClaw 的精确 `NO_REPLY` 是静默成功控制信号，不是模型错误。插件会在派发完成后读取当前回合的原始 assistant 快照，再按表面分类：真人私聊、开放平台、语音和明确群聊 @ 固定使用本地化可见兜底；托管 Bot 间消息和后台静默表面保持无消息。策略使用代码默认值，不增加运行配置。真正的鉴权、限流、超时或空回复继续走 `model_error`，不会被静默规则吞掉。

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

## 开发

```bash
pnpm run build
pnpm run test:connect
```

运行 `test:connect` 前请先配置 `.env`（参考 `.env.example`）。

## 许可证

本项目采用 `AGPL-3.0-only` 许可证。详见 [LICENSE](https://github.com/luyao-inc/infiai-openclaw/blob/main/LICENSE)。
