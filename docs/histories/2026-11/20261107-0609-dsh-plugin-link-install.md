# DSH 插件：同步上游 + 支持按链接安装

- Execution Context
  - Agent: DSH Lead（session `session-6ad11909-4896-4a00-8c8c-bd69793fe1f9`）
  - Base Model: `hy/DeepSeek-V4.1-Flash`
  - 环境：Windows，`DSH_PROFILE=desktop`
- User Query
  - 「同步上游,做成可以直接根据链接安装」

## 变更原因

两件事：

1. fork（`yin1895/open-computer-use`）落后上游 11 个提交（截止 `1263960`，含 v1.1.4 发版、
   Windows 目标捕获/子控件点击、锁屏 Guardian 清理、`set_value` 跨平台校验、快照树预算等）。
2. `dsh-plugin/` 虽然是可安装的 bundle，但**只能按本地目录安装**：bundle 在仓库子目录里，
   而 DSH 从 spec 命中的那个 `package.json` 读取 `dsh.bundle.patch`，本仓库根目录的
   `package.json` 是 Open Computer Use 本体、不是 bundle，所以指向仓库根的 spec
   （`github:…`，或 `main` 的 tarball）会被判 `not-a-bundle`。

## Changes Overview

### 1. 同步上游

`git merge upstream/main`，无冲突（上游 11 个提交改动的 100 个文件与我们改动的 11 个文件交集为空）。
合并提交 `a42d6bd`，已推送 `1353e92..a42d6bd`。

上游改了 `skills/open-computer-use/references/usage.md`：本插件的技能是读 `SKILL.md` 正文 +
把技能目录作为 `resourceBase` 暴露、`references/*.md` 由模型按需读取，因此这份上游更新无需
任何代码改动即生效。

### 2. 技能路径支持两种布局

`index.js` 原来只认 `<bundle>/../skills/<name>`（仓库开发布局）。新增
`skillDirectoryCandidates()`：先看 `<bundle>/skills/<name>`（**独立安装**布局——bundle 被单独
解包，必须自带技能），再看仓库布局；`defaultSkillDirectory()` 返回第一个存在的目录，都不存在时
回落仓库布局，好让 `doctor` 仍能报出缺失路径。

### 3. 生成「根即 bundle」的独立树

新增 `scripts/build-dsh-plugin-dist.mjs`：把 bundle 文件复制到树根、把仓库的
`skills/open-computer-use` 复制进 `<tree>/skills/`，并在写出前**校验**这棵树可安装
（`package.json` 可解析、`dsh.bundle.patch` 存在且指向真实文件、入口与显示资源齐全、技能
`SKILL.md` 在、`index.js` 有导出）。任一项不过即非零退出，不产出坏树；拒绝写入源码树、
拒绝覆盖非空目录（除非 `--force`）。

该树发布在生成分支 `dsh-plugin-dist`，因此可按链接安装，无需 clone 或构建。

## Design Intent

- **一个产物服务两种布局**：不手工维护两份技能副本，dist 里的副本由脚本从仓库唯一来源复制。
- **生成分支而不是新仓库**：避免新建公开仓库，也避免两仓库间漂移；分支是纯产物、可随时重建，
  所以允许 force push。仓库既有的 `dsh-purge` 依赖就是同一形态（codeload tarball URL）。
- **构建器自我校验**：宁可构建失败，也不产出 DSH 会拒收的树——把「不是 bundle」挡在发布前，
  而不是让安装端去发现。

## Files Modified

- `dsh-plugin/index.js` — 新增 `skillDirectoryCandidates()`，`defaultSkillDirectory()` 取首个存在者
- `dsh-plugin/package.json` — 版本 `1.0.0` → `1.1.0`；`files` 增加 `skills`
- `dsh-plugin/README.md` — Install 拆为「按链接」与「按本地目录」；技能一节补两种布局对照
- `scripts/build-dsh-plugin-dist.mjs` — 新增
- `README.md` / `README.zh-CN.md` — DSH 插件段落补「按链接安装」
- 合并带入上游 11 个提交

## Verification

仓库侧（本机实测）：

- `node --check dsh-plugin/index.js` = exit 0；`node dsh-plugin/self-check.mjs` = **ALL PASS（34 项）**，
  其中 B7 仍验证技能缺失时的降级路径。
- 构建：13 文件 / 125,109 字节，自带 `verified:` 行；在构建树目录内跑它自己的 `self-check.mjs`
  → ALL PASS，技能从 `<tree>/skills/open-computer-use/SKILL.md` 注册成功。

链接侧（本机实测）：

- 匿名（未登录）`curl` 生成分支的 tarball → **HTTP 200**、39,298 字节；解压后**根目录即 bundle**
  （`name=@yin1895/dsh-open-computer-use`、`version=1.1.0`、`dsh.bundle.patch=./cordis.patch.yml`
  且文件存在，入口/图标/locale/自带技能齐全）。
- 在**解压出的字节**上跑 `self-check.mjs` → ALL PASS，技能从解压树自带的
  `skills/open-computer-use/SKILL.md` 注册成功。
- `plugin_manager install_bundle` 走该链接 → `application: "applied"`、`exitCode: 0`、
  `bundle=@yin1895/dsh-open-computer-use`、`version=1.1.0`、`warnings: []`。
  安装后 profile 依赖为
  `https://codeload.github.com/yin1895/open-computer-use/tar.gz/refs/heads/dsh-plugin-dist`，
  `node_modules/@yin1895/dsh-open-computer-use` 由软链变为**真实目录**，包内自带
  `skills/open-computer-use/SKILL.md` 与 3 个 `references/`。
- 安装后运行面：插件行与 `@deepseek-ai/dsh-mcp-client` 行均在（`status: schema`），
  `mcp__ocu__list_apps` 真实返回应用列表。

### 安装过程中遇到并解决的一个阻塞（与本插件无关）

首次按链接安装 `application: "failed"` / `kind: "build-blocked"`：pnpm 11 拦下了**另一个包**
`dsh-purge` 的 `postinstall`（`node scripts/ensure-profile-bundle.mjs`），该拦截会挡住这个
profile 里的**任何**包操作。pnpm 输出显示我们的包其实**已从链接解析并加入**
（`+ @yin1895/dsh-open-computer-use 1.1.0`），失败发生在之后的构建脚本阶段；失败的运行按约定
回滚了 `package.json` 与 `pnpm-lock.yaml`（已核实依赖回到 `link:`、插件行仍在、插件可正常调用）。

经用户明确批准后，以 `approvedBuilds` 重试：postinstall 正常执行并自报
`already in bundles` / `insert already in …cordis.patch.yml` / `allowed pnpm build for dsh-purge`，
安装即 `applied`。

**但该批准并未持久生效**：随后再执行任何安装，仍然报同一个 `ERR_PNPM_IGNORED_BUILDS`
（`pendingBuilds` 项不变），pnpm 自己的记录与 dsh-purge 的 `ensurePnpmAllowBuild` 都没有让拦截消失，
因此每次包操作都得重新传 `approvedBuilds`。这一点与插件管理器 README 的预期（「Approval persists
by package name in this profile」）不一致，属于本机 profile 的现状。

## 未覆盖 / 风险

- **同 URL 重发不会更新已安装副本**：branch tarball 按 URL 命中，spec 未变时 pnpm 判定
  `Already up to date`（`downloaded 0`），因此重发 `dsh-plugin-dist` 后，已安装的 profile 仍持有
  旧内容（实测：重发后已装副本的 README 不含新增段落）。要换内容需先 `remove_bundle` 再装。
- **代码换代需要重启**：替换已安装的包时，运行中的进程仍执行先前加载的模块代
  （`host-plugin.md`：「replacing an installed package requires restart to load a fresh JavaScript
  module generation」）。实测印证：安装后已安装副本自己的 `--doctor` 解析到
  `…\node_modules\@yin1895\dsh-open-computer-use\skills\open-computer-use`，但本会话技能目录里
  该技能的 `Base directory` 仍指向仓库路径 `D:\…\open-computer-use\skills\open-computer-use`
  （且 bundle 关→开时技能条目消失又重现，说明行确实重新激活过——只是模块代没换）。
  重启 Harness 后二者应一致。未擅自重启以免中断用户会话。
- **发布树 pin 了本机绝对路径**：`cordis.patch.yml` 两处 `command:` 指向本机 ocu 可执行，
  所以在别的机器上装完需要改这两处路径（或用 PATH 上的裸名）。已写入 `dsh-plugin/README.md`。
- 生成分支需随 `dsh-plugin/` 的改动重新发布，否则新装的人拿到旧代码；README 已写明重新发布流程。
- macOS 侧未在本机验证（本机为 Windows），与本插件既有结论一致。
- 若将来要发到 npm，需要去掉 `dsh-plugin/package.json` 的 `private: true`。
- dist 分支的树由 git 落盘，受全局 `core.autocrlf=true` 影响，行尾与本地构建树不同
  （LF vs CRLF）；功能上等价——自检正是在解压字节上跑过的。
