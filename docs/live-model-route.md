# 本地 OpenCode ds 路由

配置命令：

```sh
node scripts/configure-live-model.mjs /path/to/aigc
node scripts/live-model-smoke.mjs
```

复用 aigc 的 OpenCode Go Chat Completions 地址与 `OPENCODE_API_KEY` 来源，模型为 `deepseek-v4.1-flash`。配置只在被 Git 忽略的 `.deps/live-model/` 中保存凭据文件引用；启动时读取该文件，将单个密钥注入 DSH 子进程，不复制整个环境文件。

`scripts/dsh.mjs --profile live` 自动附加路由补丁。其他 profile 和 plugin 管理命令保持原行为。缺失凭据时启动失败，不回退到另一个付费供应商。删除 `.deps/live-model/route.json` 可恢复原路由。

通过已安装的 DSH pi-ai 适配器接入，不把 Chat Completions 地址交给仅支持 Anthropic Messages 的原 DeepSeek 适配器。每次启动生成 `x-opencode-session` 头。默认模型档位 low；主播与导播沿用现有快速回复逻辑，使用 off。关闭该路由的自动重试和直播 session 自动命名。

短验证使用与舞台相同的 DSH LLM 服务及适配器，最多两次请求，每次最多 256 个输出 token、20 秒超时；首项失败后不继续。不会启动四岗位、语音或房间订阅。此上限只约束短验证，不是整场直播的预算保护。

2026-11-06 本机验证：普通文本成功，1828ms，38 输入 / 25 输出 token；工具调用成功，2587ms，312 输入 / 57 输出 token。两项均使用 low，通过真实服务返回 usage。耗时包含网络与模型处理，不代表直播接话耗时，也不代表账户价格或账单。

长期直播的空闲巡场频率和共享预算仍需单独控制；切换供应商本身不会解决空转调用。目前保持大脑停止，未开启长时间试播。
