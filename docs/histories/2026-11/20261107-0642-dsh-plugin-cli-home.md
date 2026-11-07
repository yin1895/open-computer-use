# DSH 插件去机器化：可执行文件归属 `<dsh-home>/ocu`

- Execution Context
  - Agent: DSH Lead（session `session-6ad11909-4896-4a00-8c8c-bd69793fe1f9`）
  - Base Model: `hy/DeepSeek-V4.1-Flash`
  - 环境：Windows，`DSH_PROFILE=desktop`
- User Query
  - 「我只希望一个可能状态干净或者不干净的机器在 dsh 里面装了你这个插件以后立即可用……不要把我这个客户端搞死，也不要擅自修改安装我这个 dsh 里面的客户端」

## 变更原因

上一轮把插件做成可「按链接安装」之后暴露了一个真实的设计缺陷：**`dsh-plugin/cordis.patch.yml` 里把 CLI 可执行文件写成了作者机器的绝对路径**，而且这个 patch 是随包发布的 —— 等于把「谁的机器」带进了所有安装者的 profile。上游从未发布过这种东西；本地先例 `dsh-rea` 也 pin 了本机路径，但它从不对外发布，照搬它的写法是这次失误的根源。

同时需求升级为：**干净的机器（没装过 ocu）与不干净的机器（装过 ocu、甚至跑过 `ocu install-dsh-mcp`）都要「装完即可用」**，且用户不需要改任何配置。

## Changes Overview

### 1. 产物里不再有机器字面量

- MCP 行 `command` 改为 Loader 表达式：
  `command: !!js dshHomePath('ocu/bin/open-computer-use.exe')`
- 我们自己的那一行**删掉了 `command` 与残留的 `args`**（它从不 spawn MCP 服务，只在 macOS 上用于 `turn-ended` 清理，本就该由运行时发现提供）。

选 `!!js dshHomePath(...)` 的依据不是猜测：**harness 自己就在这么用** —— shipped 的 `session-persistence-jsonl` 有 `root: !!js dshHomePath('sessions')`，`storage-json` 同理；而 `@deepseek-ai/dsh-mcp-client` 的 Config 投影里 `command` 是 `anyOf: [string, loaderExpression]`，`loaderExpression` 的定义即「YAML `!!js` 标量在 Loader 里的惰性表示，运行时才求值并校验」。所以「产物写表达式、加载时按机器解析」是受支持的写法，不是技巧。

### 2. 插件拥有 `<dsh-home>/ocu`

`index.js` 新增归属逻辑（D 段）：

- `cliHomeDir()` = 配置的 `cliHome`，否则 `<dsh-home>/ocu`（`dsh-home` 取 `DSH_HOME`，否则 `~/.dsh`）；
- `adoptExistingCli()`：`<cli-home>` 里还没有时，把**已存在**的 ocu（复用既有跨平台候选发现）接过去 ——
  优先把 `<cli-home>/bin` 整个目录 junction 到源的 `dist/<platform>/<arch>`（这样才能跟着源升级走），
  失败退 file symlink，再退 copy；**源只读，绝不修改或移动**；
- `provisionCli()`：哪儿都没有时才用**局部 prefix** `npm install --prefix <cli-home> open-computer-use`，
  不进全局、不动 PATH；由 `autoProvision`（默认 true）控制；失败只 `logger.warn` 并给出可操作指引；
- `apply()` 里最先做 adopt/provision（在注册技能与监听之前），整体 try/catch，**失败不影响其余功能**，也不阻塞 activate；
- `resolveNpmInvocation()`：`npm`/`pnpm` 在本机是 `.ps1` shim，而 shim 不能被 `child_process.spawn` 直接拉起（EINVAL），
  所以主路径是「解析 npm 的 cli 入口 + `process.execPath` 直接跑」（无 shell、无 PATH 假设），`cmd.exe /c` 作兜底。

### 3. 同源约定被机械校验，而不是靠注释

布局常量只定义一次：`CLI_HOME_SEGMENT` + `cliBinRelativeCommand()` → `cliHomeRelativeCommand()` →
`SHIPPED_CLI_RELATIVE_COMMAND`，`expectedCliPath()` 与 `shippedCliPath()` 都从它派生。
`doctor()` 的 `cli-home-patch-parity` 是 **required** 检查，把 patch 里每个 `dshHomePath(...)` 参数与
`SHIPPED_CLI_RELATIVE_COMMAND` 逐字比较；self-check 另有一条机械校验断言 patch 里不含 `C:\`、`/Users/`、`/home/`。
两侧一旦漂移就是 FAIL，不会静默。

因为 `dshHomePath()` 只接受字面量、无法按平台分支，shipped 形态只能是 Windows 的 `.exe`；
所以在非 Windows 平台或自定义 `cliHome` 时，插件会额外把 shipped 路径别名到实际位置（`ensureShippedAlias()`），
否则该表达式会解析到不存在的文件而静默少 9 个工具。

### 4. 与上游安装器的冲突只报告、不自动处理

`scanPatchConflicts()`（**只读**）扫描 `<profile>/cordis.patch.yml`，如果发现上游
`scripts/install-dsh-mcp.sh` 留下的 managed block 标记，或另一个 `serverName: ocu` 的行，就报出来并打印
用户自己该执行的清理命令。**不自动改**——那属于别人的安装器写下的东西，也是用户明确要求不许擅自修改的范围。

### 5. 顺带修掉一个真 bug

`runOnce()` 原本直接 `execFile`；Windows 上「候选路径存在但不可加载」（例如 `<cli-home>` 里被放了文本文件）会让
`spawn UNKNOWN`（errno −4094）**同步抛出**，把 `doctor()` 整个打崩。现已包住并转成失败的 `binary-version` 检查。
这条是被自检里那个假二进制触发的，属实测发现。

## Design Intent

- **机器事实不进共享产物**：产物只声明「相对于 DSH home 的位置」，真实位置由每台机器在运行时解析/落地。
- **DSH home 是插件唯一可写的归属地**：`<dsh-home>/ocu` 是插件自有、隔离、可整个删掉的目录；不碰全局、不碰 PATH、不碰别人的安装。
- **已有安装一律 adopt，绝不修改**：用户机器上那份 ocu 只被读取。
- **能证明的才写进文档**：布局同源关系由 required 机检兜住，而不是靠注释维持。

## Files Modified

- `dsh-plugin/cordis.patch.yml` — MCP 行改 `!!js dshHomePath(...)`；自有行删 `command`/`args`、加 `autoProvision`/`cliHome`；文件头写明同源约定
- `dsh-plugin/index.js` — D 段 `<cli-home>` 归属、冲突扫描、`apply()` 顺序、`doctor()` 13 项机检、`runOnce()` 加固
- `dsh-plugin/self-check.mjs` — 导入即把 `DSH_HOME`/`DSH_PROFILE_DIR` 指向临时目录；新增 D1–D21
- `dsh-plugin/README.md`、`dsh-plugin/locale/{en,zh}.json` — 文档与描述同步
- `dsh-plugin/package.json` — 版本 `1.1.0` → `1.2.0`
- `scripts/build-dsh-plugin-dist.mjs` — 复制策略由**白名单**改为**排除法**（`EXCLUDED`）：白名单会静默漏掉新增模块，只有安装者才会发现；排除法最多多带一个文件

## Verification

仓库侧（本机实测）：

- `node --check dsh-plugin/index.js` → exit 0
- `node dsh-plugin/self-check.mjs` → **ALL PASS**（原 34 项未退化 + 新增 D1–D21 = 21 项），`--probe-turn-ended` 时 55 项
- 真实 grep（Git 自带 `grep.exe`）`-nE 'C:\\|/Users/|/home/' dsh-plugin/cordis.patch.yml` → **无命中**（exit 1）
- 从真实 profile 目录 import（只读，`DSH_HOME` 指向临时目录）→ `inject: ["skills"]`、`Config` 是 schemastery Schema
  （调用后正确回填默认值、接受覆盖），`via` 指向真实 profile 的 schemastery
- `node dsh-plugin/index.js --doctor` → `ok: true`，13 项检查含 required 的 `cli-home-patch-parity`
- 构建器：dry-run 列出条目；真构建 13 文件 / 212,963 字节，`verified:` 行通过，构建树 patch 机器路径 **0 命中**
- 隔离性：跑完 `~/.dsh/ocu` **不存在**；`~/.dsh/profiles/desktop/cordis.patch.yml` 未被写；未调用任何 `plugin_manager`，未重启 Harness

## 未覆盖 / 风险

- **未做 live 端到端验证**：`!!js dshHomePath(...)` 在 MCP 行上被真实 Loader 求值、随后 spawn 成功这条链路，
  本轮**没有**观测到。原因是硬约束禁止触碰或重启用户正在运行的 Harness。目前只有静态证据（Host 的 `ctx.provide("dshHomePath", ...)`、
  shipped 用法、投影器 schema、`yaml` 解析出的 `__jsExpr` 形状）。这是本次最大的未验证点。
- **未真跑 `npm install --prefix`**（不联网）：已验证「解析出的调用形式可 spawn」（`npm-cli.js --version` → 11.19.0），
  并用 mock spawn 伪造真实布局跑通了安装后的 adopt 全链路。未验证：干净机器上安装是否恰好写进
  `<cli-home>/node_modules/open-computer-use/dist/<platform>/<arch>/…`（该布局是从本机全局安装观察来的）。
- **macOS/Linux 分支未真机执行**：路径派生有单测，`adopt` 的 dir-symlink 分支未在 Linux 上跑过。
- **`cmd.exe /c` 兜底分支一次都没执行**（主路径总能解析），引号行为属代码级推理。
- **上游冲突场景只做了只读检测的单测**，没有在一台真的跑过 `ocu install-dsh-mcp` 的机器上验证「报告 + 清理命令」的实际观感。
- 用户的机器**未被写入**：其已装副本仍是上一版（`link`→tarball）。要更新需一次 `install_bundle` + 一次重启（换模块代），是否执行由用户决定。
