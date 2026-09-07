# Codex App 接入边界

该适配器接入已有 App 任务，不启动第二个 app-server。它使用已核对版本的内部 IPC 与只读历史投影，属于实验性集成，不是承诺兼容的公开 API。

## 配置与路由

`codex.appSteering:true` 显式开启 App 路径，默认 false。实现读取目标任务的当前状态与工作目录，然后通过当前用户的 `~/.codex/ipc/ipc.sock` 发现 App owner：

- 已有活动轮：向 owner 提交 steer。
- 空闲任务：向 owner 提交 start。
- 开启 `appWake` 且任务未加载：通过 macOS 原生任务链接加载，重新读取忙闲状态，再提交；可能显示对应任务窗口。
- 未启用 App 路径：使用原生 `codex queue`，成功只表示排队。

带图片的 App 输入使用受支持的本地图片附件；其他文件保留明确的本地路径上下文。详见 `src/codex-queue.ts` 与 `src/codex-app-ipc.ts`。

## 本机 IPC

帧格式为四字节 little-endian UTF-8 payload 长度，随后为 JSON。客户端先用 `initialize` 注册，再调用 `thread-owner-discovery` 寻找目标任务 owner；向该 owner 提交当前版本对应的 `thread-follower-steer-turn` 或 `thread-follower-start-turn`。

请求的客户端标识、版本及 owner 路由均以实际初始化/发现回执为准。不能把其他 CLI daemon 可连接当作它拥有 App 任务，也不使用 App 专属工具的受保护通道替代此入口。

一旦业务输入已发出但回执丢失、超时或断线，结果视为不确定，不再自动 queue、唤醒后重投或另启执行器。只有明确尚未提交的情况才允许加载任务后再次尝试。停止观察时同样不能推断外部任务没有执行。

## 输出观察

### 同物理轮次的展示归属

App steer 的成功回执带 `clientUserMessageId`；观察器读到投影中匹配的
`userMessage.clientId` 后，才以它的原始 `rollout_ordinal` 建立新的展示边界。
同一物理 `turnId` 内，边界前创建的公开 item 继续引用原聊天消息，边界后的 item
才使用新聊天消息。重放、重启和晚到的旧 item 不会按到达顺序抢走新展示。Working
在 IPC 明确接受后即可切到新消息，但尚未跨过该边界的输出不会误归为新输入。

普通 `codex queue` 只有排队回执，没有 App 的 turn 接受或 `clientUserMessageId`
关联，不能被当作 steer 接受，也不能提供同物理轮次插入的上述保证；未启用 App
路径时，桥接仍按观察到的独立物理轮次呈现输出。

当前观察器锁定 Codex 0.153.x、paginated 历史模式及已核对的表结构。只读打开任务状态与历史 SQLite 数据库，提取公开消息、公开摘要，以及完成的生成图片路径；不修改 App 文件和数据库，不外发私有推理、工具输出或图片生成提示词。

初次接入建立历史基线；之后持久化游标和活动轮状态，避免重启后把旧输出再次发出。未知版本、结构变化和观察错误会停止新投递。App 版本升级后必须重新核对实现并运行相关测试。

独立的 Codex 输入适配命令在收到 App 提交回执后退出。Nerve 只记录这个接收结果，不追踪模型完成；聊天桥仍自行观察公开输出。`queued`、`started`、`completed` 是不同的证据，不能互相替代。

## 验证

源码入口：`src/codex-app-ipc.ts`、`src/codex-app-wake.ts`、`src/chat/codex.ts`、`src/codex-input.ts`、`src/codex-input-command.ts`。

测试覆盖分帧、owner 发现、活动/空闲路由、图片输入、超时不重投、未加载任务唤醒、公开输出隔离和游标恢复。已有真实任务的文本 start/steer、活动轮图片输入和一次未加载任务唤醒证据；完整 App 重启后的跨平台往返、各种附件及断网恢复仍需持续验收，见 [能力审计](chat-parity-audit.md)。
