# `dsh-plugin` — Open Computer Use for DeepSeek Harness

An installable DSH (DeepSeek Harness) bundle that puts the Open Computer Use
native tools into the current DSH profile.

Installing it inserts two rows and leaves the rest of the profile alone:

| Row id                  | Package                                   | Role                                                                                                                         |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `open-computer-use`     | `@yin1895/dsh-open-computer-use` (this dir) | Owns what the MCP client cannot do: turn-boundary cursor cleanup and skill registration.                                       |
| `open-computer-use-mcp` | `@deepseek-ai/dsh-mcp-client` (ships with dsh) | Spawns the Open Computer Use native stdio MCP server and publishes its nine tools to the model as `mcp__ocu__<tool>`.           |

`serverName: ocu` on the second row is what produces the `mcp__ocu__` prefix.

## Status: implemented

`index.js` loads, activates, and implements its three responsibilities:

- **A. Turn boundary** — subscribes to the serial `agent/turn-stopping` event and
  runs the cursor cleanup there, with a 5-second cap and per-turn de-duplication.
- **B. Skill registration** — registers `skills/open-computer-use` through
  `ctx.skills.register(...)` as a `runtime` skill, with the skill directory as
  its `resourceBase`.
- **C. Discovery and diagnostics** — resolves the native executable from config
  or per-platform candidates, logs one structured summary at activation, and
  exports `doctor()` plus `node index.js --doctor`.

The nine Computer Use tools are **not** implemented here; they come from row 2.
This plugin contains no MCP client and never talks to the MCP child process.

## Design choices

**`inject = ['skills']`.** Only the skill registry is a hard dependency. The row
does not inject `computerUse` (no package in this dsh installation provides that
service slot, so a hard dependency would fail activation), does not inject
`tools` (it registers no tool), and does not inject `subprocess`.

**Cleanup runs through `node:child_process`, not `ctx.subprocess`.** The cleanup
is a single short-lived command that must be trivial to reason about and
impossible to stall a turn with, so it uses `execFile(command, ['turn-ended'])`
with `timeout` + `killSignal: 'SIGKILL'`. That keeps `subprocess` out of `inject`
and removes the "spawn spec must be complete or it throws synchronously" failure
mode entirely. The trade-off is that the child is not tracked by the Harness
subprocess service; the 5-second timeout is what bounds it instead.

**Only `node:*` and `@deepseek-ai/schemastery` are imported.** No
`@deepseek-ai/dsh-*` package is imported, so module resolution does not depend on
the Harness installation layout.

**`Config` is a schemastery schema and is always exported.** Even with ten
fields, omitting it would leave the row without a renderable settings form.
`Config` validates exactly what `cordis.patch.yml` sets (verified in the
self-check, `C8`). If schemastery cannot be resolved the module still loads,
`Config` becomes `undefined`, `resolveConfig()` still applies `DEFAULT_CONFIG`,
and `apply()` logs the degradation.

## Platform behaviour (measured)

`turn-ended` is a **macOS-only** subcommand. On this Windows machine the native
binary answers:

```
$ "…\open-computer-use.exe" turn-ended
unknown command: turn-ended
… Open Computer Use for Windows / Usage: open-computer-use.exe [command] [options]
[exit 1]
```

Windows and Linux therefore have no software cursor to hide and no command to run,
so `enableTurnBoundaryHook` becomes an explicit no-op that says so once, in the
log, at activation:

```
[open-computer-use] turn-boundary hook skipped: platform=win32 — Windows has no
software cursor and no `turn-ended` subcommand. Nothing to clean up, so no
command is run.
```

The `agent/turn-stopping` listener is **not registered at all** on those
platforms, so turn teardown costs nothing. No notification is sent to the MCP
child process either: `notifications/turn-ended` and `computer_use/turn_ended`
are ignored / `-32601` on Windows, and the process stays alive.

On macOS the hook arms itself with `<command> turn-ended` (the app bundle's
`Contents/MacOS/OpenComputerUse` when discovery finds it, otherwise the
configured `command`). `cursorCleanupCommand` overrides this on every platform:
one token is treated as an executable and `turn-ended` is appended, several
tokens are used verbatim, quoting is honoured.

The listener can never close a turn. It swallows every failure — non-zero exit,
missing binary, timeout — and reports it through `logger.warn`, because the
serial `agent/turn-stopping` event is awaited and a throwing listener closes the
whole turn.

## Skill registration

`ctx.skills.register(...)` is called with exactly:

| Field          | Value                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| `name`         | `open-computer-use` (kebab-case, fixed so the name matches the old shell-script install) |
| `description`  | trigger-oriented, model-facing                                            |
| `whenToUse`    | one line on when the GUI path is the right tool                           |
| `content`      | the `SKILL.md` body, **without** the YAML front matter and **without** a `<skill_content>` wrapper (the registry adds it) |
| `source`       | `'runtime'`                                                               |
| `resourceBase` | `{ kind: 'directory', path: '<resolved skill directory>' }`                |

`invocation` and `provider` are deliberately **omitted**: the registry fills in
`{ modelInvocable: true, userInvocable: true }` and the reserved provider name
`runtime`. Because `resourceBase` is a real directory, the model sees
`Base directory for this skill: <path>` and the relative links inside `SKILL.md`
(`references/usage.md`, `references/troubleshooting.md`, …) resolve to real files
— nothing is copied into `<dsh-home>/skills`.

`skillDirectoryCandidates()` resolves that directory against both layouts, nearest
first, and picks the first one that exists:

| Layout | Skill location | Produced by |
| ------ | -------------- | ----------- |
| Installed bundle | `<bundle>/skills/open-computer-use` | a link/tarball install — the bundle is unpacked on its own, so it carries its own copy |
| This repository | `<bundle>/../skills/open-computer-use` | developing `dsh-plugin/` inside this checkout |

One artifact therefore serves both, and an install needs no repository around it.
Nothing is duplicated by hand: `scripts/build-dsh-plugin-dist.mjs` copies the
repository's `skills/open-computer-use` into the published tree.

Reading `SKILL.md` is asynchronous while `register()` is synchronous, so the
registration is owned by `ctx.effect`: disposing the row unregisters the skill,
including when disposal races the file read.

## Install

Both routes end in the same plugin; pick by what you have.

### From a link

A bundle is resolved from the `package.json` that a spec names, so the bundle must
be the **root** of whatever the link points at. In this repository the bundle sits
in `dsh-plugin/` while the root `package.json` is Open Computer Use itself — which
is why a spec aimed at the repository root (`github:yin1895/open-computer-use`, or a
tarball of `main`) resolves to a non-bundle and DSH rejects it as `not-a-bundle`.

`scripts/build-dsh-plugin-dist.mjs` materializes a tree whose root *is* the bundle,
copies the skill inside it, and refuses to emit a tree DSH would reject. That tree
is published on the generated branch `dsh-plugin-dist`, so installing needs no
checkout and no build:

```
plugin_manager { action: "install_bundle",
                 target: "https://codeload.github.com/yin1895/open-computer-use/tar.gz/refs/heads/dsh-plugin-dist" }
```

Republishing after a bundle change — the branch is generated, never edit it by hand:

```sh
OUT=$(mktemp -d)
node scripts/build-dsh-plugin-dist.mjs --out "$OUT" --force
git -C "$OUT" init -q && git -C "$OUT" add -A
git -C "$OUT" -c user.name=build -c user.email=build@local commit -qm "build: dsh-plugin dist"
git -C "$OUT" push --force https://github.com/yin1895/open-computer-use.git HEAD:refs/heads/dsh-plugin-dist
```

Read the `verified:` line and the file list the script prints before pushing; the
commit message is irrelevant, the tree is the artifact.

**Portability.** `cordis.patch.yml` pins the native binary as an absolute path —
twice, once for this row's `command` and once for the MCP row. That is deliberate
(a GUI or background launch does not necessarily inherit `PATH`, so a bare name is
less reliable), but it means the published tree is tuned for the machine that built
it. On another machine, edit those two `command:` lines after installing, or set them
to a bare `open-computer-use` when it is on the Harness process's `PATH`. Both rows
carry `failOnStartupError`-style tolerance — the MCP row is `false` and this row only
logs — so a wrong path leaves the nine tools absent instead of breaking the profile.

### From this checkout

1. Make sure a native Open Computer Use binary exists (the global npm install
   provides one), for example on Windows:

   ```
   C:\Users\Administrator\AppData\Local\nvm\v24.21.0\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe
   ```

2. Point the DSH Plugin Manager at the absolute path of `dsh-plugin/`, **not** the
   repository root. `install_bundle` performs the package installation and bundle
   selection; do not reproduce those steps with shell commands. Read its returned
   `application` and `warnings` fields to decide whether the change is live.

3. The bundle declares no build script, so `approvedBuilds` should stay empty.
   Re-installing after a JavaScript change requires a Harness restart to load a
   fresh module generation.

A checkout install is saved as a `link:` dependency, so edits to `dsh-plugin/` take
effect without reinstalling; a link install is a frozen copy that local edits never
reach. Installing one replaces the other, in either direction.

## Difference from `scripts/install-dsh-mcp.sh`

Both paths end up with the same nine tools; they differ in who owns the profile.

| | `scripts/install-dsh-mcp.sh` | `dsh-plugin/` (this bundle) |
| --- | --- | --- |
| What it writes | Edits the parent profile's `cordis.patch.yml` in place, inside managed markers | Declares its own `cordis.patch.yml`; the parent profile is never touched |
| Row ownership | The profile owns the MCP row | The bundle owns both rows |
| Uninstall | Re-edit the profile patch by hand | Remove the bundle |
| Versioning | Lives in the checkout that ran it | A versioned package with a manifest, locale and icon |
| Turn-boundary hook | Writes `~/.dsh/ocu-hooks.json` and a matching patch row, plus a `@deepseek-ai/dsh-hooks-codex` `Stop` hook that shells out to `ocu turn-ended` | `enableTurnBoundaryHook`: the plugin subscribes to `agent/turn-stopping` itself, so no hook package and no `turn-ended` process on platforms that lack the subcommand |
| Skill | Copies `skills/open-computer-use` into `<dsh-home>/skills` | `registerSkill`: in-memory `ctx.skills.register(...)`, nothing copied |
| Provider slot | Generic MCP compatibility path | Same generic MCP path — neither path reserves a first-class computer-use provider slot |

## Configuration

`config` is **replaced, not deep-merged** (重要：`config` 是整体替换，不做深合并).
An override that matches the row id replaces the whole `config` mapping, so
repeat every field you want to keep. A partial `config` silently drops the rest.

Row `open-computer-use` (`index.js`, `Config`):

| Field                   | Type    | Default  | Meaning                                                                                      |
| ----------------------- | ------- | -------- | -------------------------------------------------------------------------------------------- |
| `command`               | string  | `''`     | Absolute path to the native binary. Empty triggers per-platform discovery. A bare PATH name is not reliable for a GUI launch. |
| `args`                  | array   | `['mcp']` | Mirror of the MCP row's args; informational for this row.                                     |
| `env`                   | object  | `{}`     | Extra environment variables, merged over `process.env` for the cleanup call.                   |
| `cwd`                   | string  | `''`     | Working directory for the cleanup call; empty means `process.cwd()`.                          |
| `serverName`            | string  | `'ocu'`  | MCP server name, and therefore the `mcp__<serverName>__<tool>` prefix; must match the MCP row. |
| `toolCallTimeoutMs`     | number  | `60000`  | Mirror of the MCP row's per-tool-call timeout; informational for this row.                     |
| `enableTurnBoundaryHook`| boolean | `true`   | Run the cursor cleanup at each turn boundary (macOS) / log the skip (Windows, Linux).          |
| `registerSkill`         | boolean | `true`   | Register the bundled Open Computer Use skill.                                                 |
| `cursorCleanupCommand`  | string  | `''`     | Optional override for the cursor cleanup invocation; empty selects the platform default.       |

Discovery order when `command` is empty (first existing, executable file wins):

1. `<dirname(node)>/node_modules/open-computer-use/dist/<platform>/<arch>/…`
2. Windows: `<LOCALAPPDATA>\nvm\<version>\node_modules\…`, `<APPDATA>\npm\node_modules\…`,
   `<ProgramFiles>\nodejs\node_modules\…`
3. macOS: `~/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse`,
   `/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse`
4. Linux: same `node_modules` layout under `dist/linux/<arch>/open-computer-use`
5. Last resort only if everything above missed: `npm root -g` (3 s timeout)

Row `open-computer-use-mcp` (`@deepseek-ai/dsh-mcp-client`) accepts
`serverName`, `transport`, `command`, `args`, `env`, `cwd`,
`toolCallTimeoutMs`, `failOnStartupError`, `maxInstructionBytes` and
`reconnect`. Only the first five plus `failOnStartupError` are set here, and
`failOnStartupError: false` is deliberate: a missing or broken Open Computer Use
keeps the Harness startable, with the tools simply absent, instead of rejecting
activation for the whole profile.

## Verification

1. **Rows.** The Plugin Manager lists `open-computer-use` and
   `open-computer-use-mcp`, both from `@yin1895/dsh-open-computer-use`, with the
   title and description from `locale/en.json` / `locale/zh.json`. Installation
   and row presence alone do not prove the capability works.
2. **Tools.** The agent's tool inventory contains exactly these nine
   `mcp__ocu__*` entries, and no more (also returned by `doctor()` as
   `expectedMcpTools`):

   ```
   mcp__ocu__click
   mcp__ocu__drag
   mcp__ocu__get_app_state
   mcp__ocu__list_apps
   mcp__ocu__perform_secondary_action
   mcp__ocu__press_key
   mcp__ocu__scroll
   mcp__ocu__set_value
   mcp__ocu__type_text
   ```

3. **Round trip.** A read-only call such as `mcp__ocu__list_apps` returns the
   live application list.
4. **Turn boundary.** On macOS, trigger an action that draws the software cursor
   (for example `mcp__ocu__click`), then end the turn: the cursor must be gone
   and the log must show `turn N: cursor cleanup ok`. On Windows/Linux the log
   must show the platform skip instead. This is the one behaviour the generic
   MCP path cannot provide on its own.
5. **Skill.** Load the `open-computer-use` skill: the body comes back, and the
   resource hint names `<repo>/skills/open-computer-use` as the base directory.
6. **Native prerequisites.** `open-computer-use doctor` reports the platform and
   permission state for the native binary.

## Self-check

`self-check.mjs` drives `index.js` with a mock Cordis context and asserts the
observable behaviour of both dependencies and all three responsibilities. It
needs no Harness, no GUI and no live MCP server, and it is the evidence behind
the claims above.

```console
$ cd D:\cyber_workspace\projects\open-computer-use
$ node --check dsh-plugin/index.js ; echo $?
0

$ node --check dsh-plugin/self-check.mjs ; echo $?
0

$ node dsh-plugin/self-check.mjs --probe-turn-ended
platform=win32 arch=x64 node=v24.21.0
PASS import-module-exports — exports=Config, DEFAULT_CONFIG, EXPECTED_MCP_TOOLS, MODULE_DIR, …, apply, …, inject, …, name, …
PASS import-schemastery-config — export const Config is present (required for the settings form)

=== C. configuration / discovery ===
PASS C1-doctor-ok — command=C:\nvm4w\nodejs\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe via discovered
PASS C2-doctor-command-version — 1.1.3
PASS C3-turn-ended-platform-claim — exit=1 unknown command: turn-ended
PASS C4-discovery — C:\nvm4w\nodejs\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe (discovered)
PASS C5-macos-candidates — C:/Users/Administrator/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse | /Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse | …
PASS C6-linux-candidates — C:/nvm4w/nodejs/node_modules/open-computer-use/dist/linux/amd64/open-computer-use
PASS C7-config-merged — defaults+override ok
PASS C8-patch-row-config-validates — {"command":"C:\\Users\\…\\open-computer-use.exe","args":["mcp"],"env":{},"cwd":"","serverName":"ocu","toolCallTimeoutMs":60000,"enableTurnBoundaryHook":true,"registerSkill":true,"cursorCleanupCommand":""}
PASS C9-mcp-row-uses-shipped-client — @deepseek-ai/dsh-mcp-client serverName=ocu failOnStartupError=false
PASS C10-patch-rows-count — insert rows: open-computer-use, open-computer-use-mcp

=== A. turn boundary ===
PASS A1-darwin-argv — {"argv":["/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse","turn-ended"],"source":"default",…}
PASS A2-windows-skip — {"source":"platform-skip","reason":"Windows has no software cursor and no `turn-ended` subcommand"}
PASS A3-linux-skip — {"source":"platform-skip",…}
PASS A4-override-single-token — {"argv":["/opt/my-cleanup","turn-ended"],"source":"cursorCleanupCommand",…}
PASS A5-override-quoted-full-command — ["C:\\Program Files\\x\\clean.exe","--quiet","a b"]
PASS A6-apply-platform-decision — platform=win32 listener=false | [open-computer-use] turn-boundary hook skipped: platform=win32 — …
PASS A7-skill-registered-through-apply — registrations=1 logs=… skill registered: open-computer-use (6359 bytes) from …\SKILL.md
PASS A8-summary-log — [open-computer-use] summary platform=win32 arch=x64 serverName=ocu toolPrefix=mcp__ocu__ tools=9 command=… turnBoundary=skipped on platform=win32 (platform-skip) skill=registering from … schemastery=…\lib\index.mjs
PASS A9-cleanup-success — turn 7: cursor cleanup ok
PASS A10-cleanup-failure-reported-not-thrown — turn 8: cursor cleanup exit=3 boom
PASS A11-cleanup-timeout-bounded — elapsed=450ms logs=turn 9: cleanup timed out after 400ms
PASS A12-concurrent-dedup — turn 11: cleanup already in flight; skipped
PASS A13-missing-binary-reported-not-thrown — turn 12: cursor cleanup exit=null ENOENT: spawn Z:\does\not\exist.exe ENOENT
PASS A14-real-binary-turn-ended — turn 13: cursor cleanup exit=1 unknown command: turn-ended …

=== B. skill registration ===
PASS B1-skill-read-ok — {"ok":true,"name":"open-computer-use","directory":"…\\skills\\open-computer-use","bytes":6719,"contentBytes":6359}
PASS B2-register-called-with-required-fields — name=open-computer-use description.length=260 content.length=6359
PASS B3-source-and-resource-base — source=runtime resourceBase={"kind":"directory","path":"…\\skills\\open-computer-use"}
PASS B4-invocation-and-provider-omitted — invocation=undefined provider=undefined
PASS B5-content-is-body-only — startsWith="# Open Computer Use\r\n\r\n## Over"
PASS B6-disposal-unregisters — unregistered=["open-computer-use"]
PASS B7-missing-skill-file-degrades — ok=false warn=skill registration skipped: ENOENT: …
PASS B8-apply-without-skills-service-degrades — [open-computer-use] `skills` service is unavailable; …

=== verdict ===
ALL PASS
$ echo $?
0
```

The full report on one command, without a Harness:

```console
$ node dsh-plugin/index.js --doctor --probe-turn-ended
{
  "ok": true,
  "platform": "win32",
  "schemastery": { "resolved": true, "via": "C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai\\schemastery\\lib\\index.mjs" },
  "inject": ["skills"],
  "toolPrefix": "mcp__ocu__",
  "expectedMcpTools": ["mcp__ocu__click", "…", "mcp__ocu__type_text"],
  "command": "C:\\nvm4w\\nodejs\\node_modules\\open-computer-use\\dist\\windows\\amd64\\open-computer-use.exe",
  "commandSource": "discovered",
  "turnBoundary": { "enabled": true, "source": "platform-skip", "reason": "Windows has no software cursor and no `turn-ended` subcommand" },
  "checks": [
    { "id": "command", "ok": true, … },
    { "id": "command-executable", "ok": true, … },
    { "id": "binary-version", "ok": true, "detail": "1.1.3" },
    { "id": "turn-ended-subcommand", "ok": false, "detail": "exit=1 unknown command: turn-ended …", "required": false },
    { "id": "skill-file", "ok": true, … },
    { "id": "skill-content", "ok": true, "detail": "6719 bytes" },
    { "id": "skill-references", "ok": true, … },
    { "id": "turn-boundary", "ok": true, "detail": "no-op: Windows has no software cursor and no `turn-ended` subcommand", "required": false }
  ]
}
```

Importing the module the way the Harness does, from the profile directory:

```console
$ cd C:\Users\Administrator\.dsh\profiles\desktop
$ node --input-type=module -e "const m = await import('file:///D:/cyber_workspace/projects/open-computer-use/dsh-plugin/index.js'); console.log('inject:', JSON.stringify(m.inject)); console.log('Config:', typeof m.Config); console.log('via:', (await m.doctor({})).schemastery.via)"
inject: ["skills"]
Config: function
via: C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery\lib\index.mjs
```

The YAML is parsed with the `yaml` package bundled in a DSH profile, which
proves the document is valid YAML and shows exactly what the Loader will read:

```console
$ node -e "const yaml=require('C:/Users/Administrator/.dsh/profiles/desktop/node_modules/yaml'); \
  const fs=require('fs'); \
  console.log(JSON.stringify(yaml.parse(fs.readFileSync('dsh-plugin/cordis.patch.yml','utf8')),null,2))"
[
  {
    "insert": [
      {
        "id": "open-computer-use",
        "name": "@yin1895/dsh-open-computer-use",
        "config": {
          "command": "C:\\Users\\Administrator\\AppData\\Local\\nvm\\v24.21.0\\node_modules\\open-computer-use\\dist\\windows\\amd64\\open-computer-use.exe",
          "args": ["mcp"],
          "serverName": "ocu",
          "toolCallTimeoutMs": 60000,
          "enableTurnBoundaryHook": true,
          "registerSkill": true,
          "cursorCleanupCommand": ""
        }
      },
      {
        "id": "open-computer-use-mcp",
        "name": "@deepseek-ai/dsh-mcp-client",
        "config": {
          "serverName": "ocu",
          "transport": "stdio",
          "command": "C:\\Users\\Administrator\\AppData\\Local\\nvm\\v24.21.0\\node_modules\\open-computer-use\\dist\\windows\\amd64\\open-computer-use.exe",
          "args": ["mcp"],
          "failOnStartupError": false
        }
      }
    ]
  }
]
```

No third row is needed: row 2 is the whole tool integration, and row 1 adds only
the two behaviours the MCP client does not have.

## Known deviations and gotchas

1. **Bare `@deepseek-ai/schemastery` does not always resolve.** Module
   resolution is anchored to *this file's* directory, not to the working
   directory, so a plugin directory outside the profile tree fails on the bare
   specifier even though the package is installed in the profile:

   ```
   $ node -e "import('@deepseek-ai/schemastery')"   # run from a file in dsh-plugin/
   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
     imported from D:\cyber_workspace\projects\open-computer-use\dsh-plugin\index.js
   ```

   `loadSchemastery()` therefore tries the bare specifier first (the normal case
   once the bundle is installed *inside* the profile) and then the profile's own
   `node_modules` via `DSH_PROFILE_DIR` / `DSH_PROFILE` / `~/.dsh`, preferring the
   `.mjs` entry so the Loader and this plugin share one build. Measured fallback
   path: `…\profiles\desktop\node_modules\@deepseek-ai\schemastery\lib\index.mjs`.
2. **Discovery can pick a different install than the pinned path in
   `cordis.patch.yml`.** On this machine `<dirname(node)>/node_modules` contains
   a 1.1.3 install at `C:\nvm4w\nodejs\node_modules\…`, while the patch pins
   `…\AppData\Local\nvm\v24.21.0\node_modules\…`. Both report version `1.1.3`.
   Config wins over discovery, so the patch value is what runs; discovery only
   matters when `command` is empty.
3. **`inject: ['skills']`, not `['skills', 'tools']`.** The reconnaissance anchor
   (`recon/dsh-host-api.md`, §9) suggested `tools` as well; this row registers no
   tool, and adding it would only widen the activation dependency.
4. **`agent/turn-stopping` failures close the turn.** The event is serial and
   awaited, and a throwing listener ends the turn, so the listener catches
   everything. `A10`–`A14` in the self-check pin that down.
5. **Windows/Linux: no cursor, no command.** `turn-ended` does not exist there
   (verified: `exit=1 unknown command: turn-ended`), and `notifications/turn-ended`
   sent to the MCP process is ignored, so the plugin does neither.

## Icon

`icon.svg` is copied verbatim from
[`plugins/open-computer-use/assets/open-computer-use.svg`](../plugins/open-computer-use/assets/open-computer-use.svg)
in this same repository, which is released under the [MIT licence](../LICENSE)
— original artwork, redistributable, and no external URL is referenced. It is
872 bytes, well under the 256 KiB limit, and the package exports it as `./icon`.

## 中文说明

这个目录是 DSH 插件包，装上之后会把 Open Computer Use 的 9 个 native 工具接进当前
profile：工具名是 `mcp__ocu__*`，由 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 拉起
native stdio MCP 服务提供；回合边界清理与技能注册则由本插件负责。9 个工具、MCP 客户端
都不在本包里实现。

它替换的是 `scripts/install-dsh-mcp.sh` 那种「直接改父 profile 的
`cordis.patch.yml`」的做法：本包自带 patch，父 profile 一行都不用动，卸载时把 bundle
删掉即可。

本插件负责的三件事：

- **A. 回合边界**：监听 `agent/turn-stopping`（serial、会被 await），在回合收尾点执行
  光标清理；5 秒上限、同轮不重复触发、任何失败只 `logger.warn`，绝不让收尾抛错。
  **`turn-ended` 只有 macOS 有**，Windows/Linux 上改为一次性日志说明已跳过，且不注册
  监听器，也不往 MCP 进程补发任何通知。
- **B. 技能**：用 `ctx.skills.register(...)` 内嵌注册 `skills/open-computer-use`，
  `source: 'runtime'`，`resourceBase` 指向真实目录，因此 `SKILL.md` 里的
  `references/*.md` 相对路径能被直接读到——不需要往 `<dsh-home>/skills` 复制任何东西。
- **C. 发现与诊断**：`command` 为空时按平台自动发现 native 可执行文件；启动打一条结构化
  摘要日志；`doctor()` / `node index.js --doctor` 给出可机检的自检报告。

两处容易踩的坑：

- `config` 是**整体替换**，不是深合并；只写一半字段会把手里的另一半丢掉。
- `command` 必须是**绝对路径**。PATH 上的 `ocu` / `open-computer-use` 是 `.ps1` / `.cmd`
  shim，GUI 或后台启动不保证继承 PATH。

**装法有两种**：给 `install_bundle` 一个**链接**（生成分支 `dsh-plugin-dist` 的 tarball 地址，
见上面 Install 一节），或者给一个**本地目录**（本仓库的 `dsh-plugin/`）。前者是冻结副本，
后者是 `link:` 依赖、改完即时生效。DSH 要求被指向的 `package.json` 自己声明
`dsh.bundle.patch`——本仓库根目录是 ocu 本体、不是 bundle，所以指向仓库根会被判
`not-a-bundle`，这就是需要那个生成分支的原因。

验证：`node dsh-plugin/self-check.mjs --probe-turn-ended`（当前 34 项检查全部 PASS，退出码 0）。
