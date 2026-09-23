# OpenIM Node 托管账号异常隔离

2026-09-23：本地候选实现，未部署生产。此次范围是两次重启排查方案的 P0；消息持久恢复与池拆分不属于本补丁。

## 官方核对与归因边界

- 官方包：[npm @openim/client-sdk](https://www.npmjs.com/package/@openim/client-sdk)，注册表元数据 `https://registry.npmjs.org/@openim%2fclient-sdk`。生产 3.8.3 的 CommonJS 文件与官方发布包 SHA-256 完全一致：`d3a2ba88ec7315424df73de0ef559acbaccf1b59092fb33ca4bc3c8cb8b68bb7`。此处异常处理缺口不是本地改写该 SDK 文件造成的。
- 当前官方 latest 为 3.8.3-hotfix.0，新增断开/重置时拒绝未完成请求；采用精确版本和 lockfile，不扩散升级其他依赖。官方包内打印的版本字符串仍是 `3.8.3-patch.1`，验证以 package.json 和哈希为准。
- 该 hotfix 仍有 WebSocket 回调拒绝无 catch、processing 标志缺 finally、通知/同步 Promise 未等待的问题。其 CJS 还引用发布包不存在的 `@openim/protocol/lib/pb/sdkws/sdkws`。通过真实包执行验证该错误，并改用同一协议包公开的 `SdkWsProto.PullOrder`。
- 官方发布包主要面向浏览器/小程序。Node 多账号共进程运行所需的异常隔离属于当前集成层责任。搜索未找到可直接替代此次全部修复且经验证的官方方案，不据此宣称上游永远没有修复。
- Node 原生 EventTarget 的异步 listener 拒绝可能终止进程；参见 [Node EventTarget error handling](https://nodejs.org/api/events.html#eventtarget-error-handling)。旧生产日志被截断，不能从合成复现反推当时具体是哪条输入触发，也未证明与先前模型耗时是同一根因。

## 实现边界

`scripts/prepare-sdk.cjs` 在安装及构建时校验官方 CJS SHA-256 `824d1fd844ba4aa6656cca7dabd4b80b8e34627101c42c7dea1b821c609e70c1`，只修改工厂注入点与缺失的协议引用，复制可审查的 `sdk-safety.cjs`。重复运行幂等；版本/字节变化直接失败，禁止模糊套用。Node CJS 是 runtime 使用入口，未修改浏览器 ESM/UMD；启动缺少适配器时客户端明确失败。Docker 在插件安装后再次显式执行，避免安装器跳过 lifecycle script。

适配器在原始 SDK 实例、公开 Proxy 之前保护 WS 接收、被分离调用的消息/通知/同步 Promise 和心跳入口。异常记录仅保留错误类别、指纹和文件位置，随后关闭故障账号连接，发送连接失败事件，由现有 OpenClaw account 生命周期处理重启。其他账号保持连接。接收处理计数在 finally 归零，不把需要等待 RPC 响应的消息处理串行化。旧连接重连定时器不能在 logout 后重新连接；清理 typing cache 的后台清扫定时器。

没有全局吞掉 uncaughtException/unhandledRejection，也没有盲目重放用户消息。SDK 之外的未知致命错误仍正常退出；runtime 的 `uncaughtExceptionMonitor` 先同步输出脱敏记录并写 `diagnostics/last-fatal.json`（0600），保留 Node 原有退出行为。默认 Node 错误输出仍然存在，新增的是紧凑脱敏证据。

## 本地验收

- `npm run build`；`npm test`（105 项）。
- Node 24.18.0 容器运行 `src/sdkSafety.test.ts`：异常帧、被分离的通知拒绝、并发 processing 清理、重登及脱敏。
- `scripts/test-sdk-node-runtime.cjs` 在完整候选镜像内使用原生 Node WebSocket 和 loopback server：121 个合成账号连接，向一个账号注入非法帧后其余 120 个仍连接；故障账号重登后恢复 121。服务器同步被 stub，无真实业务/模型/计费调用；不等于真实生产文本、群聊、语音验收。
- Docker `openclaw/runtime-diagnostics.test.cjs` 验证致命异常保留 exit 1、脱敏文件权限、readyz 200/503；promtool 覆盖 8 类重启序列；amtool 检查真实生成模板，使用假密钥。

## 发布与剩余工作

本地镜像 `infiai2-local/openclaw-runtime:sdk-safety-20260923` 仅供验收，不是生产不可变发布标签。生产发布仍需正式 release-operator 范围审计、旧镜像/卷回滚保护、目标架构构建与真实业务验收，定向切换 runtime、监控与 Chat 告警格式，不能将 Chat 工作区其他未提交修改混入。

监控改为 reset-aware increase；连续重启规则增加非外推证据约束，避免两次被估算成三次。重建清零后同窗口又发生批量跳增、同时存在采集缺口时 critical 判定可能保守，warning 仍保留。容器销毁与重建之间完全未被采集的重启无法从 Docker 当前计数恢复。告警恢复只表示窗口清除；原生 readyz 依据 OpenClaw 账号健康缓存和启动状态，不等于业务请求端到端成功。

P1 待单独实施：确认未完成消息的实际发出结果，建立 Chat 持久执行/发送/扣费幂等与有限恢复、分层取消和总时限。现有证据不足以安全补发该条消息，不能以本补丁宣称已解决历史消息丢失或六分钟模型阻塞。P2 为进程/池隔离评估，禁止简单复制同账号消费者。
