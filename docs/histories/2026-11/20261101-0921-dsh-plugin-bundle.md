## [2026-11-01 09:21] | Task: 把 DSH 接入层做成可安装插件包

### 🤖 Execution Context

- **Agent ID**: `session-98b94bac-49a1-47ea-96cd-8cc8f5eb17dd`（DSH 团队会话：lead 拆解，repo-curator 负责脚手架与仓库元数据，另一成员负责插件实现）
- **Base Model**: `DeepSeek-V4.1-Flash`（provider `huaiyuan`，reasoningEffort `max`）
- **Runtime**: DeepSeek Harness（Web GUI）

### 📥 User Query

> 上游的 DSH 接入是 `scripts/install-dsh-mcp.sh` 这种旁路做法——直接改父 profile 的 `cordis.patch.yml`、另写 `<dsh-home>/ocu-hooks.json` 挂 Stop hook、把 skill 复制到 `<dsh-home>/skills`。改成插件形态：在仓库里放一个可安装的 bundle，自己带 patch，父 profile 一行都不用动。

### 变更原因

原来的 DSH 接入把三样东西都写进用户机器：父 profile 的 patch、`<dsh-home>/ocu-hooks.json`、`<dsh-home>/skills/` 里的 skill 副本。它们不在仓库里，升级和卸载都要手工回收，也没法版本化。

这次改成仓库内的 bundle：插件自持 `cordis.patch.yml`，安装只动 profile 的依赖与 bundle 选择，卸载就是删掉 bundle，父 profile 的 patch 保持原样。

### 🛠 Changes Overview

**Scope:** 新增 `dsh-plugin/`；`README.md`、`README.zh-CN.md` 各加一段指引。

**Key Actions:**

- **新增 bundle 包**：`dsh-plugin/` 含 `package.json`（`@yin1895/dsh-open-computer-use`，`dsh.bundle.patch` 指向自带 patch）、`cordis.patch.yml`、`index.js`、`self-check.mjs`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`。
- **bundle 自带 patch 插入两行**：`open-computer-use`（本包 Host 侧）与 `open-computer-use-mcp`（`@deepseek-ai/dsh-mcp-client`，`serverName: ocu`、`transport: stdio`、绝对路径的 native 二进制、`failOnStartupError: false`）。父 profile 完全不碰。
- **插件行只负责三件事**：回合边界清理、skill 运行时注册（`ctx.skills.register`）、平台化可执行发现与诊断（`doctor()`）。
- **9 个工具不在插件里实现**：全部由 mcp-client 行提供，工具名是 `mcp__ocu__<tool>`；插件不实现任何工具、不实现 MCP 客户端，也不与 MCP 子进程通信。
- **`Config` 使用 `@deepseek-ai/schemastery` Schema**（裸 JSON Schema 不是本 harness 的形态），字段覆盖 command / args / env / cwd / serverName / toolCallTimeoutMs / enableTurnBoundaryHook / registerSkill / cursorCleanupCommand。
- **`self-check.mjs`**：用 mock Cordis context 驱动 `index.js`，断言三条职责的可观察行为，不需要 Harness、GUI 或活的 MCP 服务。
- **文档**：`dsh-plugin/README.md` 写清与 `scripts/install-dsh-mcp.sh` 的差异表、配置字段表、验证步骤与已知偏差；根 `README.md` / `README.zh-CN.md` 各加一段指向 `dsh-plugin/`。

### 🧠 Design Intent (Why)

- **两行而不是一行**：工具发现与进程拉起是 `@deepseek-ai/dsh-mcp-client` 的既有能力，插件重造没有收益；插件只补 MCP 客户端没有的两件事。`@deepseek-ai/dsh-mcp-client` 随 dsh 发布、必然可解析，所以插件包声明它不引入额外依赖。这个形态照抄了既有的生产级先例 `dsh-rea`。
- **`inject` 只有 `skills`**：本机 dsh 安装没有 `computerUse` provider 槽位的提供者，注入它会让插件直接不激活；`subprocess` 也不需要——清理命令是一次性短命令，用 `node:child_process` 才能自己管超时、grace 与 `killSignal`。
- **监听器必须全兜异常**：`agent/turn-stopping` 是 serial 事件且会被 await（宿主 Inspect 契约：`mode: 'serial'`、"Awaited before the boundary commits"），监听器抛错会把整个 turn 判为失败关闭。所以清理失败只记 `logger.warn`，绝不外抛。
- **Windows/Linux 是显式 no-op**：`turn-ended` 是 macOS-only 子命令，本机实测 native 二进制回 `unknown command: turn-ended` 且 `exit=1`；软件光标只存在于 macOS 的 `Open Computer Use.app`。因此这两平台不注册监听器、也不给 MCP 子进程发 `notifications/turn-ended`，回合收尾零开销。
- **schemastery 防御性加载**：模块解析锚定在插件文件自身目录，插件目录在 profile 之外时裸 specifier 会 `ERR_MODULE_NOT_FOUND`；于是先试裸 specifier，再经 `DSH_PROFILE_DIR` / `DSH_PROFILE` / `<dsh-home>` 回退到 profile 自己的 `node_modules`。
- **本地路径安装不解析 peer 依赖**：本地 checkout 安装得到 `link:` 依赖；刻意不解析 peer 依赖，避免把 schemastery 装进 profile 根造成版本遮蔽。

### 📁 Files Modified

- `dsh-plugin/package.json`（新增）
- `dsh-plugin/cordis.patch.yml`（新增）
- `dsh-plugin/index.js`（新增）
- `dsh-plugin/self-check.mjs`（新增）
- `dsh-plugin/locale/en.json`（新增）
- `dsh-plugin/locale/zh.json`（新增）
- `dsh-plugin/icon.svg`（新增，复用本仓库 MIT 授权的既有资产）
- `dsh-plugin/README.md`（新增）
- `README.md`
- `README.zh-CN.md`

### ✅ Verification

- 两次提交：`6b7a413`（脚手架）与 `fa638cf`（实现），均已推 main。
- `node --check` 覆盖 `index.js` 与 `self-check.mjs`，退出码 0。
- `node dsh-plugin/self-check.mjs`：A（回合边界，含 Darwin argv、Windows/Linux 平台跳过、失败不外抛）、B（skill 注册字段、`resourceBase` 目录、dispose 反注册）、C（schemastery 往返、按平台可执行发现、`doctor()`、patch 两行的 config 校验）全部 PASS。
- `agent/turn-stopping` 的 serial / awaited / 出错关闭 turn 的行为来自宿主 Inspect provider 的实时契约，不是推断。
- 安装后核对：父 profile 的 `cordis.patch.yml` 一行未动（`computer-use` / `ocu` 均无匹配）；profile 的 `package.json` 出现指向本地 checkout 的 `link:` 依赖；profile 的 `node_modules` 里有 `@deepseek-ai/schemastery`，没有 `@deepseek-ai/dsh-*`。
- 工具面：`mcp__ocu__*` 恰好 9 个（`click`、`drag`、`get_app_state`、`list_apps`、`perform_secondary_action`、`press_key`、`scroll`、`set_value`、`type_text`）；`mcp__ocu__list_apps` 端到端返回真实应用列表。
- skill：`open-computer-use` 经运行时注册后模型可见，`resourceBase` 指向仓库内的 `skills/open-computer-use`，没有向 `<dsh-home>/skills` 复制任何东西。
- 平台事实：native 二进制 `turn-ended` → `unknown command: turn-ended`，`exit=1`。

### ⚠️ 未覆盖 / 风险

- macOS 分支只做了参数级验证（本机是 Windows）：`turn-ended` 在 macOS 上的真实退出码、以及光标确实被收起，都没有在本机跑过。
- macOS / Linux 的可执行发现候选路径来自代码与单测，不是真机观测。
- 本记录写在实现之后，把脚手架与实现两次提交合并成一份 history；两次提交的作者元数据见 git 日志。
