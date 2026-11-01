# `dsh-plugin` — Open Computer Use for DeepSeek Harness

An installable DSH (DeepSeek Harness) bundle that puts the Open Computer Use
native tools into the current DSH profile.

Installing it inserts two rows and leaves the rest of the profile alone:

| Row id                  | Package                                   | Role                                                                                                                         |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `open-computer-use`     | `@yin1895/dsh-open-computer-use` (this dir) | Owns what the MCP client cannot do: turn-boundary cursor cleanup and skill registration.                                       |
| `open-computer-use-mcp` | `@deepseek-ai/dsh-mcp-client` (ships with dsh) | Spawns the Open Computer Use native stdio MCP server and publishes its nine tools to the model as `mcp__ocu__<tool>`.           |

`serverName: ocu` on the second row is what produces the `mcp__ocu__` prefix.

## Status: scaffold

`index.js` loads and activates, validates and resolves its configuration, and
wires nothing yet — every extension point is marked `TODO(impl)`. The tools
themselves already work through the `open-computer-use-mcp` row, which depends
on nothing in this package.

## Install

1. Make sure a native Open Computer Use binary exists (the global npm install
   provides one), for example on Windows:

   ```
   C:\Users\Administrator\AppData\Local\nvm\v24.21.0\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe
   ```

2. Point the DSH Plugin Manager at this directory — the absolute path of
   `dsh-plugin/`, not the repository root. `install_bundle` performs the package
   installation and bundle selection; do not reproduce those steps with shell
   commands. Read its returned `application` and `warnings` fields to decide
   whether the change is live.

3. The bundle declares no build script and no dependency, so `approvedBuilds`
   should stay empty. Re-installing after a JavaScript change requires a Harness
   restart to load a fresh module generation.

## Difference from `scripts/install-dsh-mcp.sh`

Both paths end up with the same nine tools; they differ in who owns the profile.

| | `scripts/install-dsh-mcp.sh` | `dsh-plugin/` (this bundle) |
| --- | --- | --- |
| What it writes | Edits the parent profile's `cordis.patch.yml` in place, inside managed markers | Declares its own `cordis.patch.yml`; the parent profile is never touched |
| Row ownership | The profile owns the MCP row | The bundle owns both rows |
| Uninstall | Re-edit the profile patch by hand | Remove the bundle |
| Versioning | Lives in the checkout that ran it | A versioned package with a manifest, locale and icon |
| Turn-boundary hook | Writes `~/.dsh/ocu-hooks.json` and a matching patch row | Plugin-owned (`enableTurnBoundaryHook`); not implemented yet |
| Skill | Copies `skills/open-computer-use` into `<dsh-home>/skills` | Plugin-owned registration (`registerSkill`); not implemented yet |
| Provider slot | Generic MCP compatibility path | Same generic MCP path — neither path reserves a first-class computer-use provider slot |

## Configuration

`config` is **replaced, not deep-merged** (重要：`config` 是整体替换，不做深合并).
An override that matches the row id replaces the whole `config` mapping, so
repeat every field you want to keep. A partial `config` silently drops the rest.

Row `open-computer-use` (`index.js`, `Config`):

| Field                   | Type    | Default  | Meaning                                                                                      |
| ----------------------- | ------- | -------- | -------------------------------------------------------------------------------------------- |
| `command`               | string  | `''`     | Absolute path to the native binary. A bare PATH name is not reliable for a GUI launch.        |
| `args`                  | array   | `['mcp']` | Arguments passed to `command`.                                                               |
| `env`                   | object  | `{}`     | Extra environment variables for the child process.                                            |
| `cwd`                   | string  | `''`     | Working directory; empty means the Harness default.                                           |
| `serverName`            | string  | `'ocu'`  | MCP server name, and therefore the `mcp__<serverName>__<tool>` prefix; must match the MCP row. |
| `toolCallTimeoutMs`     | number  | `60000`  | Per-tool-call timeout in milliseconds.                                                        |
| `enableTurnBoundaryHook`| boolean | `true`   | Hide the software cursor at each turn boundary.                                               |
| `registerSkill`         | boolean | `true`   | Register the bundled Open Computer Use skill.                                                 |
| `cursorCleanupCommand`  | string  | `''`     | Optional override for the cursor cleanup invocation; empty uses the built-in default.          |

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
   `mcp__ocu__*` entries, and no more:

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
4. **Turn boundary.** Trigger an action that draws the software cursor (for
   example `mcp__ocu__click`), then end the turn: the cursor must be gone. This
   is the one behaviour the generic MCP path cannot provide on its own.
5. **Native prerequisites.** `ocu doctor` reports the platform and permission
   state for the native binary.

## Icon

`icon.svg` is copied verbatim from
[`plugins/open-computer-use/assets/open-computer-use.svg`](../plugins/open-computer-use/assets/open-computer-use.svg)
in this same repository, which is released under the [MIT licence](../LICENSE)
— original artwork, redistributable, and no external URL is referenced. It is
872 bytes, well under the 256 KiB limit, and the package exports it as `./icon`.

## Self-check

Run from the repository root. Expected output is shown as observed.

```console
$ node --check dsh-plugin/index.js
$ echo $?
0

$ node -e "JSON.parse(require('fs').readFileSync('dsh-plugin/package.json','utf8')); console.log('package.json OK')"
package.json OK

$ node -e "for (const f of ['dsh-plugin/locale/en.json','dsh-plugin/locale/zh.json']) { const j=JSON.parse(require('fs').readFileSync(f,'utf8')); console.log(f,'OK', j.meta.title) }"
dsh-plugin/locale/en.json OK Open Computer Use
dsh-plugin/locale/zh.json OK Open Computer Use

$ node --input-type=module -e "const m = await import('./dsh-plugin/index.js'); console.log('exports:', Object.keys(m).join(', ')); console.log('inject:', JSON.stringify(m.inject)); console.log('apply type:', typeof m.apply)"
exports: Config, DEFAULT_CONFIG, apply, inject, resolveConfig
inject: ["skills","subprocess"]
apply type: function
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

## 中文说明

这个目录是 DSH 插件包，装上之后会把 Open Computer Use 的 9 个 native 工具接进当前
profile：工具名是 `mcp__ocu__*`，由 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 拉起
native stdio MCP 服务提供；进程、回合边界和技能注册则由本插件负责。

它替换的是 `scripts/install-dsh-mcp.sh` 那种「直接改父 profile 的
`cordis.patch.yml`」的做法：本包自带 patch，父 profile 一行都不用动，卸载时把 bundle
删掉即可。

两处容易踩的坑：

- `config` 是**整体替换**，不是深合并；只写一半字段会把手里的另一半丢掉。
- `command` 必须是**绝对路径**。PATH 上的 `ocu` / `open-computer-use` 是 `.ps1` / `.cmd`
  shim，GUI 或后台启动不保证继承 PATH。

当前 `index.js` 是骨架：能加载、能激活、能校验配置，但不注册任何东西，扩展点都标了
`TODO(impl)`。
