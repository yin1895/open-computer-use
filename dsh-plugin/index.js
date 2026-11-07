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

import { execFile, execFileSync } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
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
function profileDirectories() {
  const found = []
  const add = (dir) => {
    if (dir && !found.includes(dir)) found.push(dir)
  }
  add(process.env.DSH_PROFILE_DIR)
  const dshHome =
    process.env.DSH_HOME || join(homedir(), '.dsh')
  add(process.env.DSH_PROFILE ? join(dshHome, 'profiles', process.env.DSH_PROFILE) : '')
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
 * C. Executable discovery
 * ──────────────────────────────────────────────────────────────────────────── */

/** `x64` installs live under `amd64` in the Open Computer Use dist layout. */
function distArch(arch) {
  return arch === 'x64' ? 'amd64' : arch
}

/** Every `<localappdata>/nvm/<version>` directory, newest name first. */
function nvmVersionDirectories(env) {
  const localAppData = readEnv(env, 'LOCALAPPDATA')
  if (!localAppData) return []
  const nvm = join(localAppData, 'nvm')
  try {
    return readdirSync(nvm, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(nvm, entry.name))
      .sort()
      .reverse()
  } catch {
    return []
  }
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
 * Cheap, filesystem-only candidates. No process is started from here.
 * @returns {string[]} absolute candidate paths, most likely first
 */
export function candidateCommands({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const found = []
  const add = (...segments) => {
    if (segments.some((segment) => !segment)) return
    const candidate = join(...segments)
    if (isAbsolute(candidate) && !found.includes(candidate)) found.push(candidate)
  }

  const beside = nodeModulesBesideNode()
  if (platform === 'win32') {
    const winTail = ['open-computer-use.exe']
    add(beside, ...openComputerUseRelative('windows', 'amd64', winTail))
    for (const version of nvmVersionDirectories(env)) {
      add(version, 'node_modules', ...openComputerUseRelative('windows', 'amd64', winTail))
    }
    add(readEnv(env, 'APPDATA'), 'npm', 'node_modules', ...openComputerUseRelative('windows', 'amd64', winTail))
    add(readEnv(env, 'ProgramFiles'), 'nodejs', 'node_modules', ...openComputerUseRelative('windows', 'amd64', winTail))
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
 * Resolve the native executable: explicit configuration first, then per-platform
 * discovery. Never throws; a miss returns the candidate list for diagnostics.
 */
export function discoverCommand({
  command = '',
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const candidates = candidateCommands({ platform, arch, env })

  if (typeof command === 'string' && command.trim().length > 0) {
    const configured = command.trim()
    return {
      command: configured,
      found: isExecutableFile(configured),
      source: 'config',
      candidates,
    }
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return { command: candidate, found: true, source: 'discovered', candidates }
  }

  const npmRoot = npmGlobalRoot(platform)
  if (npmRoot) {
    const tail =
      platform === 'win32'
        ? ['open-computer-use.exe']
        : ['open-computer-use']
    const npmCandidates = [
      join(npmRoot, ...openComputerUseRelative('windows', 'amd64', tail)),
      join(npmRoot, ...openComputerUseRelative('darwin', arch, tail)),
      join(npmRoot, ...openComputerUseRelative('linux', arch, tail)),
      join(npmRoot, 'open-computer-use', 'dist', 'darwin', 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse'),
    ].filter(
      (candidate, index, all) =>
        isAbsolute(candidate) && all.indexOf(candidate) === index,
    )
    for (const candidate of npmCandidates) {
      if (isExecutableFile(candidate)) {
        return { command: candidate, found: true, source: `npm-root:${npmRoot}`, candidates: [...candidates, ...npmCandidates] }
      }
    }
    return { command: undefined, found: false, source: 'not-found', candidates: [...candidates, ...npmCandidates] }
  }

  return { command: undefined, found: false, source: 'not-found', candidates }
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
 * Host half entry point.
 *
 * Everything is registered inside `ctx.effect` / `ctx.on`, so disposing the row
 * removes the listener and unregisters the skill.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  const logger = createLogger(ctx)
  const platform = process.platform
  const toolPrefix = `mcp__${options.serverName}__`

  if (!Config) {
    logger.warn(
      `@deepseek-ai/schemastery could not be resolved (tried: ${schemastery.attempts.join(' | ')}); row config is used as-is and DEFAULT_CONFIG fills the gaps.`,
    )
  }

  /* ── C. executable ───────────────────────────────────────────────────────── */
  const discovery = discoverCommand({ command: options.command, platform })
  if (options.command && !discovery.found) {
    logger.warn(`configured command is not an executable file: ${options.command}`)
  }
  if (!discovery.command) {
    logger.warn(
      `no Open Computer Use executable found (tried ${discovery.candidates.length} paths). Install it with \`npm i -g open-computer-use\` or set \`command\` to its absolute path.`,
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
    `summary platform=${platform} arch=${process.arch} serverName=${options.serverName} toolPrefix=${toolPrefix} tools=${EXPECTED_MCP_TOOLS.length} command=${discovery.command ?? '<unresolved>'} (${discovery.source}) turnBoundary=${turnBoundary} skill=${skill} schemastery=${schemastery.via || 'unavailable'}`,
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * Self-check (exported for the verifier; no GUI surface)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Run one command and capture its result; never throws. */
function runOnce(command, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error ? describeError(error) : undefined,
      })
    })
  })
}

/**
 * Machine-checkable self assessment.
 *
 * @param {object} [config] row config
 * @param {{ probeTurnEnded?: boolean }} [options] `probeTurnEnded` actually runs
 *   `<command> turn-ended`, which is how the macOS-only claim is verified.
 */
export async function doctor(config = {}, { probeTurnEnded = false, platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const options = resolveConfig(config)
  const checks = []
  const add = (id, ok, detail, required = true) => checks.push({ id, ok, detail, required })

  const discovery = discoverCommand({ command: options.command, platform, arch, env })
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
    profileDirectories: profileDirectories(),
    schemastery: { resolved: Boolean(z), via: schemastery.via, attempts: schemastery.attempts },
    inject,
    serverName: options.serverName,
    toolPrefix: `mcp__${options.serverName}__`,
    expectedMcpTools: EXPECTED_MCP_TOOLS.map((tool) => `mcp__${options.serverName}__${tool}`),
    command: discovery.command,
    commandSource: discovery.source,
    commandCandidates: discovery.candidates,
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
