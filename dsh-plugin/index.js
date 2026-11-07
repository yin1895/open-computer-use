/**
 * Host half of the `@yin1895/dsh-open-computer-use` bundle.
 *
 * OWNERSHIP — this row owns exactly three things, and nothing else:
 *
 *   A. Turn-boundary cursor cleanup. Open Computer Use hides its software
 *      cursor only when something tells it the turn ended, and
 *      `@deepseek-ai/dsh-mcp-client` never sends that notification. The
 *      authoritative DSH turn boundary is the serial event
 *      `agent/turn-stopping`, so that is where the cleanup call hangs.
 *   B. Skill registration. `ctx.skills.register(...)` publishes the in-repo
 *      `skills/open-computer-use` skill as a runtime (`source: 'runtime'`)
 *      entry, so nothing is copied into `<dsh-home>/skills`.
 *   C. Configuration resolution and diagnostics. `command` is discovered per
 *      platform when it is left empty, `apply()` logs one structured summary,
 *      and `doctor()` reports machine-checkable facts.
 *   D. `<cli-home>` ownership. The published bundle must not carry any one
 *      machine's install directory, so `cordis.patch.yml` names the MCP
 *      executable as `!!js dshHomePath('ocu/bin/open-computer-use.exe')` and
 *      THIS module is what makes that path real: it adopts an executable that
 *      already exists on the machine (junction / symlink / copy, source never
 *      touched) or, failing that, installs one with a local-prefix `npm install`
 *      into `<cli-home>`. Nothing global is modified and `PATH` is never
 *      changed. `index.js` and the patch's `dshHomePath(...)` argument are one
 *      convention in two files; `doctor()` fails loudly if they drift.
 *
 * The nine Computer Use tools themselves are NOT implemented here. They come
 * from the second row this bundle inserts — `@deepseek-ai/dsh-mcp-client` with
 * `serverName: ocu`, which spawns `open-computer-use mcp` and publishes the
 * tools as `mcp__ocu__<tool>`. This module implements no MCP client and no
 * tool, and it never talks to the MCP child process.
 *
 * PLATFORM REALITY (measured, see README "Known deviations"): `turn-ended` is
 * a macOS-only subcommand. On Windows/Linux the native binary answers
 * `unknown command: turn-ended` and exits 1, and there is no software cursor to
 * hide, so the turn-boundary hook becomes an explicit no-op that says so in the
 * log. Sending `notifications/turn-ended` to the MCP process is equally
 * pointless (ignored / `-32601`), so this module never does that either.
 *
 * IMPORT POLICY: only `node:*` and `@deepseek-ai/schemastery`. Nothing from
 * `@deepseek-ai/dsh-*` is imported, so module resolution does not depend on the
 * Harness installation layout.
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Stable Loader identity; matches the row id in `cordis.patch.yml`. */
export const name = 'open-computer-use'

/**
 * Services this plugin consumes. `skills` is the only hard dependency: the
 * plugin is meaningless without a registry to register into.
 *
 * Deliberately absent:
 *   - `computerUse` — no package in the dsh installation provides that slot, so
 *     injecting it would fail plugin activation outright.
 *   - `subprocess` — the cleanup call is a short, self-contained command, so it
 *     runs through `node:child_process` instead (see README "Design choices").
 *   - `tools` — this row registers no tool.
 */
export const inject = ['skills']

/** Platform-neutral defaults; mirror `cordis.patch.yml`. */
export const DEFAULT_CONFIG = {
  command: '',
  args: ['mcp'],
  env: {},
  cwd: '',
  serverName: 'ocu',
  toolCallTimeoutMs: 60000,
  enableTurnBoundaryHook: true,
  registerSkill: true,
  cursorCleanupCommand: '',
  autoProvision: true,
  cliHome: '',
}

/** Skill identity. Fixed so users find the same name the shell script used. */
export const SKILL_NAME = 'open-computer-use'

/** The nine tools the sibling MCP row publishes; used by `doctor()` only. */
export const EXPECTED_MCP_TOOLS = [
  'click',
  'drag',
  'get_app_state',
  'list_apps',
  'perform_secondary_action',
  'press_key',
  'scroll',
  'set_value',
  'type_text',
]

/** Hard cap on the turn-boundary cleanup call: it must never stall a turn. */
export const TURN_BOUNDARY_TIMEOUT_MS = 5000

/** `killSignal` escalation for the cleanup child process. */
const CLEANUP_GRACE_MS = 2000

const logPrefix = '[open-computer-use]'

/* ────────────────────────────────────────────────────────────────────────────
 * schemastery
 *
 * `@deepseek-ai/schemastery` is installed in the Harness profile, but bare
 * specifier resolution is anchored to THIS FILE's directory, which after a
 * `file:` bundle install may be outside the profile tree. So the module is
 * loaded defensively: bare specifier first (the normal, in-profile case), then
 * the profile's own `node_modules` via `DSH_PROFILE_DIR` / `DSH_PROFILE` /
 * `~/.dsh`. Measured: only the bare form fails when the plugin directory is
 * outside the profile, which would otherwise take the whole row down.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Candidate Harness profile directories, most specific first. */
function profileDirectories(env = process.env) {
  const found = []
  const add = (dir) => {
    if (dir && !found.includes(dir)) found.push(dir)
  }
  add(env.DSH_PROFILE_DIR)
  const dshHome = dshHomeDir(env)
  add(env.DSH_PROFILE ? join(dshHome, 'profiles', env.DSH_PROFILE) : '')
  add(join(dshHome, 'profiles', 'desktop'))
  return found
}

/** schemastery's default export is the `Schema` factory: `Schema.object`, etc. */
function isSchemastery(value) {
  return typeof value === 'function' && typeof value.object === 'function' && typeof value.string === 'function'
}

/** Normalise a module namespace, including CJS interop shapes, to `Schema`. */
function pickSchemastery(namespace) {
  for (const candidate of [namespace?.default, namespace, namespace?.default?.default]) {
    if (isSchemastery(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve `@deepseek-ai/schemastery` as an ES module.
 * @returns {Promise<{ schema: unknown, via: string, attempts: string[] }>}
 */
export async function loadSchemastery() {
  const attempts = []
  try {
    const module = await import('@deepseek-ai/schemastery')
    const schema = pickSchemastery(module)
    if (schema) return { schema, via: '@deepseek-ai/schemastery', attempts }
    attempts.push('bare specifier resolved but exposed no Schema factory')
  } catch (cause) {
    attempts.push(`bare specifier: ${describeError(cause)}`)
  }
  const relativeEntries = [
    'node_modules/@deepseek-ai/schemastery/lib/index.mjs',
    'node_modules/@deepseek-ai/schemastery/lib/index.cjs',
  ]
  for (const directory of profileDirectories()) {
    // The ESM build first: it is the same entry the Harness' own `import` of
    // this package resolves to, so the Loader and this plugin share one build.
    for (const relative of relativeEntries) {
      const file = join(directory, relative)
      if (!existsSync(file)) continue
      try {
        const schema = pickSchemastery(await import(pathToFileURL(file).href))
        if (schema) return { schema, via: file, attempts }
      } catch (cause) {
        attempts.push(`${file}: ${describeError(cause)}`)
      }
    }
    try {
      const require = createRequire(join(directory, 'package.json'))
      const entry = require.resolve('@deepseek-ai/schemastery')
      const schema = pickSchemastery(await import(pathToFileURL(entry).href))
      if (schema) return { schema, via: entry, attempts }
      attempts.push(`${entry}: no Schema factory found`)
    } catch (cause) {
      attempts.push(`require.resolve from ${directory}: ${describeError(cause)}`)
    }
  }
  return { schema: undefined, via: '', attempts }
}

const schemastery = await loadSchemastery()
const z = schemastery.schema

/**
 * Row configuration schema. Kept even though the field list is short, because a
 * row without a `Config` schema cannot render its settings form.
 *
 * Falls back to `undefined` when schemastery is unreachable; the row still
 * activates, `resolveConfig()` still applies `DEFAULT_CONFIG`, and `apply()`
 * logs the degradation.
 */
export const Config = z
  ? z.object({
      command: z.string().default(''),
      args: z.array(z.string()).default(['mcp']),
      env: z.dict(z.string()).default({}),
      cwd: z.string().default(''),
      serverName: z.string().default('ocu'),
      toolCallTimeoutMs: z.number().default(60000),
      enableTurnBoundaryHook: z.boolean().default(true),
      registerSkill: z.boolean().default(true),
      cursorCleanupCommand: z.string().default(''),
      autoProvision: z.boolean().default(true),
      cliHome: z.string().default(''),
    })
  : undefined

/* ────────────────────────────────────────────────────────────────────────────
 * Small shared helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function describeError(cause) {
  if (!cause) return 'unknown error'
  const code = cause.code ? `${cause.code}: ` : ''
  return `${code}${cause.message ?? String(cause)}`
}

function truncate(text, max = 300) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Plugin-scoped logger that can never throw into a turn boundary. */
function createLogger(ctx) {
  const emit = (level, message) => {
    try {
      const sink = ctx?.logger?.[level]
      if (typeof sink === 'function') sink.call(ctx.logger, `${logPrefix} ${message}`)
      else if (level === 'warn') console.error(`${logPrefix} ${message}`)
    } catch {
      /* a logging failure must not propagate */
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    debug: (message) => emit('debug', message),
  }
}

/** Case-insensitive lookup for Windows environment blocks. */
function readEnv(env, key) {
  if (!env) return undefined
  if (env[key] !== undefined) return env[key]
  const wanted = key.toLowerCase()
  for (const actual of Object.keys(env)) {
    if (actual.toLowerCase() === wanted) return env[actual]
  }
  return undefined
}

/** `true` for an existing regular file that is executable on this platform. */
export function isExecutableFile(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  try {
    if (!statSync(path).isFile()) return false
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export function isReadableFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * D. `<cli-home>` — the plugin-owned executable home
 *
 * Read before section C, because C's discovery list starts at this path and
 * because `apply()` runs adoption and provisioning before anything else.
 *
 * ONE CONVENTION, TWO FILES. `cliHomeRelativeCommand()` and
 * `cliBinRelativeCommand()` are the only places this module spells out where the
 * executable lives:
 *
 *   ocu/bin/open-computer-use.exe      ← the shipped form (Windows)
 *   ocu/bin/open-computer-use          ← macOS and Linux (no extension)
 *
 * `cordis.patch.yml`'s MCP row names the same location as a Loader expression,
 * `!!js dshHomePath('ocu/bin/open-computer-use.exe')`. The string inside
 * `dshHomePath(...)` must equal `SHIPPED_CLI_RELATIVE_COMMAND` below; change one
 * and you must change the other (`doctor()`'s `cli-home-patch-parity` check
 * compares the two literally, and the self-check asserts it mechanically).
 *
 * WHY THE SHIPPED FORM IS THE WINDOWS ONE. Windows is the only platform where
 * the native binary carries `.exe`, and `dshHomePath()` takes a literal, so the
 * shipped argument cannot branch on the platform. The plugin therefore
 * materialises BOTH names on macOS and Linux: the platform-native one, plus a
 * link under the shipped `.exe` name, so the shipped expression resolves
 * everywhere instead of silently resolving to nothing.
 *
 * WHY `<dsh-home>` AND NOT A BARE PATH. `dshHomePath()` is the Harness' own
 * Loader helper (`@deepseek-ai/dsh-home-paths`, provided on the root context as
 * `dshHomePath`; shipped rows such as `session-persistence-jsonl` use it for
 * `sessions`). Expressing the executable's location the same way is what keeps
 * the artifact machine-independent: `<dsh-home>` is a property of the reader's
 * installation, not of the author's.
 *
 * WRITE DISCIPLINE. Every function below writes only inside `<cli-home>`. An
 * existing install elsewhere on the machine is READ, never moved, renamed or
 * modified: adopt means "point at it", and the worst case is a copy that leaves
 * the source untouched.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `<cli-home>` directory name below the DSH home: `<dsh-home>/ocu`. */
export const CLI_HOME_SEGMENT = 'ocu'

/** Directory inside `<cli-home>` that holds the executable. */
export const CLI_BIN_DIR = 'bin'

/** Executable stem, without a platform extension. */
export const CLI_BASENAME = 'open-computer-use'

/** Windows executable extension; the only platform that has one. */
export const CLI_WINDOWS_EXTENSION = '.exe'

/**
 * The `<cli-home>`-relative executable path for one platform, always in POSIX
 * form: `bin/open-computer-use.exe` (Windows) or `bin/open-computer-use`.
 *
 * This is the single definition of the layout below `<cli-home>`:
 * `expectedCliPath()` derives from it.
 */
export function cliBinRelativeCommand(platform = process.platform) {
  const extension = platform === 'win32' ? CLI_WINDOWS_EXTENSION : ''
  return [CLI_BIN_DIR, `${CLI_BASENAME}${extension}`].join('/')
}

/**
 * The `<dsh-home>`-relative executable path for one platform, always in POSIX
 * form: `ocu/bin/open-computer-use.exe`.
 *
 * This is the string that belongs in `dshHomePath('...')`, and it is the single
 * definition of the layout below the DSH home: `SHIPPED_CLI_RELATIVE_COMMAND`
 * and `shippedCliPath()` derive from it.
 *
 * @param {NodeJS.Platform|string} [platform]
 * @returns {string} e.g. `ocu/bin/open-computer-use.exe`
 */
export function cliHomeRelativeCommand(platform = process.platform) {
  return [CLI_HOME_SEGMENT, cliBinRelativeCommand(platform)].join('/')
}

/**
 * The `<dsh-home>`-relative path the published `cordis.patch.yml` pins, i.e. the
 * exact argument of `dshHomePath(...)` in the MCP row. Must stay equal to that
 * literal — see the section banner.
 */
export const SHIPPED_CLI_RELATIVE_COMMAND = cliHomeRelativeCommand('win32')

/** `true` when two paths name the same location. Separators and Windows case. */
export function isSamePath(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false
  const normalise = (value) => {
    const trimmed = resolve(value).replace(/[\\/]+$/, '')
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  return normalise(left) === normalise(right)
}

/**
 * The DSH home: `DSH_HOME` when set, else `~/.dsh`. Mirrors what the Harness'
 * own `resolveDshHome()` does for a default installation.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} absolute
 */
export function dshHomeDir(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * The plugin-owned executable home: the configured `cliHome`, else
 * `<dsh-home>/ocu`. This is the directory both `dshHomePath(...)` arguments and
 * every write in this section are relative to.
 *
 * @param {{ cliHome?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {string} absolute
 */
export function cliHomeDir({ cliHome = '', env = process.env } = {}) {
  const configured = typeof cliHome === 'string' ? cliHome.trim() : ''
  return configured.length > 0 ? resolve(configured) : join(dshHomeDir(env), CLI_HOME_SEGMENT)
}

/** `<cli-home>/bin`. */
export function cliBinDir({ cliHome = '', env = process.env } = {}) {
  return join(cliHomeDir({ cliHome, env }), CLI_BIN_DIR)
}

/**
 * `<cli-home>/<cliBinRelativeCommand(platform)>` — the platform-native path.
 *
 * With the default `cliHome` this is `<dsh-home>/ocu/bin/open-computer-use.exe`,
 * i.e. exactly what the MCP row's `dshHomePath('ocu/bin/open-computer-use.exe')`
 * resolves to on Windows.
 *
 * @returns {string} absolute
 */
export function expectedCliPath({ cliHome = '', env = process.env, platform = process.platform } = {}) {
  return join(cliHomeDir({ cliHome, env }), ...cliBinRelativeCommand(platform).split('/'))
}

/**
 * The exact path the MCP row's `!!js dshHomePath(...)` expression resolves to:
 * always `<dsh-home>/ocu/bin/open-computer-use.exe`, because `dshHomePath()`
 * takes a literal and knows nothing about the `cliHome` config field.
 *
 * Equal to `expectedCliPath()` when `cliHome` is left at its default and the
 * platform is Windows. When it differs — a non-Windows extension, or an explicit
 * `cliHome` — the plugin links this path to the executable it adopted or
 * provisioned, so the MCP row still resolves.
 *
 * @returns {string} absolute
 */
export function shippedCliPath({ env = process.env } = {}) {
  return join(dshHomeDir(env), ...SHIPPED_CLI_RELATIVE_COMMAND.split('/'))
}

/** `true` when `directory` exists and holds nothing. */
function isEmptyDirectory(directory) {
  try {
    return readdirSync(directory).length === 0
  } catch {
    return false
  }
}

/** Junction (Windows) or directory symlink (else): needs no privilege on Windows. */
function tryLinkDirectory(linkPath, target) {
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

/** File symlink. Needs developer mode / elevation on Windows, so failure is normal. */
function tryLinkFile(linkPath, target) {
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, 'file')
    return true
  } catch {
    return false
  }
}

/** Last-resort copy. Reads the source, writes only the destination. */
function tryCopyFile(targetPath, source) {
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    copyFileSync(source, targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * Put the executable at `target` by pointing at `source`.
 *
 * Three escalating strategies, cheapest first:
 *
 *   1. **Directory link** — link `dirname(target)`, not the file. Only usable
 *      when `source` already sits under the name we need (true for a Windows
 *      global npm install). This is the only form that also follows a later
 *      upgrade of the source install, which is why it is tried first.
 *   2. **File link** — no extra disk, still follows the source. On Windows this
 *      needs developer mode, so a failure here is expected.
 *   3. **Copy** — self-contained and always available, but pinned to the version
 *      copied. Re-running `apply()` after an upgrade re-copies only if the
 *      target is missing.
 *
 * @returns {{ ok: boolean, action: string, target: string, source?: string, detail?: string }}
 */
function materializeCli({ cliHome = '', env = process.env, target, source }) {
  if (existsSync(target)) return { ok: true, action: 'present', target }
  if (!isExecutableFile(source)) return { ok: false, action: 'missing-source', target, source: source ?? '' }

  const home = cliHomeDir({ cliHome, env })
  try {
    mkdirSync(home, { recursive: true })
  } catch (cause) {
    return { ok: false, action: 'failed', target, source, detail: `cannot create ${home}: ${describeError(cause)}` }
  }

  const linkRoot = dirname(target)
  if (basename(source) === basename(target) && !existsSync(linkRoot) && tryLinkDirectory(linkRoot, dirname(source))) {
    return existsSync(target)
      ? { ok: true, action: 'linked-directory', target, source }
      : { ok: false, action: 'failed', target, source, detail: `linked ${linkRoot} but ${target} is still missing` }
  }
  if (tryLinkFile(target, source)) return { ok: true, action: 'linked-file', target, source }
  if (tryCopyFile(target, source)) return { ok: true, action: 'copied', target, source }
  return { ok: false, action: 'failed', target, source, detail: `could not link or copy ${source}` }
}

/**
 * Make the shipped `dshHomePath(...)` argument resolve on this platform.
 *
 * On Windows the native path IS the shipped path, so this is a no-op. On macOS
 * and Linux the native binary has no extension, so a link under the shipped
 * `.exe` name is added; without it the MCP row's expression would resolve to a
 * missing file and the nine tools would be absent with no error.
 */
function ensureShippedAlias({ cliHome = '', env = process.env, platform = process.platform, source }) {
  const shipped = shippedCliPath({ env })
  if (isSamePath(shipped, source, platform)) return { path: shipped, action: 'same-as-native' }
  if (existsSync(shipped)) return { path: shipped, action: 'present' }
  if (tryLinkFile(shipped, source)) return { path: shipped, action: 'linked-file' }
  if (tryCopyFile(shipped, source)) return { path: shipped, action: 'copied' }
  return { path: shipped, action: 'failed' }
}

/**
 * Adopt an existing Open Computer Use install into `<cli-home>`.
 *
 * Reads `candidates` (the same per-platform discovery list `apply()` uses) and
 * writes only inside `<cli-home>`. The source install is never modified, moved
 * or deleted: this is "point at it", not "take it".
 *
 * Never throws.
 *
 * @returns {{
 *   action: 'none'|'linked-directory'|'linked-file'|'copied'|'no-source'|'missing-source'|'failed',
 *   expected: string, source: string, shipped?: object, detail: string,
 * }}
 */
export function adoptExistingCli({
  cliHome = '',
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  logger,
  candidates = candidateCommands({ platform, arch, env, cliHome }),
} = {}) {
  const context = { cliHome, env, platform }
  const expected = expectedCliPath(context)

  if (existsSync(expected)) {
    const shipped = ensureShippedAlias({ ...context, source: expected })
    return { action: 'none', expected, source: expected, shipped, detail: 'already present; nothing to do' }
  }

  const source = candidates.find(
    (candidate) => isExecutableFile(candidate) && !isSamePath(candidate, expected, platform),
  )
  if (!source) {
    return {
      action: 'no-source',
      expected,
      source: '',
      detail: `no Open Computer Use executable among ${candidates.length} candidate paths`,
    }
  }

  const result = materializeCli({ ...context, target: expected, source })
  if (!result.ok) {
    logger?.warn?.(`could not place a CLI at ${expected} from ${source}: ${result.detail ?? result.action}`)
    return { action: 'failed', expected, source, detail: result.detail ?? result.action }
  }
  const shipped = ensureShippedAlias({ ...context, source: expected })
  logger?.info?.(`adopted the existing install at ${source} -> ${expected} (${result.action})`)
  return { action: result.action, expected, source, shipped, detail: `${result.action} from ${source}` }
}

/* ── provisioning: last resort, off the activation path ─────────────────── */

/** cmd.exe / sh metacharacters that make a shell fallback unsafe. */
const SHELL_UNSAFE = /["'`$&|<>^%\r\n\t]/

/**
 * How to run npm on this machine — resolved WITHOUT relying on PATH and WITHOUT
 * a shell when a real Node entry point exists.
 *
 * Measured on this machine: `npm` and `pnpm` resolve to `.ps1` shims and `node`
 * to a real `.exe`. A `.cmd`/`.ps1` shim cannot be spawned directly
 * (EINVAL / EFTYPE), so a naive `spawn('npm', …)` fails outright. Preference
 * order:
 *
 *   1. `process.execPath` + npm's own `bin/npm-cli.js` — an absolute `.exe` with
 *      an argument array. No shell, no PATH, no quoting rules. This is the
 *      primary path.
 *   2. `cmd.exe /d /s /c npm …` (Windows) or `/bin/sh -c npm …` — only when no
 *      npm CLI entry can be found. `cmd.exe` resolves `npm.cmd` itself, so this
 *      still does not depend on the caller's PATH containing npm's directory.
 *      Refused when the prefix contains characters the shell would interpret.
 *
 * @returns {{ command: string, args: string[], via: string, verbatim?: boolean, reason?: string }}
 */
export function resolveNpmInvocation({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  prefix = '',
} = {}) {
  const roots = []
  const addRoot = (directory) => {
    if (typeof directory === 'string' && directory.length > 0 && !roots.includes(directory)) roots.push(directory)
  }
  addRoot(dirname(execPath))
  addRoot(readEnv(env, 'NVM_SYMLINK'))
  addRoot(readEnv(env, 'NVM_HOME'))
  const programFiles = readEnv(env, 'ProgramFiles')
  if (programFiles) addRoot(join(programFiles, 'nodejs'))

  const cliEntries = []
  for (const root of roots) {
    cliEntries.push(join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    cliEntries.push(join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  const cli = cliEntries.find((candidate) => existsSync(candidate))
  const npmArgs = ['install', '--prefix', prefix, '--no-save', '--no-fund', '--no-audit', 'open-computer-use']
  if (cli) {
    return { command: execPath, args: [cli, ...npmArgs], via: `node + npm-cli.js (${cli})` }
  }

  if (SHELL_UNSAFE.test(prefix)) {
    return {
      command: '',
      args: [],
      via: 'unavailable',
      reason: `no npm-cli.js found and the shell fallback is unsafe for a prefix containing shell metacharacters: ${prefix}`,
    }
  }
  if (platform === 'win32') {
    const comspec = readEnv(env, 'ComSpec') || join(readEnv(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe')
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `npm install --prefix "${prefix}" --no-save --no-fund --no-audit open-computer-use`],
      via: 'cmd.exe /c npm (shim fallback)',
      verbatim: true,
    }
  }
  return {
    command: '/bin/sh',
    args: ['-c', `npm install --prefix '${prefix}' --no-save --no-fund --no-audit open-computer-use`],
    via: 'sh -c npm (shim fallback)',
  }
}

/**
 * Install Open Computer Use into `<cli-home>` with a LOCAL prefix.
 *
 * `npm install --prefix <cli-home> open-computer-use` writes
 * `<cli-home>/node_modules/...` and nothing else: no global prefix, no `PATH`
 * entry, no elevation. After a successful install the package's own layout is
 * adopted into `<cli-home>/bin` like any other existing install.
 *
 * Never rejects and never throws: every outcome is reported as data, so a failed
 * install can only produce a `logger.warn` with an actionable command.
 *
 * @param {{ spawnProcess?: typeof spawn }} [options] `spawnProcess` is a test
 *   seam: the self-check passes a stub so no real `npm` and no network is used.
 * @returns {Promise<{ ok: boolean, action: string, expected: string, invocation: object, detail: string }>}
 */
export function provisionCli({
  cliHome = '',
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  logger,
  spawnProcess = spawn,
  timeoutMs = 180000,
} = {}) {
  const home = cliHomeDir({ cliHome, env })
  const expected = expectedCliPath({ cliHome, env, platform })
  const invocation = resolveNpmInvocation({ env, platform, prefix: home })
  const manual = `npm install --prefix "${home}" open-computer-use`
  const guidance = `install it yourself with \`${manual}\` (or \`npm i -g open-computer-use\`), then restart the Harness`

  return new Promise((resolveOutcome) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolveOutcome({ ok: Boolean(value.ok), home, expected, invocation, ...value })
    }

    if (typeof invocation.command !== 'string' || invocation.command.length === 0) {
      logger?.warn?.(`cannot auto-install Open Computer Use: ${invocation.reason}; ${guidance}`)
      settle({ ok: false, action: 'unavailable', detail: invocation.reason })
      return
    }
    if (existsSync(expected)) {
      settle({ ok: true, action: 'present', detail: `${expected} already exists` })
      return
    }

    let child
    try {
      mkdirSync(home, { recursive: true })
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: home,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
      })
    } catch (cause) {
      logger?.warn?.(`cannot start \`${invocation.via}\` to install Open Computer Use: ${describeError(cause)}; ${guidance}`)
      settle({ ok: false, action: 'spawn-failed', detail: describeError(cause) })
      return
    }

    let stdout = ''
    let stderr = ''
    const collect = (chunk, sink) => {
      const text = String(chunk)
      const next = sink === 'out' ? stdout + text : stderr + text
      const trimmed = next.length > 4096 ? next.slice(-4096) : next
      if (sink === 'out') stdout = trimmed
      else stderr = trimmed
    }
    child.stdout?.on?.('data', (chunk) => collect(chunk, 'out'))
    child.stderr?.on?.('data', (chunk) => collect(chunk, 'err'))

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* the close handler still reports the outcome */
      }
    }, timeoutMs)
    timer.unref?.()

    const finish = (code, error) => {
      clearTimeout(timer)
      if (timedOut) {
        logger?.warn?.(`installing Open Computer Use timed out after ${timeoutMs}ms; ${guidance}`)
        settle({ ok: false, action: 'timeout', detail: truncate(stderr || stdout, 300) })
        return
      }
      if (error || code !== 0) {
        logger?.warn?.(
          `installing Open Computer Use failed (exit=${code ?? 'null'}): ${truncate(stderr || stdout || describeError(error), 300)}; ${guidance}`,
        )
        settle({ ok: false, action: 'install-failed', detail: truncate(stderr || stdout, 300) })
        return
      }
      // npm writes `<cli-home>/node_modules/open-computer-use/dist/<platform>/…`;
      // adopt it into `<cli-home>/bin` exactly like a pre-existing install.
      const adopted = adoptExistingCli({
        cliHome,
        env,
        platform,
        arch,
        logger,
        candidates: npmRootCandidates(join(home, 'node_modules'), arch),
      })
      if (adopted.action === 'no-source' || adopted.action === 'failed') {
        logger?.warn?.(
          `Open Computer Use was installed into ${home} but no executable was found under ${join(home, 'node_modules')} (${adopted.detail}); check \`${invocation.via}\` output and ${guidance}`,
        )
        settle({ ok: false, action: 'installed-without-executable', detail: adopted.detail })
        return
      }
      logger?.info?.(`provisioned Open Computer Use into ${home} (${invocation.via}): ${expected}`)
      settle({ ok: true, action: `provisioned:${adopted.action}`, detail: `${invocation.via} -> ${expected}` })
    }

    child.once?.('error', (error) => finish(null, error))
    child.once?.('close', (code) => finish(code, undefined))
  })
}

/* ── profile-patch conflict detection (read-only, never repairs) ─────────── */

/** Begin marker written by `scripts/install-dsh-mcp.sh` into a profile patch. */
export const MANAGED_BLOCK_BEGIN = '# >>> open-computer-use (managed by install-dsh-mcp.sh)'

/** End marker written by the same script. */
export const MANAGED_BLOCK_END = '# <<< open-computer-use'

const DSH_HOME_PATH_CALL = /dshHomePath\(\s*(['"])([\w./\\:-]+)\1\s*\)/

/**
 * Every `dshHomePath('...')` argument in a patch document, in source order.
 *
 * Comments are stripped first: this module's own patch documents the convention
 * in prose, and a commented-out example must not look like a second, conflicting
 * argument.
 */
export function extractDshHomePathArguments(text) {
  const found = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim().startsWith('#') ? '' : rawLine.replace(/\s+#.*$/, '')
    if (line.length === 0) continue
    const match = DSH_HOME_PATH_CALL.exec(line)
    if (match) found.push(match[2])
  }
  return found
}

/** The nearest `- id: <name>` above `index`, so a conflict can name its row. */
function nearestRowId(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = /^\s*-\s*id\s*:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[cursor])
    if (match) return match[1]
  }
  return undefined
}

/**
 * Find the two ways a profile patch collides with this bundle, without changing
 * anything:
 *
 *   1. `managed-block` — the block `scripts/install-dsh-mcp.sh` writes. It owns
 *      the same `@deepseek-ai/dsh-mcp-client` row, so leaving it in place means
 *      two rows named `ocu` and two sets of nine tools.
 *   2. `duplicate-serverName` — any other `serverName: ocu` row, including a
 *      stale hand-written one. Commented-out lines are ignored.
 *
 * Repair is deliberately out of scope: `doctor()` reports and prints the command
 * the user should run. Automatically rewriting somebody's patch layer is how a
 * read-only diagnosis turns into data loss.
 *
 * @returns {{ kind: string, line: number, rowId?: string, detail: string, endLine?: number }[]}
 */
export function scanPatchConflicts(text) {
  const lines = String(text).split(/\r?\n/)
  const conflicts = []
  let blockStart = -1

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith(MANAGED_BLOCK_BEGIN)) {
      blockStart = index + 1
      return
    }
    if (trimmed.startsWith(MANAGED_BLOCK_END) && blockStart >= 0) {
      conflicts.push({
        kind: 'managed-block',
        line: blockStart,
        endLine: index + 1,
        detail: MANAGED_BLOCK_BEGIN,
      })
      blockStart = -1
      return
    }
    if (trimmed.startsWith('#')) return
    const match = /^serverName\s*:\s*['"]?ocu['"]?\s*(?:#.*)?$/.exec(trimmed)
    if (match) {
      conflicts.push({
        kind: 'duplicate-serverName',
        line: index + 1,
        rowId: nearestRowId(lines, index),
        detail: trimmed,
      })
    }
  })

  if (blockStart >= 0) {
    conflicts.push({
      kind: 'managed-block',
      line: blockStart,
      endLine: lines.length,
      detail: `${MANAGED_BLOCK_BEGIN} (no closing marker found)`,
    })
  }
  return conflicts
}

/**
 * The exact commands the user should run themselves. Printed, never executed.
 *
 * @returns {string[]}
 */
export function conflictCleanupCommands(conflicts, patchPath) {
  const target = patchPath || '<profile>/cordis.patch.yml'
  return conflicts.map((conflict) => {
    if (conflict.kind === 'managed-block') {
      return `delete lines ${conflict.line}-${conflict.endLine} of ${target} (the ${MANAGED_BLOCK_BEGIN} block): pwsh -NoProfile -Command "$p='${target}'; $l=Get-Content $p; ($l[0..${conflict.line - 2}] + $l[${conflict.endLine}..($l.Count - 1)]) | Set-Content $p"`
    }
    const row = conflict.rowId ? `'${conflict.rowId}'` : 'the row at that line'
    return `remove ${row} (line ${conflict.line}) from ${target}, or set \`disabled: true\` on it`
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * C. Executable discovery
 * ──────────────────────────────────────────────────────────────────────────── */

/** `x64` installs live under `amd64` in the Open Computer Use dist layout. */
function distArch(arch) {
  return arch === 'x64' ? 'amd64' : arch
}

/**
 * Every `<nvm-root>/<version>` directory, newest name first.
 *
 * Two roots are scanned because the two mainstream Windows nvm ports disagree:
 * `nvm-windows` keeps versions under `%LOCALAPPDATA%\nvm`, while `nvm4w` keeps
 * them under `%NVM_HOME%`. Either can hold the `node_modules` an `npm i -g`
 * install produced.
 */
function nvmVersionDirectories(env) {
  const roots = []
  const addRoot = (directory) => {
    if (directory && !roots.includes(directory)) roots.push(directory)
  }
  const localAppData = readEnv(env, 'LOCALAPPDATA')
  addRoot(localAppData ? join(localAppData, 'nvm') : '')
  addRoot(readEnv(env, 'NVM_HOME'))

  const directories = []
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(root, entry.name)
        if (!directories.includes(candidate)) directories.push(candidate)
      }
    } catch {
      /* a missing nvm root is the normal case, not an error */
    }
  }
  return directories.sort().reverse()
}

/** The `node_modules` directory that sits next to the running Node binary. */
function nodeModulesBesideNode() {
  try {
    return join(dirname(process.execPath), 'node_modules')
  } catch {
    return undefined
  }
}

function openComputerUseRelative(platform, arch, tail) {
  return ['open-computer-use', 'dist', platform, distArch(arch), ...tail]
}

/**
 * The four places an `open-computer-use` package can put its executable below
 * one `node_modules` root: the Windows dist, the two POSIX dists, and the macOS
 * app bundle. Shared by the global root (`npm root -g`) and by the local prefix
 * `<cli-home>/node_modules` right after a provision.
 *
 * @returns {string[]} absolute, de-duplicated
 */
export function npmRootCandidates(root, arch = process.arch) {
  if (typeof root !== 'string' || root.length === 0) return []
  return [
    join(root, ...openComputerUseRelative('windows', arch, ['open-computer-use.exe'])),
    join(root, ...openComputerUseRelative('darwin', arch, ['open-computer-use'])),
    join(root, ...openComputerUseRelative('linux', arch, ['open-computer-use'])),
    join(root, 'open-computer-use', 'dist', 'darwin', 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse'),
  ].filter((candidate, index, all) => isAbsolute(candidate) && all.indexOf(candidate) === index)
}

/**
 * Cheap, filesystem-only candidates. No process is started from here.
 *
 * The first candidate is always the plugin-owned home, because that is the
 * location both `cordis.patch.yml` rows agree on and the only place this plugin
 * writes. Everything after it is "some install that already exists on this
 * machine", which adopt can point at.
 *
 * @param {{ platform?: string, arch?: string, env?: object, cliHome?: string }} [options]
 * @returns {string[]} absolute candidate paths, most likely first
 */
export function candidateCommands({ platform = process.platform, arch = process.arch, env = process.env, cliHome = '' } = {}) {
  const found = []
  const add = (...segments) => {
    if (segments.some((segment) => !segment)) return
    const candidate = join(...segments)
    if (isAbsolute(candidate) && !found.includes(candidate)) found.push(candidate)
  }

  /* 1. `<cli-home>` — where the MCP row's `dshHomePath(...)` expression looks. */
  add(expectedCliPath({ cliHome, env, platform }))

  const beside = nodeModulesBesideNode()
  if (platform === 'win32') {
    const winTail = ['open-computer-use.exe']
    add(beside, ...openComputerUseRelative('windows', arch, winTail))
    for (const version of nvmVersionDirectories(env)) {
      add(version, 'node_modules', ...openComputerUseRelative('windows', arch, winTail))
    }
    add(readEnv(env, 'NVM_SYMLINK'), 'node_modules', ...openComputerUseRelative('windows', arch, winTail))
    add(readEnv(env, 'APPDATA'), 'npm', 'node_modules', ...openComputerUseRelative('windows', arch, winTail))
    add(readEnv(env, 'ProgramFiles'), 'nodejs', 'node_modules', ...openComputerUseRelative('windows', arch, winTail))
  } else if (platform === 'darwin') {
    add(homedir(), 'Applications', 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse')
    add('/Applications', 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse')
    add(beside, ...openComputerUseRelative('darwin', arch, ['open-computer-use']))
  } else {
    add(beside, ...openComputerUseRelative('linux', arch, ['open-computer-use']))
  }
  return found
}

/** `npm root -g`, probed only after every cheap candidate has failed. */
function npmGlobalRoot(platform = process.platform) {
  try {
    const output = execFileSync(platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: platform === 'win32',
    })
    const root = String(output).trim()
    return root.length > 0 ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the native executable: explicit configuration first, then the
 * plugin-owned `<cli-home>` path, then per-platform discovery. Never throws; a
 * miss returns the candidate list for diagnostics.
 *
 * `source` tells the caller where the answer came from:
 *
 *   `config`     — an explicit `command` was set on the row.
 *   `cli-home`   — the plugin-owned path exists (adopt or a previous provision).
 *   `discovered` — some other install on this machine.
 *   `not-found`  — nothing; `apply()` decides whether to provision.
 *
 * `candidates` replaces the whole search list, including the `npm root -g`
 * fallback, so "look exactly here" is expressible. It exists so verification can
 * run against a temporary directory instead of the machine's real installs.
 */
export function discoverCommand({
  command = '',
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  cliHome = '',
  candidates: overrideCandidates,
} = {}) {
  const expected = expectedCliPath({ cliHome, env, platform })
  const overridden = Array.isArray(overrideCandidates)
  const candidates = overridden
    ? overrideCandidates.filter((candidate) => typeof candidate === 'string' && isAbsolute(candidate))
    : candidateCommands({ platform, arch, env, cliHome })
  const labelFor = (candidate) => (isSamePath(candidate, expected, platform) ? 'cli-home' : 'discovered')

  if (typeof command === 'string' && command.trim().length > 0) {
    const configured = command.trim()
    return {
      command: configured,
      found: isExecutableFile(configured),
      source: 'config',
      candidates,
      expected,
    }
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return { command: candidate, found: true, source: labelFor(candidate), candidates, expected }
    }
  }

  const npmRoot = overridden ? undefined : npmGlobalRoot(platform)
  if (npmRoot) {
    const npmCandidates = npmRootCandidates(npmRoot, arch)
    for (const candidate of npmCandidates) {
      if (isExecutableFile(candidate)) {
        return {
          command: candidate,
          found: true,
          source: labelFor(candidate),
          candidates: [...candidates, ...npmCandidates],
          expected,
        }
      }
    }
    return { command: undefined, found: false, source: 'not-found', candidates: [...candidates, ...npmCandidates], expected }
  }

  return { command: undefined, found: false, source: 'not-found', candidates, expected }
}

/* ────────────────────────────────────────────────────────────────────────────
 * A. Turn boundary
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Split a command line into argv, honouring single and double quotes.
 * @param {string} text
 * @returns {string[]}
 */
export function splitCommandLine(text) {
  const argv = []
  let current = ''
  let quote = null
  let started = false
  for (const character of String(text)) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (character === ' ' || character === '\t') {
      if (started) {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (started) argv.push(current)
  return argv
}

/**
 * Decide what the turn boundary should run.
 *
 * - `cursorCleanupCommand` set: used verbatim. A single token is treated as an
 *   executable path and `turn-ended` is appended; several tokens are taken as a
 *   complete command line. An explicit override is honoured on every platform.
 * - otherwise: `[command, 'turn-ended']`, macOS only. Windows and Linux have no
 *   software cursor and no `turn-ended` subcommand, so they resolve to a skip
 *   that `apply()` reports in the log.
 *
 * @returns {{ argv?: string[], source: string, reason: string }}
 */
export function resolveCleanupInvocation({
  platform = process.platform,
  command = '',
  cursorCleanupCommand = '',
} = {}) {
  const override = typeof cursorCleanupCommand === 'string' ? cursorCleanupCommand.trim() : ''
  if (override.length > 0) {
    const argv = splitCommandLine(override)
    if (argv.length === 1) argv.push('turn-ended')
    return { argv, source: 'cursorCleanupCommand', reason: 'explicit override' }
  }
  if (platform !== 'darwin') {
    return {
      argv: undefined,
      source: 'platform-skip',
      reason:
        platform === 'win32'
          ? 'Windows has no software cursor and no `turn-ended` subcommand'
          : 'Linux has no software cursor and no `turn-ended` subcommand',
    }
  }
  if (typeof command !== 'string' || command.length === 0) {
    return { argv: undefined, source: 'command-missing', reason: 'no executable to run `turn-ended` with' }
  }
  return { argv: [command, 'turn-ended'], source: 'default', reason: 'macOS software cursor cleanup' }
}

/**
 * Run one cleanup command. Never rejects: every outcome is reported as data, so
 * a broken cleanup can never close a turn.
 *
 * @returns {Promise<{ argv: string[], exitCode: number|null, timedOut: boolean, stdout: string, stderr: string, error?: string }>}
 */
export function runCleanupCommand(
  argv,
  { cwd = process.cwd(), env = process.env, timeoutMs = TURN_BOUNDARY_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    const settle = (value) => resolve({ argv, cwd, ...value })
    if (!Array.isArray(argv) || argv.length === 0) {
      settle({ exitCode: null, timedOut: false, stdout: '', stderr: '', error: 'empty argv' })
      return
    }
    let child
    try {
      child = execFile(
        argv[0],
        argv.slice(1),
        {
          cwd,
          env,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) {
            settle({ exitCode: 0, timedOut: false, stdout: stdout ?? '', stderr: stderr ?? '' })
            return
          }
          settle({
            exitCode: typeof error.code === 'number' ? error.code : null,
            timedOut: Boolean(error.killed),
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: describeError(error),
          })
        },
      )
    } catch (cause) {
      settle({ exitCode: null, timedOut: false, stdout: '', stderr: '', error: describeError(cause) })
    }
    child?.on?.('error', () => {
      /* the execFile callback already reported it */
    })
  })
}

/**
 * Attach the cleanup to the authoritative turn boundary.
 *
 * `agent/turn-stopping` is serial and awaited, and a throwing listener closes
 * the whole turn — therefore the listener swallows everything and reports
 * through the log only. It is one call per turn, and an in-flight cleanup is
 * never duplicated.
 *
 * @returns {() => void} disposer
 */
export function installTurnBoundary(
  ctx,
  { logger, argv, cwd = process.cwd(), env = process.env, timeoutMs = TURN_BOUNDARY_TIMEOUT_MS } = {},
) {
  let inFlight = false
  let disposed = false

  const listener = async ({ turn } = {}) => {
    if (disposed || inFlight) {
      logger?.debug?.(`turn ${turn ?? '?'}: cleanup already in flight; skipped`)
      return
    }
    inFlight = true
    try {
      const result = await runCleanupCommand(argv, { cwd, env, timeoutMs })
      if (result.timedOut) {
        logger?.warn?.(`turn ${turn ?? '?'}: cleanup timed out after ${timeoutMs}ms`)
      } else if (result.exitCode === 0) {
        logger?.info?.(`turn ${turn ?? '?'}: cursor cleanup ok`)
      } else {
        logger?.warn?.(
          `turn ${turn ?? '?'}: cursor cleanup exit=${result.exitCode ?? 'null'} ${truncate(result.stderr || result.stdout || result.error || '')}`,
        )
      }
    } catch (cause) {
      logger?.warn?.(`turn ${turn ?? '?'}: cursor cleanup failed: ${describeError(cause)}`)
    } finally {
      inFlight = false
    }
  }

  try {
    ctx.on('agent/turn-stopping', listener)
  } catch (cause) {
    logger?.warn?.(`could not subscribe to agent/turn-stopping: ${describeError(cause)}`)
  }

  return () => {
    disposed = true
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * B. Skill registration
 * ──────────────────────────────────────────────────────────────────────────── */

/** Directory of this module, and therefore of the bundle's `index.js`. */
export const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Candidate skill directories, nearest first.
 *
 * One artifact serves two layouts, so the skill is looked up in both:
 *
 *   1. `<bundle>/skills/<name>` — a bundle installed from a link is unpacked on
 *      its own, so it carries its own copy of the skill. This is the layout a
 *      tarball or repository install produces.
 *   2. `<bundle>/../skills/<name>` — in this repository the bundle lives one
 *      level below the root, where the skill is the repository's own top-level
 *      `skills/<name>`.
 */
export function skillDirectoryCandidates() {
  return [
    join(MODULE_DIR, 'skills', SKILL_NAME),
    join(MODULE_DIR, '..', 'skills', SKILL_NAME),
  ]
}

/**
 * The first candidate that exists, else the repository layout.
 *
 * Resolving to an existing directory keeps every caller (registration, the
 * activation summary, `doctor`) pointing at the copy that is actually installed,
 * and the fallback keeps `doctor` able to report the missing path.
 */
export function defaultSkillDirectory() {
  const candidates = skillDirectoryCandidates()
  return candidates.find((directory) => existsSync(directory)) ?? candidates[candidates.length - 1]
}

/** Strip a leading YAML front-matter block; its fields are passed explicitly. */
export function stripFrontMatter(content) {
  const text = String(content)
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  const after = text.indexOf('\n', end + 1)
  return after === -1 ? '' : text.slice(after + 1).replace(/^\s*\n/, '')
}

/** Model-facing description; the skill body itself is English. */
export const SKILL_DESCRIPTION =
  'Drive the local desktop GUI with Open Computer Use (ocu): list apps, read app state, then click, type, scroll, drag, press keys, or set values by element index. Use when a task needs real GUI interaction with apps on this machine instead of file or shell work.'

export const SKILL_WHEN_TO_USE =
  'Use when the task needs real GUI interaction with desktop apps on this machine, not file or shell work.'

/**
 * Register the bundled skill. Reading `SKILL.md` is asynchronous while
 * `ctx.skills.register` is synchronous, so the registration is handed to
 * `ctx.effect`, which owns the disposer — and a disposal that lands before the
 * read finishes still unregisters.
 *
 * Never rejects: a missing or unreadable `SKILL.md` degrades to a log line.
 *
 * @returns {Promise<{ ok: boolean, name: string, directory: string, bytes: number, contentBytes: number, error?: string }>}
 */
export function registerSkill(ctx, { logger, directory = defaultSkillDirectory() } = {}) {
  const skillFile = join(directory, 'SKILL.md')
  let disposer
  let disposed = false

  const registration = readFile(skillFile, 'utf8')
    .then((raw) => {
      const content = stripFrontMatter(raw)
      if (disposed) {
        return { ok: false, name: SKILL_NAME, directory, bytes: raw.length, contentBytes: content.length, error: 'disposed before registration' }
      }
      disposer = ctx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        content,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: directory },
      })
      logger?.info?.(`skill registered: ${SKILL_NAME} (${content.length} bytes) from ${skillFile}`)
      return { ok: true, name: SKILL_NAME, directory, bytes: raw.length, contentBytes: content.length }
    })
    .catch((cause) => {
      logger?.warn?.(`skill registration skipped: ${describeError(cause)} (${skillFile})`)
      return { ok: false, name: SKILL_NAME, directory, bytes: 0, contentBytes: 0, error: describeError(cause) }
    })

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        disposed = true
        try {
          disposer?.()
        } catch {
          /* best-effort teardown */
        }
      },
      'open-computer-use skill',
    )
  }

  return registration
}

/* ────────────────────────────────────────────────────────────────────────────
 * Entry point
 * ──────────────────────────────────────────────────────────────────────────── */

/** Merge a row's `config` over `DEFAULT_CONFIG`. */
export function resolveConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) }
}

/**
 * Normalise a raw discovery source into the four labels the activation summary
 * uses, so a reader can see *how* the executable was decided:
 *
 *   `config`    — the row's `command` was set explicitly.
 *   `adopt`     — an install already on the machine was pointed at from
 *                 `<cli-home>` (or was already there).
 *   `discovery` — an install elsewhere on the machine is used as-is.
 *   `provision` — nothing existed, so the plugin installed one.
 */
export function normalizeCommandSource(discoverySource, { adopted, provisioning } = {}) {
  if (discoverySource === 'config') return 'config'
  if (discoverySource === 'cli-home') return 'adopt'
  if (discoverySource === 'discovered') return 'discovery'
  if (provisioning) return 'provision'
  return discoverySource === 'not-found' ? 'not-found' : 'discovery'
}

/**
 * Host half entry point.
 *
 * Everything is registered inside `ctx.effect` / `ctx.on`, so disposing the row
 * removes the listener and unregisters the skill.
 *
 * `<cli-home>` adoption runs FIRST and the optional install is started before
 * anything else, so a machine that has never seen Open Computer Use is already
 * being fixed while the rest of the row wires itself up. Neither step can block
 * or fail activation: adopt is synchronous and wrapped in `try`/`catch`, and the
 * install is a promise whose every outcome — including a rejection — becomes a
 * log line.
 *
 * @param {object} [deps] Test seam, unused by the Harness:
 *   `{ spawnProcess, candidates }` replaces `node:child_process.spawn` for the
 *   (otherwise real) `npm install`, and narrows the executable search to an
 *   explicit path list, so the self-check never touches the network or the
 *   machine's real installs.
 */
export function apply(ctx, config, deps = {}) {
  const options = resolveConfig(config)
  const logger = createLogger(ctx)
  const platform = process.platform
  const arch = process.arch
  const env = process.env
  const toolPrefix = `mcp__${options.serverName}__`
  const searchCandidates = Array.isArray(deps?.candidates) ? deps.candidates : undefined

  if (!Config) {
    logger.warn(
      `@deepseek-ai/schemastery could not be resolved (tried: ${schemastery.attempts.join(' | ')}); row config is used as-is and DEFAULT_CONFIG fills the gaps.`,
    )
  }

  /* ── D. <cli-home>: adopt, then optionally provision ─────────────────────── */
  const configuredCommand = typeof options.command === 'string' ? options.command.trim() : ''
  const cliHome = {
    dir: cliHomeDir({ cliHome: options.cliHome, env }),
    expected: expectedCliPath({ cliHome: options.cliHome, env, platform }),
    shipped: shippedCliPath({ env }),
    adopt: { action: 'skipped', source: '', detail: 'not attempted' },
    provision: 'not attempted',
  }
  if (configuredCommand.length > 0) {
    cliHome.adopt = { action: 'skipped', source: '', detail: 'the row sets `command` explicitly, so <cli-home> is left alone' }
  } else {
    try {
      cliHome.adopt = adoptExistingCli({ cliHome: options.cliHome, env, platform, arch, logger, candidates: searchCandidates })
      logger.info(
        `<cli-home> ${cliHome.dir} expected=${cliHome.expected} shipped=${cliHome.shipped} adopt=${cliHome.adopt.action}${cliHome.adopt.source ? ` source=${cliHome.adopt.source}` : ''} (${cliHome.adopt.detail})`,
      )
    } catch (cause) {
      cliHome.adopt = { action: 'failed', source: '', detail: describeError(cause) }
      logger.warn(`<cli-home> adoption failed: ${describeError(cause)}; nothing else is affected`)
    }
  }

  /* ── C. executable ───────────────────────────────────────────────────────── */
  let discovery = discoverCommand({
    command: options.command,
    platform,
    arch,
    env,
    cliHome: options.cliHome,
    candidates: searchCandidates,
  })
  if (options.command && !discovery.found) {
    logger.warn(`configured command is not an executable file: ${options.command}`)
  }

  if (!discovery.command && configuredCommand.length === 0 && options.autoProvision) {
    cliHome.provision = 'started'
    logger.warn(
      `no Open Computer Use executable found (${discovery.candidates.length} candidate paths, ${cliHome.dir} included); installing it into <cli-home> with a local npm prefix — nothing global is touched, PATH is unchanged.`,
    )
    provisionCli({
      cliHome: options.cliHome,
      env,
      platform,
      arch,
      logger,
      spawnProcess: deps?.spawnProcess,
    })
      .then((outcome) => {
        cliHome.provision = outcome.ok ? `ok (${outcome.action})` : `failed (${outcome.action})`
        // Re-resolve after a successful install: `<cli-home>` now holds the
        // executable, and it is the first thing worth looking at.
        const settled = discoverCommand({
          command: '',
          platform,
          arch,
          env,
          cliHome: options.cliHome,
          candidates: searchCandidates ? [cliHome.expected, ...searchCandidates] : undefined,
        })
        logger.info(
          `provision settled: ok=${outcome.ok} action=${outcome.action} via=${outcome.invocation.via} command=${settled.command ?? '<unresolved>'} source=${normalizeCommandSource(settled.source, { provisioning: outcome.ok })}${outcome.detail ? ` detail=${outcome.detail}` : ''}`,
        )
        if (outcome.ok) {
          logger.warn(
            'Open Computer Use was installed into <cli-home>. Restart the Harness (or toggle this bundle off and on) so the MCP row re-evaluates `dshHomePath(...)` and spawns the new executable.',
          )
        }
      })
      .catch((cause) => {
        cliHome.provision = `failed (${describeError(cause)})`
        logger.warn(`provisioning Open Computer Use failed: ${describeError(cause)}`)
      })
  } else if (!discovery.command && configuredCommand.length === 0) {
    cliHome.provision = 'disabled (autoProvision=false)'
    logger.warn(
      `no Open Computer Use executable found (${discovery.candidates.length} candidate paths) and autoProvision is off. Install it with \`npm i -g open-computer-use\`, or set \`command\` to its absolute path, or set \`autoProvision: true\` to let this plugin install it into ${cliHome.dir}.`,
    )
  }

  /* ── A. turn boundary ────────────────────────────────────────────────────── */
  let turnBoundary = 'disabled (enableTurnBoundaryHook=false)'
  if (options.enableTurnBoundaryHook) {
    const cleanup = resolveCleanupInvocation({
      platform,
      command: discovery.command ?? '',
      cursorCleanupCommand: options.cursorCleanupCommand,
    })
    if (cleanup.argv) {
      installTurnBoundary(ctx, {
        logger,
        argv: cleanup.argv,
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env ?? {}) },
        timeoutMs: TURN_BOUNDARY_TIMEOUT_MS,
      })
      turnBoundary = `armed on platform=${platform} (${cleanup.source}): ${cleanup.argv.join(' ')}`
      logger.info(`turn-boundary hook armed on platform=${platform} via ${cleanup.source}: ${cleanup.argv.join(' ')}`)
    } else {
      turnBoundary = `skipped on platform=${platform} (${cleanup.source})`
      logger.info(
        `turn-boundary hook skipped: platform=${platform} — ${cleanup.reason}. Nothing to clean up, so no command is run.`,
      )
    }
  }

  /* ── B. skill ────────────────────────────────────────────────────────────── */
  let skill = 'disabled (registerSkill=false)'
  if (options.registerSkill) {
    if (ctx.skills && typeof ctx.skills.register === 'function') {
      skill = `registering from ${defaultSkillDirectory()}`
      void registerSkill(ctx, { logger })
    } else {
      skill = 'skipped (ctx.skills.register unavailable)'
      logger.warn('`skills` service is unavailable; the Open Computer Use skill was not registered.')
    }
  }

  logger.info(
    `summary platform=${platform} arch=${arch} serverName=${options.serverName} toolPrefix=${toolPrefix} tools=${EXPECTED_MCP_TOOLS.length} command=${discovery.command ?? '<unresolved>'} (${discovery.source}) commandSource=${normalizeCommandSource(discovery.source, { adopted: cliHome.adopt, provisioning: cliHome.provision === 'started' })} cliHome=${cliHome.dir} expectedCli=${cliHome.expected} shippedCli=${cliHome.shipped} adopt=${cliHome.adopt.action} provision=${cliHome.provision} turnBoundary=${turnBoundary} skill=${skill} schemastery=${schemastery.via || 'unavailable'}`,
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * Self-check (exported for the verifier; no GUI surface)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run one command and capture its result.
 *
 * Never rejects. `execFile` can throw synchronously for a path Windows refuses to
 * load (a text file at the candidate path produces `spawn UNKNOWN`, errno -4094),
 * so the call is wrapped: `doctor()` must be able to *report* an unusable
 * executable rather than die on it.
 */
function runOnce(command, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const settle = (value) => resolve({ command, args, ...value })
    let child
    try {
      child = execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        settle({
          ok: !error,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: error ? describeError(error) : undefined,
        })
      })
    } catch (cause) {
      settle({ ok: false, exitCode: null, stdout: '', stderr: '', error: describeError(cause) })
      return
    }
    child?.on?.('error', () => {
      /* the execFile callback already reported it */
    })
  })
}

/** This module's own `cordis.patch.yml` — the document the parity check reads. */
export const BUNDLE_PATCH_FILE = join(MODULE_DIR, 'cordis.patch.yml')

/**
 * Machine-checkable self assessment.
 *
 * @param {object} [config] row config
 * @param {{ probeTurnEnded?: boolean, platform?: string, arch?: string,
 *   env?: object, profileDir?: string }} [options]
 *   `probeTurnEnded` actually runs `<command> turn-ended`, which is how the
 *   macOS-only claim is verified. `profileDir` overrides where the profile-patch
 *   conflict scan looks, which is how the self-check points it at a temp profile
 *   instead of the caller's.
 */
export async function doctor(
  config = {},
  { probeTurnEnded = false, platform = process.platform, arch = process.arch, env = process.env, profileDir = '' } = {},
) {
  const options = resolveConfig(config)
  const checks = []
  const add = (id, ok, detail, required = true) => checks.push({ id, ok, detail, required })

  const discovery = discoverCommand({ command: options.command, platform, arch, env, cliHome: options.cliHome })
  add(
    'command',
    Boolean(discovery.command),
    discovery.command ? `${discovery.command} (via ${discovery.source})` : `not found; tried ${discovery.candidates.length} candidate paths`,
  )
  if (discovery.command) {
    add('command-executable', isExecutableFile(discovery.command), discovery.command)
    const version = await runOnce(discovery.command, ['version'])
    add(
      'binary-version',
      version.ok,
      version.ok ? truncate(version.stdout, 120) : truncate(version.stderr || version.error || '', 160),
    )
    if (probeTurnEnded) {
      const turnEnded = await runOnce(discovery.command, ['turn-ended'])
      add(
        'turn-ended-subcommand',
        turnEnded.ok,
        turnEnded.ok
          ? truncate(turnEnded.stdout || '(no output)', 120)
          : `exit=${turnEnded.exitCode ?? 'null'} ${truncate(turnEnded.stderr || turnEnded.error || '', 160)}`,
        false,
      )
    }
  }

  /* ── D. <cli-home>: is the location the patch names actually occupied? ───── */
  const cliHome = cliHomeDir({ cliHome: options.cliHome, env })
  const expected = expectedCliPath({ cliHome: options.cliHome, env, platform })
  const shipped = shippedCliPath({ env })
  const commandSource = normalizeCommandSource(discovery.source, { provisioning: false })
  const cliHomeFollowsPatch = isSamePath(resolve(cliHome), resolve(cliHomeDir({ env })), platform)

  add(
    'cli-home-expected',
    isExecutableFile(expected) || Boolean(discovery.command) || Boolean(options.autoProvision),
    `${expected} (${existsSync(expected) ? 'present' : 'absent'}; source=${commandSource}; shipped=${shipped} ${
      existsSync(shipped) ? 'present' : 'absent'
    })${cliHomeFollowsPatch ? '' : ` — cliHome is overridden, so the MCP row's dshHomePath(...) still looks at ${cliHomeDir({ env })} and the plugin links it`}`,
    false,
  )
  add('cli-home-source', Boolean(discovery.command), `commandSource=${commandSource} via ${discovery.source}`, false)

  /**
   * The same-source contract with `cordis.patch.yml`: every `dshHomePath(...)`
   * argument in this bundle's patch must equal `SHIPPED_CLI_RELATIVE_COMMAND`.
   * This is a required check because a drift here makes the MCP row resolve to
   * a path the plugin never creates — the tools would simply be absent.
   */
  try {
    const patchText = await readFile(BUNDLE_PATCH_FILE, 'utf8')
    const argumentsUsed = extractDshHomePathArguments(patchText)
    const mismatched = argumentsUsed.filter((value) => value !== SHIPPED_CLI_RELATIVE_COMMAND)
    add(
      'cli-home-patch-parity',
      argumentsUsed.length > 0 && mismatched.length === 0,
      argumentsUsed.length === 0
        ? `no dshHomePath(...) argument in ${BUNDLE_PATCH_FILE}`
        : `patch=[${argumentsUsed.join(', ')}] code=[${SHIPPED_CLI_RELATIVE_COMMAND}] ${
            mismatched.length === 0 ? 'in sync' : `MISMATCH: ${mismatched.join(', ')}`
          }`,
    )
  } catch (cause) {
    add('cli-home-patch-parity', false, `cannot read ${BUNDLE_PATCH_FILE}: ${describeError(cause)}`)
  }
  add(
    'cli-home-platform-layout',
    cliHomeRelativeCommand(platform) === SHIPPED_CLI_RELATIVE_COMMAND,
    `platform=${platform} native=${cliHomeRelativeCommand(platform)} shipped=${SHIPPED_CLI_RELATIVE_COMMAND}${
      cliHomeRelativeCommand(platform) === SHIPPED_CLI_RELATIVE_COMMAND
        ? ''
        : ' — the shipped expression names the Windows file; the plugin links it to the native binary here'
    }`,
    false,
  )

  /* ── D. profile-patch conflicts: report only, never repair ──────────────── */
  const profileDirectoriesScanned = profileDir ? [profileDir] : profileDirectories(env)
  const profilePatch = profileDirectoriesScanned.map((directory) => join(directory, 'cordis.patch.yml')).find((file) => existsSync(file))
  let conflicts = []
  let cleanupCommands = []
  if (profilePatch) {
    try {
      conflicts = scanPatchConflicts(await readFile(profilePatch, 'utf8'))
      cleanupCommands = conflictCleanupCommands(conflicts, profilePatch)
    } catch (cause) {
      add('profile-patch-scan', true, `could not read ${profilePatch}: ${describeError(cause)}`, false)
    }
  }
  add(
    'profile-patch-clean',
    conflicts.length === 0,
    profilePatch
      ? conflicts.length === 0
        ? `${profilePatch}: no upstream managed block and no other serverName: ocu row`
        : `${profilePatch}: ${conflicts.length} conflict(s) — ${conflicts.map((c) => `${c.kind}@${c.line}${c.rowId ? `(${c.rowId})` : ''}`).join(', ')}`
      : `no profile cordis.patch.yml among ${profileDirectoriesScanned.length} candidate directories`,
    false,
  )

  const skillDirectory = defaultSkillDirectory()
  const skillFile = join(skillDirectory, 'SKILL.md')
  const skillReadable = isReadableFile(skillFile)
  add('skill-file', skillReadable, skillFile)
  if (skillReadable) {
    let bytes = 0
    let wrapped = false
    try {
      const raw = await readFile(skillFile, 'utf8')
      bytes = raw.length
      wrapped = raw.includes('<skill_content')
    } catch {
      /* covered by skill-file */
    }
    add('skill-content', bytes > 0 && !wrapped, `${bytes} bytes${wrapped ? '; unexpected <skill_content> wrapper' : ''}`)
    add('skill-references', existsSync(join(skillDirectory, 'references')), join(skillDirectory, 'references'), false)
  }

  const cleanup = resolveCleanupInvocation({
    platform,
    command: discovery.command ?? '',
    cursorCleanupCommand: options.cursorCleanupCommand,
  })
  add(
    'turn-boundary',
    Boolean(cleanup.argv) || platform !== 'darwin' || Boolean(options.cursorCleanupCommand),
    cleanup.argv ? `would run: ${cleanup.argv.join(' ')} (${cleanup.source})` : `no-op: ${cleanup.reason}`,
    false,
  )

  return {
    ok: checks.filter((check) => check.required).every((check) => check.ok),
    platform,
    arch,
    node: process.version,
    profileDirectories: profileDirectoriesScanned,
    schemastery: { resolved: Boolean(z), via: schemastery.via, attempts: schemastery.attempts },
    inject,
    serverName: options.serverName,
    toolPrefix: `mcp__${options.serverName}__`,
    expectedMcpTools: EXPECTED_MCP_TOOLS.map((tool) => `mcp__${options.serverName}__${tool}`),
    command: discovery.command,
    commandSource: discovery.source,
    commandCandidates: discovery.candidates,
    cliHome: {
      dir: cliHome,
      expected,
      expectedPresent: existsSync(expected),
      shipped,
      shippedPresent: existsSync(shipped),
      autoProvision: options.autoProvision,
      relativeCommand: cliHomeRelativeCommand(platform),
      shippedRelativeCommand: SHIPPED_CLI_RELATIVE_COMMAND,
      patchFile: BUNDLE_PATCH_FILE,
      resolvedFrom: commandSource,
    },
    profilePatch: {
      file: profilePatch ?? '',
      conflicts,
      cleanupCommands,
      note: 'reported only — this plugin never rewrites a profile patch layer',
    },
    skill: { name: SKILL_NAME, directory: skillDirectory, file: skillFile },
    turnBoundary: { enabled: options.enableTurnBoundaryHook, argv: cleanup.argv, source: cleanup.source, reason: cleanup.reason },
    checks,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * `node index.js --doctor` — the same report on stdout, no Harness required.
 * ──────────────────────────────────────────────────────────────────────────── */

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  process.argv[1].length > 0 &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly && process.argv.includes('--doctor')) {
  const report = await doctor({}, { probeTurnEnded: process.argv.includes('--probe-turn-ended') })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}
