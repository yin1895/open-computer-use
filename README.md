# `dsh-plugin` — Open Computer Use for DeepSeek Harness

An installable DSH (DeepSeek Harness) bundle that puts the Open Computer Use
native tools into the current DSH profile.

Installing it inserts two rows and leaves the rest of the profile alone:

| Row id                  | Package                                   | Role                                                                                                                         |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `open-computer-use`     | `@yin1895/dsh-open-computer-use` (this dir) | Owns what the MCP client cannot do: places a real executable at `<dsh-home>/ocu/bin`, runs the turn-boundary cursor cleanup, and registers the skill. |
| `open-computer-use-mcp` | `@deepseek-ai/dsh-mcp-client` (ships with dsh) | Spawns the Open Computer Use native stdio MCP server and publishes its nine tools to the model as `mcp__ocu__<tool>`.           |

`serverName: ocu` on the second row is what produces the `mcp__ocu__` prefix.
Its `command` is a Loader expression, not a literal path:
`!!js dshHomePath('ocu/bin/open-computer-use.exe')` — see
[`<cli-home>` ownership](#cli-home-ownership).

## Status: implemented

`index.js` loads, activates, and implements its four responsibilities:

- **A. Turn boundary** — subscribes to the serial `agent/turn-stopping` event and
  runs the cursor cleanup there, with a 5-second cap and per-turn de-duplication.
- **B. Skill registration** — registers `skills/open-computer-use` through
  `ctx.skills.register(...)` as a `runtime` skill, with the skill directory as
  its `resourceBase`.
- **C. Discovery and diagnostics** — resolves the native executable from config,
  the plugin-owned `<cli-home>`, or per-platform candidates, logs one structured
  summary at activation, and exports `doctor()` plus `node index.js --doctor`.
- **D. `<cli-home>` ownership** — makes `<dsh-home>/ocu/bin/open-computer-use.exe`
  real by adopting an install that already exists on the machine, else by running
  `npm install --prefix <cli-home> open-computer-use`. This is what lets the
  published patch name a path relative to the *reader's* DSH home instead of
  pinning the builder's machine.

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

**The executable lives at a relative path, and this plugin owns it.**
`cordis.patch.yml` names the binary as `!!js dshHomePath('ocu/bin/open-computer-use.exe')`
rather than as an absolute path. `dshHomePath()` is the Harness' own Loader helper
(`@deepseek-ai/dsh-home-paths`, provided on the root context; shipped rows such as
`session-persistence-jsonl` use it for `sessions`), so the artifact carries no
machine's layout. The cost is that something has to put a binary there, and that
something is `index.js` — see [`<cli-home>` ownership](#cli-home-ownership).
`@deepseek-ai/dsh-mcp-client`'s `Config` accepts Loader expressions at value
positions (its schema projects them as `anyOf: [<field>, {$ref: '#/$defs/loaderExpression'}]`),
so `command: !!js …` is a supported form and not a trick.

**`Config` is a schemastery schema and is always exported.** Even with twelve
fields, omitting it would leave the row without a renderable settings form.
`Config` validates exactly what `cordis.patch.yml` sets (verified in the
self-check, `C8`). If schemastery cannot be resolved the module still loads,
`Config` becomes `undefined`, `resolveConfig()` still applies `DEFAULT_CONFIG`,
and `apply()` logs the degradation.

## `<cli-home>` ownership

`<cli-home>` is `<dsh-home>/ocu` (`DSH_HOME` when set, else `~/.dsh`), and the
executable belongs at `<cli-home>/bin/open-computer-use.exe` on Windows or
`<cli-home>/bin/open-computer-use` elsewhere. `apply()` runs this **first**, before
the turn-boundary hook and before skill registration, and neither step can block
or fail activation.

**One convention, two files.** `cliHomeRelativeCommand()` in `index.js` is the only
place the layout is spelled out, and the string inside the patch's
`dshHomePath(...)` must equal `SHIPPED_CLI_RELATIVE_COMMAND` — the same constant
that function produces. Change one, change the other.
`doctor()`'s `cli-home-patch-parity` check compares the two literally and is a
**required** check, so a drift is a reported failure rather than a silent
"nine tools are missing". The self-check asserts the same thing mechanically
(`D1`, `D2`).

**Adopt, then provision.** In order, and each step only when the previous one left
the expected path empty:

| Step | What happens | What is written |
| ---- | ------------ | --------------- |
| 0. `command` set | explicit configuration wins; `<cli-home>` is not touched | nothing |
| 1. already present | nothing to do (idempotent) | nothing |
| 2. adopt | an executable that already exists on the machine is *pointed at* from `<cli-home>` | `<cli-home>` only |
| 3. provision (`autoProvision: true`, the default) | `npm install --prefix <cli-home> open-computer-use`, then step 2 on the result | `<cli-home>` only |

Adoption escalates cheapest-first and prefers a **directory** link, because that is
the only form that also follows a later upgrade of the source install:

1. Junction (`win32`) or directory symlink: link `<cli-home>/bin` to the directory
   that already holds the binary. Usable when the source file already sits under
   the name we need — true for a Windows global npm install. Junctions need no
   elevation on Windows.
2. File symlink. Needs developer mode on Windows, so a failure here is expected.
3. Copy: self-contained, always available, but pinned to the version copied.

The source install is **read, never moved, renamed or modified** — adopt means
"point at it". The self-check pins that down (`D6`–`D9`), including that the
adopted path still tracks the source after the source changes.

Provisioning uses a **local prefix**: `<cli-home>/node_modules` and nothing else.
No global prefix, no `PATH` entry, no elevation, and the install is started
*without* being awaited, so activation never waits on the network. Every outcome —
non-zero exit, timeout, a spawn that never starts, an install that leaves no
executable — becomes a `logger.warn` with the exact command to run by hand:

```
install it yourself with `npm install --prefix "<cli-home>" open-computer-use`
(or `npm i -g open-computer-use`), then restart the Harness
```

After a successful install the Harness must be restarted (or the bundle toggled)
for the MCP row to re-evaluate `dshHomePath(...)`; the plugin says so in the log.

**Platform note.** The patch's argument is a literal, so it cannot branch on the
platform; the shipped form is the Windows one. On macOS and Linux the plugin
materialises **both** names — the native `open-computer-use` and a link at the
shipped `open-computer-use.exe` — so the shipped expression resolves everywhere.
`doctor()` reports the distinction as the non-required `cli-home-platform-layout`
check. The same aliasing covers an explicit `cliHome`, which the MCP row cannot
follow because `dshHomePath()` knows nothing about the config field.

**Conflict detection is read-only.** `doctor()` scans the profile's
`cordis.patch.yml` for the block `scripts/install-dsh-mcp.sh` writes
(`# >>> open-computer-use (managed by install-dsh-mcp.sh)`) and for any other
`serverName: ocu` row, reports them as `profilePatch.conflicts`, and prints the
`profilePatch.cleanupCommands` the user should run. It never edits a profile patch
layer: silently rewriting somebody's overlay is how a diagnosis becomes data loss.
The check is non-required, so a conflict is reported without failing the plugin.

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

**Portability.** `cordis.patch.yml` names the native binary relative to the DSH
home: `!!js dshHomePath('ocu/bin/open-computer-use.exe')`. Nothing in the published
tree is tuned for the machine that built it, and no `command:` line needs editing
after installing — the plugin adopts an existing install into that location, or
installs one there. Both rows stay tolerant: the MCP row is `failOnStartupError:
false` and this row only logs, so a missing binary leaves the nine tools absent
instead of breaking the profile.

**Replacing an install.** A branch tarball is fetched by URL, and pnpm treats an
unchanged spec as already satisfied — so republishing this branch does **not** update
a profile that has already installed it (`Already up to date`, `downloaded 0`). Remove
the bundle and install it again to pick up new content.

**Pending builds block every package operation.** When any other package in the
profile has an unapproved `postinstall`, pnpm 11 reports `ERR_PNPM_IGNORED_BUILDS`,
the operation fails with `kind: "build-blocked"`, and the failure is unrelated to this
package. Retry with `approvedBuilds` set to the exact `pendingBuilds` entry that was
reported. On the profile this was developed against, that approval had to be re-passed
on **every** operation: neither pnpm's own record nor the other package's
self-allow-listing made it stick.

**Restart after replacing.** Swapping the installed package does not swap the running
code. The rows re-apply, but the process keeps executing the module generation it
loaded earlier, so a freshly installed copy can still report paths from the previous
location until the Harness restarts.

### From this checkout

1. Make sure the machine has an Open Computer Use install *somewhere* — a global
   npm install is the usual case, and the plugin finds it per platform (see
   *Discovery order* below). If it has none, leave `autoProvision` at its default
   `true` and the plugin installs one into `<dsh-home>/ocu` on first activation.
   Neither route needs any edit to `cordis.patch.yml`.

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
| Executable location | An absolute path baked into the profile patch | `!!js dshHomePath('ocu/bin/open-computer-use.exe')`, materialized by the plugin |
| Both installed at once | The script's markers stay, so two rows claim `ocu` | `doctor()` detects the managed block and any duplicate `serverName: ocu` row, and only *prints* the cleanup commands |
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
| `command`               | string  | `''`     | Absolute path to the native binary. Empty selects discovery → adopt → provision. A bare PATH name is not reliable for a GUI launch. |
| `args`                  | array   | `['mcp']` | Mirror of the MCP row's args; informational for this row.                                     |
| `env`                   | object  | `{}`     | Extra environment variables, merged over `process.env` for the cleanup call.                   |
| `cwd`                   | string  | `''`     | Working directory for the cleanup call; empty means `process.cwd()`.                          |
| `serverName`            | string  | `'ocu'`  | MCP server name, and therefore the `mcp__<serverName>__<tool>` prefix; must match the MCP row. |
| `toolCallTimeoutMs`     | number  | `60000`  | Mirror of the MCP row's per-tool-call timeout; informational for this row.                     |
| `enableTurnBoundaryHook`| boolean | `true`   | Run the cursor cleanup at each turn boundary (macOS) / log the skip (Windows, Linux).          |
| `registerSkill`         | boolean | `true`   | Register the bundled Open Computer Use skill.                                                 |
| `cursorCleanupCommand`  | string  | `''`     | Optional override for the cursor cleanup invocation; empty selects the platform default.       |
| `autoProvision`         | boolean | `true`   | When nothing is found anywhere, install Open Computer Use into `<cli-home>` with a local-prefix `npm install`. Off means "report and do nothing". |
| `cliHome`               | string  | `''`     | Where the plugin keeps its executable. Empty means `<dsh-home>/ocu`, the location the MCP row's `dshHomePath(...)` resolves to. Overriding it also aliases the shipped path, because `dshHomePath()` cannot see this field. |

Discovery order when `command` is empty (first existing, executable file wins):

1. **`<dsh-home>/ocu/bin/<name>`** — the plugin-owned location, and the only place
   this plugin writes. Present after an adopt or a provision.
2. `<dirname(node)>/node_modules/open-computer-use/dist/<platform>/<arch>/…`
3. Windows: `%NVM_SYMLINK%\node_modules\…`, `<LOCALAPPDATA>\nvm\<version>\node_modules\…`,
   `%NVM_HOME%\<version>\node_modules\…`, `<APPDATA>\npm\node_modules\…`,
   `<ProgramFiles>\nodejs\node_modules\…`
4. macOS: `~/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse`,
   `/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse`
5. Linux: same `node_modules` layout under `dist/linux/<arch>/open-computer-use`
6. Last resort only if everything above missed: `npm root -g` (3 s timeout)

Whichever candidate wins, `apply()`'s summary line reports it:
`command=<path> (<raw source>) commandSource=<config|adopt|discovery|provision>`.

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
7. **`<cli-home>`.** `<dsh-home>/ocu/bin/open-computer-use.exe` is an executable
   file. The activation summary says which route put it there
   (`commandSource=`), and `doctor()`'s `cli-home-expected` / `cli-home-source`
   checks agree. A machine that had no Open Computer Use anywhere should reach the
   same state with `commandSource=provision` after a restart.
8. **No conflicts.** `doctor()`'s `profile-patch-clean` check reports no upstream
   managed block and no second `serverName: ocu` row in the profile's
   `cordis.patch.yml`. If it reports one, run the printed
   `profilePatch.cleanupCommands` yourself — the plugin will not.

## Self-check

`self-check.mjs` drives `index.js` with a mock Cordis context and asserts the
observable behaviour of both dependencies and all four responsibilities. It needs
no Harness, no GUI and no live MCP server, and it is the evidence behind the claims
above: **55 checks** (`--probe-turn-ended`; 54 without it), 34 of which predate the
`<cli-home>` work and are unchanged.

Every `<cli-home>` check runs against a throwaway `DSH_HOME` under the OS temp
directory, with a fake "already installed" Open Computer Use inside the same
sandbox and a mocked `spawn` for the provisioning path — so the run touches neither
the real `~/.dsh` nor the network. `D21` asserts exactly that: `<dsh-home>/ocu`,
the only directory this plugin creates below a DSH home, still does not exist in
the real one afterwards.

```console
$ cd D:\cyber_workspace\projects\open-computer-use
$ node --check dsh-plugin/index.js ; echo $?
0

$ node --check dsh-plugin/self-check.mjs ; echo $?
0

$ node dsh-plugin/self-check.mjs --probe-turn-ended
platform=win32 arch=x64 node=v24.21.0
PASS import-module-exports — exports=BUNDLE_PATCH_FILE, CLI_BASENAME, …, SHIPPED_CLI_RELATIVE_COMMAND, …, adoptExistingCli, apply, candidateCommands, cliBinRelativeCommand, cliHomeDir, …, doctor, expectedCliPath, extractDshHomePathArguments, inject, …, provisionCli, …, scanPatchConflicts, shippedCliPath, …
PASS import-schemastery-config — export const Config is present (required for the settings form)

=== C. configuration / discovery ===
PASS C1-doctor-ok — command=C:\nvm4w\nodejs\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe via discovered
PASS C2-doctor-command-version — 1.1.3
PASS C3-turn-ended-platform-claim — exit=1 unknown command: turn-ended
PASS C4-discovery — C:\nvm4w\nodejs\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe (discovered)
PASS C5-macos-candidates — …/dsh-home/ocu/bin/open-computer-use | …/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse | /Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse | …
PASS C6-linux-candidates — …/dsh-home/ocu/bin/open-computer-use | C:/nvm4w/nodejs/node_modules/open-computer-use/dist/linux/amd64/open-computer-use
PASS C7-config-merged — defaults+override ok
PASS C8-patch-row-config-validates — {"command":"","args":["mcp"],"env":{},"cwd":"","serverName":"ocu","toolCallTimeoutMs":60000,"enableTurnBoundaryHook":true,"registerSkill":true,"cursorCleanupCommand":"","autoProvision":true,"cliHome":""}
PASS C9-mcp-row-uses-shipped-client — @deepseek-ai/dsh-mcp-client serverName=ocu transport=stdio args=["mcp"] failOnStartupError=false command={"__jsExpr":"dshHomePath('ocu/bin/open-computer-use.exe')"} warnings=0
PASS C10-patch-rows-count — insert rows: open-computer-use, open-computer-use-mcp

=== A. turn boundary ===
PASS A1-darwin-argv — {"argv":["/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse","turn-ended"],"source":"default",…}
PASS A2-windows-skip — {"source":"platform-skip","reason":"Windows has no software cursor and no `turn-ended` subcommand"}
PASS A3-linux-skip — {"source":"platform-skip",…}
PASS A4-override-single-token — {"argv":["/opt/my-cleanup","turn-ended"],"source":"cursorCleanupCommand",…}
PASS A5-override-quoted-full-command — ["C:\\Program Files\\x\\clean.exe","--quiet","a b"]
PASS A6-apply-platform-decision — platform=win32 listener=false | [open-computer-use] turn-boundary hook skipped: platform=win32 — …
PASS A7-skill-registered-through-apply — registrations=1 logs=… summary … commandSource=config cliHome=<sandbox>\dsh-home\ocu expectedCli=<sandbox>\dsh-home\ocu\bin\open-computer-use.exe … skill registered: open-computer-use (6359 bytes) from …\SKILL.md
PASS A8-summary-log — [open-computer-use] summary platform=win32 arch=x64 serverName=ocu toolPrefix=mcp__ocu__ tools=9 command=… (config) commandSource=config cliHome=… expectedCli=… shippedCli=… adopt=skipped provision=not attempted turnBoundary=skipped on platform=win32 (platform-skip) skill=registering from … schemastery=…\lib\index.mjs
PASS A9-cleanup-success — turn 7: cursor cleanup ok
PASS A10-cleanup-failure-reported-not-thrown — turn 8: cursor cleanup exit=3 boom
PASS A11-cleanup-timeout-bounded — elapsed=438ms logs=turn 9: cleanup timed out after 400ms
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

=== D. <cli-home> ownership ===
sandbox=C:\Users\ADMINI~1\AppData\Local\Temp\ocu-dsh-selfcheck-XXXXXXXX
PASS D1-cli-home-layout-single-definition — bin=bin/open-computer-use.exe dshHome-relative(win32)=ocu/bin/open-computer-use.exe shipped=ocu/bin/open-computer-use.exe
PASS D2-shipped-command-matches-patch — patch=["ocu/bin/open-computer-use.exe"] code=ocu/bin/open-computer-use.exe
PASS D3-patch-has-no-machine-absolute-path — no C:\ , /Users/ or /home/ path in dsh-plugin/cordis.patch.yml
PASS D4-paths-derive-from-dsh-home — expected=<sandbox>\dsh-home\ocu\bin\open-computer-use.exe shipped=<sandbox>\dsh-home\ocu\bin\open-computer-use.exe
PASS D5-cli-home-override-and-config-fields — cliHomeDir=<sandbox>\custom-cli-home shipped=<sandbox>\dsh-home\ocu\bin\open-computer-use.exe Config.autoProvision=true
PASS D6-adopt-lands-on-expected-path — action=linked-directory expected=<sandbox>\adopt-home\ocu\bin\open-computer-use.exe readback="FAKE-OCU-BINARY-DO-NOT-EXECUTE\n" source=<sandbox>\fake-global\node_modules\open-computer-use\dist\windows\amd64\open-computer-use.exe detail=linked-directory from …
PASS D7-adopt-leaves-source-untouched — source=…\open-computer-use.exe bytes="FAKE-OCU-BINARY-DO-NOT-EXECUTE\n" entries=[open-computer-use.exe] mtime-unchanged=true
PASS D8-adopt-follows-source-when-linked — action=linked-directory reads-through=true
PASS D9-adopt-is-idempotent — action=none detail=already present; nothing to do bytes="FAKE-OCU-BINARY-DO-NOT-EXECUTE\n"
PASS D10-adopt-without-source-creates-nothing — action=no-source detail=no Open Computer Use executable among 0 candidate paths cli-home-created=false
PASS D11-shipped-path-satisfied-for-custom-cli-home — cliHome=<sandbox>\custom-cli-home expected=<sandbox>\custom-cli-home\bin\open-computer-use.exe (linked-directory) shipped=<sandbox>\custom-alias-home\ocu\bin\open-computer-use.exe readback="FAKE-OCU-BINARY-DO-NOT-EXECUTE\n"
PASS D12-doctor-patch-parity-required — patch=[ocu/bin/open-computer-use.exe] code=[ocu/bin/open-computer-use.exe] in sync
PASS D13-doctor-reports-sandbox-paths — cliHome.dir=<sandbox>\dsh-home\ocu profilePatch.file=<sandbox>\profile\cordis.patch.yml conflicts=0
PASS D14-npm-invocation-avoids-shims — via=node + npm-cli.js (C:\nvm4w\nodejs\node_modules\npm\bin\npm-cli.js) command=C:\nvm4w\nodejs\node.exe argv=[…\npm-cli.js install --prefix <sandbox>\npm-probe --no-save --no-fund --no-audit open-computer-use]
PASS D15-provision-failure-warns-not-throws — threw=false ok=false action=install-failed spawnCalls=1 warn=WARN installing Open Computer Use failed (exit=7): npm ERR! code ENOTFOUND simulated offline; install it yourself with `npm install --prefix "<sandbox>\provision-fail" open-computer-use` (or `npm i -g open-computer-use`), then restart the Harness
PASS D16-provision-adopts-into-cli-home — ok=true action=provisioned:linked-directory expected=<sandbox>\provision-ok\bin\open-computer-use.exe readback="FAKE-OCU-BINARY-DO-NOT-EXECUTE\n" argv=[C:\nvm4w\nodejs\node.exe …\npm-cli.js install --prefix <sandbox>\provision-ok --no-save --no-fund --no-audit open-computer-use]
PASS D17-auto-provision-off-installs-nothing — spawnCalls=0 warn=[open-computer-use] no Open Computer Use executable found (0 candidate paths) and autoProvision is off. …
PASS D18-apply-provisions-without-blocking — immediate=… installing it into <cli-home> with a local npm prefix … // summary … commandSource=provision … adopt=no-source provision=started … settled=[open-computer-use] provision settled: ok=false action=install-failed via=node + npm-cli.js (…) command=<unresolved> source=not-found detail=npm ERR! simulated offline
PASS D19-profile-patch-conflicts-detected — file=<sandbox>\conflict-profile\cordis.patch.yml managed=1 duplicate=2 rows=open-computer-use-mcp,hand-written-ocu cleanup=3 check=[false req=false] doctor.ok=true failedRequired=[]
PASS D20-conflict-scan-is-read-only — patch-unchanged=true clean-doc-conflicts=0
PASS D21-real-dsh-home-untouched — C:\Users\Administrator\.dsh\ocu does not exist after the run — no adopt or provision write reached C:\Users\Administrator\.dsh

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
  "schemastery": { "resolved": true, "via": "…\\profiles\\desktop\\node_modules\\@deepseek-ai\\schemastery\\lib\\index.mjs" },
  "inject": ["skills"],
  "toolPrefix": "mcp__ocu__",
  "expectedMcpTools": ["mcp__ocu__click", "…", "mcp__ocu__type_text"],
  "command": "C:\\nvm4w\\nodejs\\node_modules\\open-computer-use\\dist\\windows\\amd64\\open-computer-use.exe",
  "commandSource": "discovered",
  "cliHome": {
    "dir": "C:\\Users\\…\\.dsh\\ocu",
    "expected": "C:\\Users\\…\\.dsh\\ocu\\bin\\open-computer-use.exe",
    "expectedPresent": false,
    "shipped": "C:\\Users\\…\\.dsh\\ocu\\bin\\open-computer-use.exe",
    "shippedPresent": false,
    "autoProvision": true,
    "relativeCommand": "ocu/bin/open-computer-use.exe",
    "shippedRelativeCommand": "ocu/bin/open-computer-use.exe",
    "patchFile": "…\\dsh-plugin\\cordis.patch.yml",
    "resolvedFrom": "discovery"
  },
  "profilePatch": {
    "file": "…\\profiles\\desktop\\cordis.patch.yml",
    "conflicts": [],
    "cleanupCommands": [],
    "note": "reported only — this plugin never rewrites a profile patch layer"
  },
  "turnBoundary": { "enabled": true, "source": "platform-skip", "reason": "Windows has no software cursor and no `turn-ended` subcommand" },
  "checks": [
    { "id": "command", "ok": true, … },
    { "id": "command-executable", "ok": true, … },
    { "id": "binary-version", "ok": true, "detail": "1.1.3" },
    { "id": "cli-home-expected", "ok": true, "detail": "…\\.dsh\\ocu\\bin\\open-computer-use.exe (absent; source=discovery; …)", "required": false },
    { "id": "cli-home-source", "ok": true, "detail": "commandSource=discovery via discovered", "required": false },
    { "id": "cli-home-patch-parity", "ok": true, "detail": "patch=[ocu/bin/open-computer-use.exe] code=[ocu/bin/open-computer-use.exe] in sync" },
    { "id": "cli-home-platform-layout", "ok": true, "detail": "platform=win32 native=ocu/bin/open-computer-use.exe shipped=ocu/bin/open-computer-use.exe", "required": false },
    { "id": "profile-patch-clean", "ok": true, "detail": "…\\cordis.patch.yml: no upstream managed block and no other serverName: ocu row", "required": false },
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

The YAML is parsed with the `yaml` package bundled in a DSH profile. `!!js` is not
a YAML type that package knows, so the tag is registered and resolved into the same
inert `{ __jsExpr }` shape the Harness' schema projector uses — which is also proof
that the document is otherwise plain YAML 1.2 (`errors=0 warnings=0`):

```console
$ node --input-type=module -e "
  const {createRequire}=await import('node:module');const req=createRequire('C:/Users/Administrator/.dsh/profiles/desktop/package.json');const yaml=req('yaml');const fs=await import('node:fs');
  const tag={tag:'tag:yaml.org,2002:js',resolve:(v)=>({__jsExpr:String(v)})};
  const doc=yaml.parseDocument(fs.readFileSync('dsh-plugin/cordis.patch.yml','utf8'),{customTags:[tag],logLevel:'silent'});
  console.log('errors='+doc.errors.length+' warnings='+doc.warnings.length);
  console.log(JSON.stringify(doc.toJS(),null,2))"
errors=0 warnings=0
[
  {
    "insert": [
      {
        "id": "open-computer-use",
        "name": "@yin1895/dsh-open-computer-use",
        "config": {
          "command": "",
          "serverName": "ocu",
          "toolCallTimeoutMs": 60000,
          "enableTurnBoundaryHook": true,
          "registerSkill": true,
          "cursorCleanupCommand": "",
          "autoProvision": true,
          "cliHome": ""
        }
      },
      {
        "id": "open-computer-use-mcp",
        "name": "@deepseek-ai/dsh-mcp-client",
        "config": {
          "serverName": "ocu",
          "transport": "stdio",
          "command": {
            "__jsExpr": "dshHomePath('ocu/bin/open-computer-use.exe')"
          },
          "args": [
            "mcp"
          ],
          "failOnStartupError": false
        }
      }
    ]
  }
]
```

The de-machining is also checkable without a Harness, and is part of the self-check
(`D2`, `D3`):

```console
$ grep -n 'C:\\\|/Users/\|/home/' dsh-plugin/cordis.patch.yml ; echo $?
1
```

No third row is needed: row 2 is the whole tool integration, and row 1 adds only
the three behaviours the MCP client does not have — executable ownership,
turn-boundary cleanup, and skill registration.

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
2. **Discovery can pick a different install than `<cli-home>`.** On this machine
   `<dirname(node)>/node_modules` contains an install at
   `C:\nvm4w\nodejs\node_modules\…`. It is found, and `commandSource=discovery`
   says so, but the row still prefers `<cli-home>` when that path exists (step 1 of
   the discovery order), so an adopt or a provision outranks a machine-wide
   install. Config outranks both.
3. **`inject: ['skills']`, not `['skills', 'tools']`.** The reconnaissance anchor
   (`recon/dsh-host-api.md`, §9) suggested `tools` as well; this row registers no
   tool, and adding it would only widen the activation dependency.
4. **`agent/turn-stopping` failures close the turn.** The event is serial and
   awaited, and a throwing listener ends the turn, so the listener catches
   everything. `A10`–`A14` in the self-check pin that down.
5. **Windows/Linux: no cursor, no command.** `turn-ended` does not exist there
   (verified: `exit=1 unknown command: turn-ended`), and `notifications/turn-ended`
   sent to the MCP process is ignored, so the plugin does neither.
6. **`npm` and `pnpm` are `.ps1`/`.cmd` shims on this machine, and neither can be
   spawned directly.** Measured:

   ```
   $ node.exe C:\nvm4w\nodejs\node_modules\npm\bin\npm-cli.js --version
   11.19.0                       # exit 0

   $ node -e "require('node:child_process').execFile('npm.cmd',['--version'],()=>{})"
   Error: spawn EINVAL            # thrown synchronously, no 'error' event
   ```

   `provisionCli()` therefore never runs a bare `npm`. Its primary form is
   `process.execPath` + npm's own `node_modules/npm/bin/npm-cli.js` — an absolute
   `.exe` with an argument array, so there is no shell and no PATH assumption. The
   entry point is looked up beside `process.execPath`, then under `%NVM_SYMLINK%`,
   `%NVM_HOME%` and `%ProgramFiles%\nodejs`. Only when no entry point exists does it
   fall back to `cmd.exe /d /s /c npm …` (`/bin/sh -c` elsewhere), and that fallback
   is refused when the prefix contains characters the shell would interpret.
   `D14` checks the resolved form, and the shim failure above is why. **This is the
   load-bearing detail for the "clean machine" case**: a machine whose only npm is a
   shim still needs a Node installation, because the fallback needs `cmd.exe` (or a
   shell) to resolve `npm.cmd`.
7. **A stale binary at `<cli-home>` makes `doctor()` report rather than crash.**
   `execFile` throws *synchronously* for a file Windows refuses to load
   (`spawn UNKNOWN`, errno −4094), so `runOnce()` wraps it and turns that into a
   failed `binary-version` check. Verified by pointing discovery at a text file
   (`D6`–`D8` use a fake binary for exactly this reason).
8. **Adopt prefers a junction, and that choice is observable.** `D6`/`D8` show
   `action=linked-directory` and that the adopted path still reads through to the
   source after the source changes; a copy would have failed the second half. A
   file symlink needs developer mode on Windows, and the copy fallback pins the
   version — both are correct but less useful, which is why the junction is tried
   first.

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

本插件负责的四件事：

- **A. 回合边界**：监听 `agent/turn-stopping`（serial、会被 await），在回合收尾点执行
  光标清理；5 秒上限、同轮不重复触发、任何失败只 `logger.warn`，绝不让收尾抛错。
  **`turn-ended` 只有 macOS 有**，Windows/Linux 上改为一次性日志说明已跳过，且不注册
  监听器，也不往 MCP 进程补发任何通知。
- **B. 技能**：用 `ctx.skills.register(...)` 内嵌注册 `skills/open-computer-use`，
  `source: 'runtime'`，`resourceBase` 指向真实目录，因此 `SKILL.md` 里的
  `references/*.md` 相对路径能被直接读到——不需要往 `<dsh-home>/skills` 复制任何东西。
- **C. 发现与诊断**：`command` 为空时按平台自动发现 native 可执行文件；启动打一条结构化
  摘要日志；`doctor()` / `node index.js --doctor` 给出可机检的自检报告。
- **D. `<cli-home>` 归属**：patch 里不再写死任何机器的绝对路径，改成
  `!!js dshHomePath('ocu/bin/open-computer-use.exe')`；把那个位置变成真有东西，就是这一步的
  活。顺序是「已有就不动 → adopt（把机器上已有的 ocu 接过去，优先 junction/symlink，
  源文件只读不动）→ provision（`npm install --prefix <cli-home> open-computer-use`，
  局部安装，不碰全局、不改 PATH）」。整段在 `apply()` 最前面、被 try/catch 包住，失败只
  warn，不阻塞也不影响激活。`doctor()` 里有 `cli-home-patch-parity` 硬校验：patch 里的
  `dshHomePath(...)` 参数和 `index.js` 的 `SHIPPED_CLI_RELATIVE_COMMAND` 必须逐字相同。

四处容易踩的坑：

- `config` 是**整体替换**，不是深合并；只写一半字段会把手里的另一半丢掉。
- patch 里的 `command` 求值后必须仍是**绝对路径**。PATH 上的 `ocu` / `open-computer-use`
  是 `.ps1` / `.cmd` shim，GUI 或后台启动不保证继承 PATH；`dshHomePath()` 在行校验之前就
  已经展开成绝对路径，所以表达式写法满足这条要求。
- 本机 `npm` / `pnpm` 是 `.ps1` shim，**`.cmd` / `.ps1` 不能被 `child_process` 直接拉起**
  （实测 `spawn EINVAL`）。所以 provision 的主路径是 `process.execPath` +
  `node_modules/npm/bin/npm-cli.js`，没有任何 shell；只有找不到入口时才退回
  `cmd.exe /d /s /c npm …`。**「干净机器」这条路径依赖这一点**。
- **同一个 serverName 会打架**：如果之前用 `scripts/install-dsh-mcp.sh` 装过，profile patch
  里还留着它写的 managed block（`# >>> open-computer-use (managed by install-dsh-mcp.sh)`）
  或者另一行 `serverName: ocu`，就会出现两组 `ocu` 工具互相顶。`doctor()` 会把冲突检测出来并
  **只打印**你自己该执行的清理命令（`profilePatch.cleanupCommands`），绝不自动改你 profile
  里的任何一行。

**装法有两种**：给 `install_bundle` 一个**链接**（生成分支 `dsh-plugin-dist` 的 tarball 地址，
见上面 Install 一节），或者给一个**本地目录**（本仓库的 `dsh-plugin/`）。前者是冻结副本，
后者是 `link:` 依赖、改完即时生效。DSH 要求被指向的 `package.json` 自己声明
`dsh.bundle.patch`——本仓库根目录是 ocu 本体、不是 bundle，所以指向仓库根会被判
`not-a-bundle`，这就是需要那个生成分支的原因。

验证：`node dsh-plugin/self-check.mjs --probe-turn-ended`（当前 55 项检查全部 PASS，退出码 0；
其中 34 项是 `<cli-home>` 改动之前就有的，未退化）。新增的 21 项（`D1`–`D21`）全部用临时目录
当 `DSH_HOME`，内置一个假的「已装好的 ocu」，provision 的 `spawn` 被 mock 掉，因此既不读写真
实 `~/.dsh`、也不联网；`D21` 就是断言真实 `<dsh-home>/ocu` 在跑完之后依然不存在。
