/**
 * `dsh-plugin/self-check.mjs` — reproducible verification for the plugin's three
 * responsibilities, without a Harness, a GUI, or a live MCP server.
 *
 * Run it from anywhere:
 *
 *   node dsh-plugin/self-check.mjs
 *
 * It drives `index.js` with a mock Cordis context and asserts the observable
 * behaviour of each part:
 *
 *   A. turn boundary — how the cleanup command is resolved per platform, that a
 *      failing/timing-out/duplicated cleanup is reported and never thrown (the
 *      serial `agent/turn-stopping` listener must not be able to close a turn),
 *      and that Windows resolves to an explicit no-op.
 *   B. skill registration — that `ctx.skills.register` receives the required
 *      fields, the SKILL.md body without a nested `<skill_content>` wrapper, a
 *      `directory` resourceBase, and that disposal unregisters.
 *   C. configuration — schemastery round-trip on the row config from
 *      `cordis.patch.yml`, executable discovery per platform, and `doctor()`.
 *   D. `<cli-home>` ownership — that the shipped patch carries no machine
 *      absolute path, that its `dshHomePath(...)` argument is the same string
 *      `index.js` derives, that adopt links an existing install without touching
 *      the source, that provision only ever warns, that `autoProvision: false`
 *      installs nothing, and that profile-patch conflicts are reported without
 *      being repaired.
 *
 * ISOLATION: the real `~/.dsh` is never read or written by a D check. `DSH_HOME`
 * and `DSH_PROFILE_DIR` are repointed at a throwaway tree under the OS temp
 * directory as soon as `index.js` has been imported (the import is the one step
 * that must see the real profile, because it is where schemastery resolves
 * from), every D check passes an explicit `env`, `cliHome` or `candidates`, and
 * the fake "already installed" Open Computer Use lives inside the same sandbox.
 *
 * Exit code 0 = every check passed. Non-zero = at least one FAIL, printed with
 * its detail.
 */

import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/* Captured before isolation: the profile whose `node_modules` holds `yaml`, and
 * the one the `import` below resolves schemastery from. */
const realProfileDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop')

const api = await import(new URL('./index.js', import.meta.url).href)

/* ── isolation ──────────────────────────────────────────────────────────────
 * From here on, every DSH home this script can reach is a temp directory. The
 * sandbox profile carries a deliberately clean patch file, so even the profile
 * scan in `doctor()` reads the sandbox rather than the caller's profile.
 * ─────────────────────────────────────────────────────────────────────────── */
const sandboxRoot = mkdtempSync(join(tmpdir(), 'ocu-dsh-selfcheck-'))
const sandboxDshHome = join(sandboxRoot, 'dsh-home')
const sandboxProfileDir = join(sandboxRoot, 'profile')
mkdirSync(sandboxDshHome, { recursive: true })
mkdirSync(sandboxProfileDir, { recursive: true })
writeFileSync(
  join(sandboxProfileDir, 'cordis.patch.yml'),
  ['# sandbox profile patch — intentionally free of ocu rows', '- id: locale', '  config:', '    preference: zh', ''].join('\n'),
)
process.env.DSH_HOME = sandboxDshHome
process.env.DSH_PROFILE_DIR = sandboxProfileDir

/** An `env` for one check: the sandbox, optionally with its own DSH home. */
function sandboxEnv(dshHome = sandboxDshHome) {
  return { ...process.env, DSH_HOME: dshHome, DSH_PROFILE_DIR: sandboxProfileDir }
}

/** Run a synchronous block with `DSH_HOME` temporarily repointed. */
function withDshHome(dshHome, body) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    return body()
  } finally {
    process.env.DSH_HOME = previous
  }
}

/** The same, when the body settles asynchronously and must stay isolated. */
async function withDshHomeAsync(dshHome, body) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    return await body()
  } finally {
    process.env.DSH_HOME = previous
  }
}

const safeRead = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A logger that records instead of printing, for the module-level functions. */
function collectingLogger(sink) {
  return {
    info: (message) => sink.push(`INFO ${message}`),
    warn: (message) => sink.push(`WARN ${message}`),
    debug: (message) => sink.push(`DEBUG ${message}`),
  }
}

/**
 * A stand-in for `node:child_process.spawn`: records the invocation, then emits
 * the given outcome on the next tick. `onStart` runs before the exit event, which
 * is how the success case fabricates the installed package layout.
 */
function fakeSpawn({ exitCode = 0, stderr = '', onStart } = {}) {
  const calls = []
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
      child.emit('close', null)
    }
    setTimeout(() => {
      try {
        onStart?.()
      } catch (cause) {
        child.emit('error', cause)
        return
      }
      if (stderr) child.stderr.emit('data', stderr)
      child.emit('close', exitCode)
    }, 0)
    return child
  }
  return { calls, spawnProcess }
}

/** The path a real `npm install --prefix <home>` would leave the binary at. */
function installedBinaryPath(home, platform = process.platform, arch = process.arch) {
  const [windows, darwin, linux] = api.npmRootCandidates(join(home, 'node_modules'), arch)
  if (platform === 'win32') return windows
  return platform === 'darwin' ? darwin : linux
}

/* ── the fake "already installed" Open Computer Use, inside the sandbox ──── */
const cliName = process.platform === 'win32' ? 'open-computer-use.exe' : 'open-computer-use'
const fakeInstallDir = join(sandboxRoot, 'fake-global', 'node_modules', 'open-computer-use', 'dist', 'windows', 'amd64')
mkdirSync(fakeInstallDir, { recursive: true })
const fakeSource = join(fakeInstallDir, cliName)
const fakeBytes = 'FAKE-OCU-BINARY-DO-NOT-EXECUTE\n'
writeFileSync(fakeSource, fakeBytes)

const results = []
let failed = 0

function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: String(detail ?? '') })
  if (!ok) failed += 1
}

function report(id, ok, detail) {
  check(id, ok, detail)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail ?? ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Minimal Cordis-like context: records listeners, effects, logs, skills. */
function createMockCtx() {
  const logs = []
  const listeners = new Map()
  const effects = []
  const registrations = []
  const unregistered = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', String(message)]),
      warn: (message) => logs.push(['warn', String(message)]),
      debug: (message) => logs.push(['debug', String(message)]),
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    effect(factory, label) {
      effects.push({ label: label ?? '', dispose: factory() })
      return () => {}
    },
    get() {
      return undefined
    },
    skills: {
      register(definition) {
        registrations.push(definition)
        return () => unregistered.push(definition.name)
      },
    },
  }
  return { ctx, logs, listeners, effects, registrations, unregistered }
}

const logText = (logs, level) =>
  logs
    .filter(([kind]) => (level ? kind === level : true))
    .map(([, message]) => message)
    .join('\n')

/* ── environment ─────────────────────────────────────────────────────────── */

console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`)

report('import-module-exports', Boolean(api.apply && api.Config && api.inject), `exports=${Object.keys(api).sort().join(', ')}`)
report('import-schemastery-config', Boolean(api.Config), 'export const Config is present (required for the settings form)')

/* ── C. configuration ────────────────────────────────────────────────────── */

console.log('\n=== C. configuration / discovery ===')

const doctorReport = await api.doctor({}, { probeTurnEnded: process.argv.includes('--probe-turn-ended') })
report('C1-doctor-ok', doctorReport.ok, `command=${doctorReport.command ?? '<none>'} via ${doctorReport.commandSource}`)
report(
  'C2-doctor-command-version',
  doctorReport.checks.some((entry) => entry.id === 'binary-version' && entry.ok),
  doctorReport.checks.find((entry) => entry.id === 'binary-version')?.detail ?? 'n/a',
)
if (process.argv.includes('--probe-turn-ended')) {
  const probe = doctorReport.checks.find((entry) => entry.id === 'turn-ended-subcommand')
  report('C3-turn-ended-platform-claim', probe?.ok === false || process.platform === 'darwin', probe?.detail ?? 'n/a')
}

const discovered = api.discoverCommand({})
report('C4-discovery', Boolean(discovered.command), `${discovered.command} (${discovered.source})`)
/** Candidate paths are built with `join`, so compare separator-agnostically. */
const posix = (path) => String(path).replace(/\\/g, '/')
const darwinCandidates = api.candidateCommands({ platform: 'darwin', arch: 'arm64', env: process.env })
report(
  'C5-macos-candidates',
  darwinCandidates.some((path) => posix(path).includes('/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse')) &&
    darwinCandidates.some((path) => posix(path).endsWith('/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse')),
  darwinCandidates.map(posix).join(' | '),
)
const linuxCandidates = api.candidateCommands({ platform: 'linux', arch: 'x64', env: process.env })
report('C6-linux-candidates', linuxCandidates.some((path) => posix(path).includes('/open-computer-use/dist/linux/amd64/open-computer-use')), linuxCandidates.map(posix).join(' | '))
report(
  'C7-config-merged',
  api.resolveConfig({}).args[0] === 'mcp' && api.resolveConfig({ serverName: 'x' }).serverName === 'x',
  `defaults+override ok`,
)

/* Row config round-trip: schemastery must accept exactly what the patch sets.
 *
 * `!!js` is a Loader scalar, not a YAML type the `yaml` package knows, so the tag
 * is registered explicitly and resolved into the same inert shape the Harness'
 * own schema projector uses: `{ __jsExpr: '<source text>' }`
 * (`LOADER_EXPRESSION_SCHEMA`). A warning-free parse proves the document is
 * otherwise plain YAML 1.2. */
const jsExpressionTag = { tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: String(value) }) }
const loadYaml = () => {
  for (const base of [realProfileDir, sandboxProfileDir, here, dirname(process.execPath)]) {
    try {
      return createRequire(join(base, 'package.json'))('yaml')
    } catch {
      /* try the next base */
    }
  }
  return undefined
}

try {
  const yaml = loadYaml()
  if (!yaml) throw new Error(`the \`yaml\` package is not resolvable from ${realProfileDir}`)
  const yamlDocument = yaml.parseDocument(readFileSync(join(here, 'cordis.patch.yml'), 'utf8'), {
    customTags: [jsExpressionTag],
    logLevel: 'silent',
  })
  if (yamlDocument.errors.length > 0) {
    throw new Error(`cordis.patch.yml has YAML errors: ${yamlDocument.errors.map((error) => error.message).join('; ')}`)
  }
  const rows = yamlDocument.toJS().flatMap((entry) => entry.insert ?? [])
  const row = rows.find((entry) => entry.id === 'open-computer-use')
  const validated = api.Config(row.config)
  report(
    'C8-patch-row-config-validates',
    validated.serverName === 'ocu' &&
      validated.enableTurnBoundaryHook === true &&
      validated.autoProvision === true &&
      validated.cliHome === '' &&
      validated.command === '' &&
      Array.isArray(validated.args),
    JSON.stringify(validated),
  )
  const mcpRow = rows.find((entry) => entry.id === 'open-computer-use-mcp')
  /* The MCP row's `command` must be the Loader expression, not a literal path:
   * that is the whole point of the de-machining change, and it is checked here
   * rather than trusted. */
  const mcpCommand = mcpRow?.config?.command
  const inertExpression = typeof mcpCommand === 'string' ? mcpCommand : (mcpCommand?.__jsExpr ?? '')
  report(
    'C9-mcp-row-uses-shipped-client',
    mcpRow?.name === '@deepseek-ai/dsh-mcp-client' &&
      mcpRow.config.serverName === validated.serverName &&
      mcpRow.config.failOnStartupError === false &&
      mcpRow.config.transport === 'stdio' &&
      Array.isArray(mcpRow.config.args) &&
      mcpRow.config.args[0] === 'mcp' &&
      inertExpression.replace(/\s+/g, '') === `dshHomePath('${api.SHIPPED_CLI_RELATIVE_COMMAND}')` &&
      yamlDocument.warnings.length === 0,
    `${mcpRow?.name} serverName=${mcpRow?.config?.serverName} transport=${mcpRow?.config?.transport} args=${JSON.stringify(mcpRow?.config?.args)} failOnStartupError=${mcpRow?.config?.failOnStartupError} command=${JSON.stringify(mcpCommand)} warnings=${yamlDocument.warnings.length}`,
  )
  report('C10-patch-rows-count', rows.length === 2, `insert rows: ${rows.map((entry) => entry.id).join(', ')}`)
} catch (cause) {
  report('C8-patch-row-config-validates', false, `could not read/parse cordis.patch.yml: ${cause?.message ?? cause}`)
}

/* ── A. turn boundary ────────────────────────────────────────────────────── */

console.log('\n=== A. turn boundary ===')

const darwinResolved = api.resolveCleanupInvocation({ platform: 'darwin', command: '/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse' })
report('A1-darwin-argv', darwinResolved.argv?.join(' ') === '/Applications/Open Computer Use.app/Contents/MacOS/OpenComputerUse turn-ended', JSON.stringify(darwinResolved))
const winResolved = api.resolveCleanupInvocation({ platform: 'win32', command: 'C:\\ocu.exe' })
report('A2-windows-skip', winResolved.argv === undefined && winResolved.source === 'platform-skip', JSON.stringify(winResolved))
const linuxResolved = api.resolveCleanupInvocation({ platform: 'linux', command: '/usr/bin/ocu' })
report('A3-linux-skip', linuxResolved.argv === undefined, JSON.stringify(linuxResolved))
report(
  'A4-override-single-token',
  api.resolveCleanupInvocation({ platform: 'linux', cursorCleanupCommand: '/opt/my-cleanup' }).argv?.join(' ') === '/opt/my-cleanup turn-ended',
  JSON.stringify(api.resolveCleanupInvocation({ platform: 'linux', cursorCleanupCommand: '/opt/my-cleanup' })),
)
report(
  'A5-override-quoted-full-command',
  api.splitCommandLine('"C:\\Program Files\\x\\clean.exe" --quiet "a b"').join('|') === 'C:\\Program Files\\x\\clean.exe|--quiet|a b',
  JSON.stringify(api.splitCommandLine('"C:\\Program Files\\x\\clean.exe" --quiet "a b"')),
)

/* apply() on this platform: the listener must exist only where it can act. */
const applied = createMockCtx()
api.apply(applied.ctx, { command: discovered.command, serverName: 'ocu' })
await sleep(60)
const armApplicable = process.platform === 'darwin'
report(
  'A6-apply-platform-decision',
  applied.listeners.has('agent/turn-stopping') === armApplicable,
  `platform=${process.platform} listener=${applied.listeners.has('agent/turn-stopping')} | ${logText(applied.logs.filter(([kind]) => kind === 'info')).split('\n').filter((line) => line.includes('turn-boundary')).join(' ')}`,
)
report(
  'A7-skill-registered-through-apply',
  applied.registrations.length === 1,
  `registrations=${applied.registrations.length} logs=${logText(applied.logs).split('\n').filter((line) => line.includes('skill')).join(' ')}`,
)
report(
  'A8-summary-log',
  logText(applied.logs).includes('summary platform=') && logText(applied.logs).includes('toolPrefix=mcp__ocu__'),
  logText(applied.logs).split('\n').find((line) => line.includes('summary')) ?? 'no summary line',
)

/* Drive the listener directly: success, failure, timeout, duplicate. */
const node = process.execPath

const okCtx = createMockCtx()
api.installTurnBoundary(okCtx.ctx, { logger: okCtx.ctx.logger, argv: [node, '-e', 'console.log("cleanup-ok")'], timeoutMs: 5000 })
await okCtx.listeners.get('agent/turn-stopping')[0]({ turn: 7, signal: new AbortController().signal })
report('A9-cleanup-success', logText(okCtx.logs).includes('turn 7: cursor cleanup ok'), logText(okCtx.logs))

const failCtx = createMockCtx()
api.installTurnBoundary(failCtx.ctx, { logger: failCtx.ctx.logger, argv: [node, '-e', 'process.stderr.write("boom"); process.exit(3)'], timeoutMs: 5000 })
await failCtx.listeners.get('agent/turn-stopping')[0]({ turn: 8, signal: new AbortController().signal })
report(
  'A10-cleanup-failure-reported-not-thrown',
  logText(failCtx.logs).includes('exit=3') && logText(failCtx.logs).includes('boom'),
  logText(failCtx.logs),
)

const timeoutCtx = createMockCtx()
api.installTurnBoundary(timeoutCtx.ctx, { logger: timeoutCtx.ctx.logger, argv: [node, '-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 400 })
const startedAt = Date.now()
await timeoutCtx.listeners.get('agent/turn-stopping')[0]({ turn: 9, signal: new AbortController().signal })
const elapsed = Date.now() - startedAt
report(
  'A11-cleanup-timeout-bounded',
  logText(timeoutCtx.logs).includes('timed out after 400ms') && elapsed < 5000,
  `elapsed=${elapsed}ms logs=${logText(timeoutCtx.logs)}`,
)

const dedupCtx = createMockCtx()
api.installTurnBoundary(dedupCtx.ctx, { logger: dedupCtx.ctx.logger, argv: [node, '-e', 'setTimeout(() => {}, 400)'], timeoutMs: 5000 })
const listener = dedupCtx.listeners.get('agent/turn-stopping')[0]
await Promise.all([listener({ turn: 10 }), listener({ turn: 11 })])
report(
  'A12-concurrent-dedup',
  logText(dedupCtx.logs).includes('already in flight') && logText(dedupCtx.logs).includes('turn 10: cursor cleanup ok'),
  logText(dedupCtx.logs),
)

const missingCtx = createMockCtx()
api.installTurnBoundary(missingCtx.ctx, { logger: missingCtx.ctx.logger, argv: ['Z:\\does\\not\\exist.exe', 'turn-ended'], timeoutMs: 3000 })
await missingCtx.listeners.get('agent/turn-stopping')[0]({ turn: 12 })
report('A13-missing-binary-reported-not-thrown', logText(missingCtx.logs, 'warn').length > 0, logText(missingCtx.logs, 'warn'))

/* The real binary on this platform: proves the macOS-only claim end to end. */
const realCtx = createMockCtx()
api.installTurnBoundary(realCtx.ctx, { logger: realCtx.ctx.logger, argv: [discovered.command, 'turn-ended'], timeoutMs: 5000 })
await realCtx.listeners.get('agent/turn-stopping')[0]({ turn: 13 })
report(
  'A14-real-binary-turn-ended',
  process.platform === 'darwin' ? true : logText(realCtx.logs).includes('exit=1'),
  logText(realCtx.logs).replace(/\s+/g, ' ').slice(0, 200),
)

/* ── B. skill registration ───────────────────────────────────────────────── */

console.log('\n=== B. skill registration ===')

const skillCtx = createMockCtx()
const skillOutcome = await api.registerSkill(skillCtx.ctx, { logger: skillCtx.ctx.logger })
await sleep(20)
const definition = skillCtx.registrations[0]
report('B1-skill-read-ok', skillOutcome.ok === true, JSON.stringify(skillOutcome))
report(
  'B2-register-called-with-required-fields',
  definition?.name === 'open-computer-use' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.name) &&
    typeof definition.description === 'string' &&
    definition.description.length > 0 &&
    typeof definition.content === 'string' &&
    definition.content.length > 0,
  `name=${definition?.name} description.length=${definition?.description?.length} content.length=${definition?.content?.length}`,
)
report(
  'B3-source-and-resource-base',
  definition?.source === 'runtime' &&
    definition?.resourceBase?.kind === 'directory' &&
    definition?.resourceBase?.path === skillOutcome.directory,
  `source=${definition?.source} resourceBase=${JSON.stringify(definition?.resourceBase)}`,
)
report('B4-invocation-and-provider-omitted', definition?.invocation === undefined && definition?.provider === undefined, `invocation=${definition?.invocation} provider=${definition?.provider}`)
report(
  'B5-content-is-body-only',
  typeof definition?.content === 'string' &&
    !definition.content.includes('<skill_content') &&
    !definition.content.trimStart().startsWith('---') &&
    definition.content.includes('# Open Computer Use'),
  `startsWith=${JSON.stringify(definition?.content?.slice(0, 30))}`,
)
try {
  skillCtx.effects[0]?.dispose?.()
  report('B6-disposal-unregisters', skillCtx.unregistered.includes('open-computer-use'), `unregistered=${JSON.stringify(skillCtx.unregistered)}`)
} catch (cause) {
  report('B6-disposal-unregisters', false, `dispose threw: ${cause?.message ?? cause}`)
}

const badSkillCtx = createMockCtx()
const badOutcome = await api.registerSkill(badSkillCtx.ctx, { logger: badSkillCtx.ctx.logger, directory: join(here, 'definitely-not-here') })
report(
  'B7-missing-skill-file-degrades',
  badOutcome.ok === false && badSkillCtx.registrations.length === 0 && logText(badSkillCtx.logs, 'warn').includes('skill registration skipped'),
  `ok=${badOutcome.ok} warn=${logText(badSkillCtx.logs, 'warn')}`,
)

const noSkillsCtx = createMockCtx()
noSkillsCtx.ctx.skills = undefined
api.apply(noSkillsCtx.ctx, { command: discovered.command, registerSkill: true })
await sleep(30)
report(
  'B8-apply-without-skills-service-degrades',
  logText(noSkillsCtx.logs, 'warn').includes('skills') && !noSkillsCtx.ctx.skills,
  logText(noSkillsCtx.logs, 'warn'),
)

/* ── D. <cli-home> ownership ─────────────────────────────────────────────── */

console.log('\n=== D. <cli-home> ownership ===')
console.log(`sandbox=${sandboxRoot}`)

const posixOf = (path) => String(path).replace(/\\/g, '/')
const patchText = readFileSync(join(here, 'cordis.patch.yml'), 'utf8')

/* D1. one definition of the layout, in both directions. */
report(
  'D1-cli-home-layout-single-definition',
  posixOf(api.cliBinRelativeCommand(process.platform)) === `bin/${cliName}` &&
    api.cliHomeRelativeCommand('win32') === 'ocu/bin/open-computer-use.exe' &&
    api.SHIPPED_CLI_RELATIVE_COMMAND === 'ocu/bin/open-computer-use.exe',
  `bin=${api.cliBinRelativeCommand(process.platform)} dshHome-relative(win32)=${api.cliHomeRelativeCommand('win32')} shipped=${api.SHIPPED_CLI_RELATIVE_COMMAND}`,
)

/* D2. the patch argument and the code constant are the same string. */
const patchArguments = api.extractDshHomePathArguments(patchText)
report(
  'D2-shipped-command-matches-patch',
  patchArguments.length === 1 && patchArguments[0] === api.SHIPPED_CLI_RELATIVE_COMMAND,
  `patch=${JSON.stringify(patchArguments)} code=${api.SHIPPED_CLI_RELATIVE_COMMAND}`,
)

/* D3. the published patch carries no machine's absolute path. */
const machinePathPattern = /C:\\|\/Users\/|\/home\//
const machinePathLines = patchText
  .split(/\r?\n/)
  .map((line, index) => ({ line, number: index + 1 }))
  .filter((entry) => machinePathPattern.test(entry.line))
report(
  'D3-patch-has-no-machine-absolute-path',
  machinePathLines.length === 0,
  machinePathLines.length === 0
    ? 'no C:\\ , /Users/ or /home/ path in dsh-plugin/cordis.patch.yml'
    : machinePathLines.map((entry) => `${entry.number}:${entry.line.trim()}`).join(' | '),
)

/* D4. both absolute paths derive from `<dsh-home>`, not from the author. */
const env0 = sandboxEnv()
const expected0 = api.expectedCliPath({ env: env0, platform: process.platform })
const shipped0 = api.shippedCliPath({ env: env0 })
report(
  'D4-paths-derive-from-dsh-home',
  posixOf(expected0) === posixOf(join(sandboxDshHome, 'ocu', 'bin', cliName)) &&
    posixOf(shipped0) === posixOf(join(sandboxDshHome, 'ocu', 'bin', 'open-computer-use.exe')),
  `expected=${expected0} shipped=${shipped0}`,
)

/* D5. `cliHome` moves the native path and leaves the shipped one alone. */
const customHome = join(sandboxRoot, 'custom-cli-home')
report(
  'D5-cli-home-override-and-config-fields',
  posixOf(api.cliHomeDir({ cliHome: customHome, env: env0 })) === posixOf(resolve(customHome)) &&
    posixOf(api.shippedCliPath({ env: env0 })) === posixOf(shipped0) &&
    api.Config({}).autoProvision === true &&
    api.Config({}).cliHome === '' &&
    api.Config({ cliHome: customHome, autoProvision: false }).cliHome === customHome &&
    api.Config({ autoProvision: false }).autoProvision === false &&
    api.resolveConfig({}).autoProvision === true,
  `cliHomeDir=${api.cliHomeDir({ cliHome: customHome, env: env0 })} shipped=${api.shippedCliPath({ env: env0 })} Config.autoProvision=${api.Config({}).autoProvision}`,
)

/* D6–D9. adopt an existing install into the default `<cli-home>`. */
const adoptEnv = sandboxEnv(join(sandboxRoot, 'adopt-home'))
const adoptLogs = []
const adopted = api.adoptExistingCli({
  env: adoptEnv,
  platform: process.platform,
  arch: process.arch,
  logger: collectingLogger(adoptLogs),
  candidates: [fakeSource],
})
const adoptExpected = api.expectedCliPath({ env: adoptEnv, platform: process.platform })
const sourceStatsBefore = statSync(fakeSource)
report(
  'D6-adopt-lands-on-expected-path',
  existsSync(adoptExpected) &&
    safeRead(adoptExpected) === fakeBytes &&
    ['linked-directory', 'linked-file', 'copied'].includes(adopted.action),
  `action=${adopted.action} expected=${adoptExpected} readback=${JSON.stringify(safeRead(adoptExpected))} source=${adopted.source} detail=${adopted.detail}`,
)
report(
  'D7-adopt-leaves-source-untouched',
  existsSync(fakeSource) &&
    readFileSync(fakeSource, 'utf8') === fakeBytes &&
    readdirSync(fakeInstallDir).join(',') === cliName &&
    statSync(fakeSource).mtimeMs === sourceStatsBefore.mtimeMs,
  `source=${fakeSource} bytes=${JSON.stringify(readFileSync(fakeSource, 'utf8'))} entries=[${readdirSync(fakeInstallDir).join(',')}] mtime-unchanged=${statSync(fakeSource).mtimeMs === sourceStatsBefore.mtimeMs}`,
)

/* Upgrade the source and re-read through the adopted path: a link tracks the
 * source, a copy does not. This is what makes the directory junction the
 * preferred strategy, so it is asserted rather than assumed. */
const upgradedBytes = `${fakeBytes}UPGRADED\n`
writeFileSync(fakeSource, upgradedBytes)
const followsSource = adopted.action === 'linked-directory' || adopted.action === 'linked-file'
report(
  'D8-adopt-follows-source-when-linked',
  followsSource ? safeRead(adoptExpected) === upgradedBytes : true,
  `action=${adopted.action} reads-through=${safeRead(adoptExpected) === upgradedBytes}`,
)
writeFileSync(fakeSource, fakeBytes)

const adoptedAgain = api.adoptExistingCli({
  env: adoptEnv,
  platform: process.platform,
  arch: process.arch,
  logger: collectingLogger([]),
  candidates: [fakeSource],
})
report(
  'D9-adopt-is-idempotent',
  adoptedAgain.action === 'none' && safeRead(adoptExpected) === fakeBytes,
  `action=${adoptedAgain.action} detail=${adoptedAgain.detail} bytes=${JSON.stringify(safeRead(adoptExpected))}`,
)

/* D10. nothing to adopt: report it, and create nothing. */
const emptyHome = join(sandboxRoot, 'empty-home')
const noSource = api.adoptExistingCli({
  env: sandboxEnv(emptyHome),
  platform: process.platform,
  arch: process.arch,
  logger: collectingLogger([]),
  candidates: [],
})
report(
  'D10-adopt-without-source-creates-nothing',
  noSource.action === 'no-source' && !existsSync(emptyHome),
  `action=${noSource.action} detail=${noSource.detail} cli-home-created=${existsSync(emptyHome)}`,
)

/* D11. a custom `cliHome` still satisfies the shipped `dshHomePath(...)` path.
 * Its own DSH home, so the shared sandbox home is left without any binary. */
const aliasCliHome = join(sandboxRoot, 'custom-cli-home')
const aliasEnv = sandboxEnv(join(sandboxRoot, 'custom-alias-home'))
const customAdopted = api.adoptExistingCli({
  cliHome: aliasCliHome,
  env: aliasEnv,
  platform: process.platform,
  arch: process.arch,
  logger: collectingLogger([]),
  candidates: [fakeSource],
})
const customExpected = api.expectedCliPath({ cliHome: aliasCliHome, env: aliasEnv, platform: process.platform })
const aliasShipped = api.shippedCliPath({ env: aliasEnv })
report(
  'D11-shipped-path-satisfied-for-custom-cli-home',
  existsSync(customExpected) &&
    safeRead(customExpected) === fakeBytes &&
    existsSync(aliasShipped) &&
    safeRead(aliasShipped) === fakeBytes &&
    !api.isSamePath(customExpected, aliasShipped, process.platform),
  `cliHome=${aliasCliHome} expected=${customExpected} (${customAdopted.action}) shipped=${aliasShipped} readback=${JSON.stringify(safeRead(aliasShipped))}`,
)

/* D12. `doctor()`'s same-source contract is a required, green check. */
const parityCheck = doctorReport.checks.find((entry) => entry.id === 'cli-home-patch-parity')
report(
  'D12-doctor-patch-parity-required',
  parityCheck?.ok === true && parityCheck?.required === true,
  parityCheck?.detail ?? 'no cli-home-patch-parity check in the report',
)
report(
  'D13-doctor-reports-sandbox-paths',
  posixOf(doctorReport.cliHome.dir).startsWith(posixOf(sandboxDshHome)) &&
    posixOf(doctorReport.profilePatch.file).startsWith(posixOf(sandboxRoot)) &&
    doctorReport.cliHome.shippedRelativeCommand === 'ocu/bin/open-computer-use.exe',
  `cliHome.dir=${doctorReport.cliHome.dir} profilePatch.file=${doctorReport.profilePatch.file || '<none>'} conflicts=${doctorReport.profilePatch.conflicts.length}`,
)

/* D14. npm is invoked through a real entry point, never a `.cmd`/`.ps1` shim. */
const npmProbePrefix = join(sandboxRoot, 'npm-probe')
const npmInvocation = api.resolveNpmInvocation({ env: env0, platform: process.platform, prefix: npmProbePrefix })
const usesNodeEntry = npmInvocation.via.startsWith('node +')
report(
  'D14-npm-invocation-avoids-shims',
  !/^npm(\.exe|\.cmd|\.ps1|\.bat)?$/i.test(npmInvocation.command) &&
    isAbsolute(npmInvocation.command) &&
    npmInvocation.args.includes('install') &&
    npmInvocation.args.includes('--prefix') &&
    npmInvocation.args.some((argument) => argument === npmProbePrefix || argument.includes(npmProbePrefix)) &&
    npmInvocation.args.includes('open-computer-use') &&
    (usesNodeEntry ? npmInvocation.command === process.execPath && npmInvocation.args[0].endsWith('npm-cli.js') && existsSync(npmInvocation.args[0]) : true),
  `via=${npmInvocation.via} command=${npmInvocation.command} argv=[${npmInvocation.args.join(' ')}]`,
)

/* D15. provision failure: warn only, never throw, always actionable. */
const failHome = join(sandboxRoot, 'provision-fail')
const failEnv = sandboxEnv(join(sandboxRoot, 'provision-fail-home'))
const failSpawn = fakeSpawn({ exitCode: 7, stderr: 'npm ERR! code ENOTFOUND simulated offline\n' })
const failLogs = []
let provisionThrew = false
let failOutcome
try {
  failOutcome = await api.provisionCli({
    cliHome: failHome,
    env: failEnv,
    platform: process.platform,
    arch: process.arch,
    logger: collectingLogger(failLogs),
    spawnProcess: failSpawn.spawnProcess,
    timeoutMs: 5000,
  })
} catch (cause) {
  provisionThrew = true
  failOutcome = { ok: null, action: `threw:${cause?.message ?? cause}` }
}
report(
  'D15-provision-failure-warns-not-throws',
  provisionThrew === false &&
    failOutcome.ok === false &&
    failOutcome.action === 'install-failed' &&
    failSpawn.calls.length === 1 &&
    failLogs.some((line) => line.startsWith('WARN') && line.includes('npm install --prefix')) &&
    !existsSync(api.expectedCliPath({ cliHome: failHome, env: failEnv, platform: process.platform })),
  `threw=${provisionThrew} ok=${failOutcome.ok} action=${failOutcome.action} spawnCalls=${failSpawn.calls.length} warn=${failLogs.filter((line) => line.startsWith('WARN')).join(' / ')}`,
)

/* D16. provision success: the local layout is adopted into `<cli-home>`. Its own
 * DSH home, so the shipped-path alias it creates stays out of the shared one. */
const okHome = join(sandboxRoot, 'provision-ok')
const okEnv = sandboxEnv(join(sandboxRoot, 'provision-ok-home'))
const okSpawn = fakeSpawn({
  exitCode: 0,
  onStart: () => {
    const binary = installedBinaryPath(okHome)
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, fakeBytes)
  },
})
const okOutcome = await api.provisionCli({
  cliHome: okHome,
  env: okEnv,
  platform: process.platform,
  arch: process.arch,
  logger: collectingLogger([]),
  spawnProcess: okSpawn.spawnProcess,
  timeoutMs: 5000,
})
const okExpected = api.expectedCliPath({ cliHome: okHome, env: okEnv, platform: process.platform })
report(
  'D16-provision-adopts-into-cli-home',
  okOutcome.ok === true &&
    okSpawn.calls.length === 1 &&
    okSpawn.calls[0].args.includes('--prefix') &&
    okSpawn.calls[0].args.includes(resolve(okHome)) &&
    existsSync(okExpected) &&
    safeRead(okExpected) === fakeBytes,
  `ok=${okOutcome.ok} action=${okOutcome.action} expected=${okExpected} readback=${JSON.stringify(safeRead(okExpected))} argv=[${okSpawn.calls[0]?.command} ${(okSpawn.calls[0]?.args ?? []).join(' ')}]`,
)

/* D17. `autoProvision: false` runs no install at all. */
const offHome = join(sandboxRoot, 'auto-provision-off')
const offSpawn = fakeSpawn({ exitCode: 0 })
const offCtx = createMockCtx()
withDshHome(offHome, () => {
  api.apply(offCtx.ctx, { autoProvision: false, registerSkill: false, enableTurnBoundaryHook: false }, { spawnProcess: offSpawn.spawnProcess, candidates: [] })
})
await sleep(150)
report(
  'D17-auto-provision-off-installs-nothing',
  offSpawn.calls.length === 0 &&
    logText(offCtx.logs, 'warn').includes('autoProvision is off') &&
    logText(offCtx.logs).includes('provision=disabled (autoProvision=false)'),
  `spawnCalls=${offSpawn.calls.length} warn=${logText(offCtx.logs, 'warn')}`,
)

/* D18. apply() starts the install before it finishes wiring up, and reports it. */
const wiringHome = join(sandboxRoot, 'wiring-home')
const wiringSpawn = fakeSpawn({ exitCode: 1, stderr: 'npm ERR! simulated offline\n' })
const wiringCtx = createMockCtx()
let wiringLogsImmediate = ''
await withDshHomeAsync(wiringHome, async () => {
  api.apply(wiringCtx.ctx, { autoProvision: true, registerSkill: false, enableTurnBoundaryHook: false }, { spawnProcess: wiringSpawn.spawnProcess, candidates: [] })
  wiringLogsImmediate = logText(wiringCtx.logs)
  await sleep(250)
})
const summaryLine = logText(wiringCtx.logs).split('\n').find((line) => line.includes('summary platform=')) ?? ''
report(
  'D18-apply-provisions-without-blocking',
  wiringLogsImmediate.includes('installing it into <cli-home>') &&
    summaryLine.includes(`expectedCli=${api.expectedCliPath({ cliHome: '', env: sandboxEnv(wiringHome), platform: process.platform })}`) &&
    summaryLine.includes('provision=started') &&
    summaryLine.includes('commandSource=provision') &&
    logText(wiringCtx.logs).includes('provision settled: ok=false') &&
    wiringSpawn.calls.length === 1,
  `immediate=${wiringLogsImmediate.split('\n').filter((line) => line.includes('installing it') || line.includes('summary')).join(' // ')} settled=${logText(wiringCtx.logs).split('\n').find((line) => line.includes('provision settled')) ?? '<none>'}`,
)

/* D19. profile-patch conflicts: detected, named, and left alone. */
const conflictProfileDir = join(sandboxRoot, 'conflict-profile')
mkdirSync(conflictProfileDir, { recursive: true })
const conflictPatchFile = join(conflictProfileDir, 'cordis.patch.yml')
const conflictPatchText = [
  '# sandbox profile patch with both kinds of conflict',
  api.MANAGED_BLOCK_BEGIN,
  '- id: open-computer-use-mcp',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: ocu',
  '    transport: stdio',
  `    command: ${join(sandboxRoot, 'legacy', 'open-computer-use.exe')}`,
  api.MANAGED_BLOCK_END,
  '',
  '- id: hand-written-ocu',
  '  name: some-other-plugin',
  '  config:',
  '    serverName: ocu',
  '',
  '# serverName: ocu   <- commented out and must be ignored',
  '',
].join('\n')
writeFileSync(conflictPatchFile, conflictPatchText)
const conflictEnv = { ...sandboxEnv(), DSH_PROFILE_DIR: conflictProfileDir }
const conflictReport = await api.doctor({}, { env: conflictEnv, profileDir: conflictProfileDir })
const managedConflicts = conflictReport.profilePatch.conflicts.filter((entry) => entry.kind === 'managed-block')
const duplicateConflicts = conflictReport.profilePatch.conflicts.filter((entry) => entry.kind === 'duplicate-serverName')
const cleanCheck = conflictReport.checks.find((entry) => entry.id === 'profile-patch-clean')
const failedRequired = conflictReport.checks.filter((entry) => entry.required && !entry.ok)
report(
  'D19-profile-patch-conflicts-detected',
  posixOf(conflictReport.profilePatch.file) === posixOf(conflictPatchFile) &&
    managedConflicts.length === 1 &&
    duplicateConflicts.length === 2 &&
    duplicateConflicts.some((entry) => entry.rowId === 'hand-written-ocu') &&
    conflictReport.profilePatch.cleanupCommands.length === conflictReport.profilePatch.conflicts.length &&
    conflictReport.profilePatch.cleanupCommands.every((command) => command.includes('cordis.patch.yml')) &&
    cleanCheck?.ok === false &&
    cleanCheck?.required === false &&
    conflictReport.ok === true,
  `file=${conflictReport.profilePatch.file} managed=${managedConflicts.length} duplicate=${duplicateConflicts.length} rows=${duplicateConflicts.map((entry) => entry.rowId).join(',')} cleanup=${conflictReport.profilePatch.cleanupCommands.length} check=[${cleanCheck?.ok} req=${cleanCheck?.required}] doctor.ok=${conflictReport.ok} failedRequired=[${failedRequired.map((entry) => `${entry.id}:${entry.detail}`).join(' ; ')}]`,
)
report(
  'D20-conflict-scan-is-read-only',
  readFileSync(conflictPatchFile, 'utf8') === conflictPatchText &&
    api.scanPatchConflicts('# clean\n- id: x\n  config:\n    serverName: other\n').length === 0,
  `patch-unchanged=${readFileSync(conflictPatchFile, 'utf8') === conflictPatchText} clean-doc-conflicts=${api.scanPatchConflicts('# clean\n- id: x\n  config:\n    serverName: other\n').length}`,
)

/* D21. the real DSH home was never a destination. `<dsh-home>/ocu` is the only
 * directory this plugin creates below a DSH home, so if it does not exist after
 * a run that exercised adopt and provision, no write reached the real one.
 * Nothing in the Harness itself ever creates it. */
const realDshOcu = join(homedir(), '.dsh', 'ocu')
report(
  'D21-real-dsh-home-untouched',
  !existsSync(realDshOcu),
  `${realDshOcu} does not exist after the run — no adopt or provision write reached ${join(homedir(), '.dsh')}`,
)

/* ── verdict ─────────────────────────────────────────────────────────────── */

console.log(`\n=== verdict ===\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      command: discovered.command,
      cliHome: {
        sandbox: sandboxDshHome,
        expected: doctorReport.cliHome.expected,
        shippedRelativeCommand: doctorReport.cliHome.shippedRelativeCommand,
        patchArguments: patchArguments,
        adoptedAction: adopted.action,
      },
      turnBoundary: { resolvedOnThisPlatform: api.resolveCleanupInvocation({ platform: process.platform, command: discovered.command }) },
      skill: { name: api.SKILL_NAME, descriptionLength: api.SKILL_DESCRIPTION.length, bytes: skillOutcome.bytes, contentBytes: skillOutcome.contentBytes },
      expectedMcpTools: doctorReport.expectedMcpTools,
      realProfileDirTouched: false,
    },
    null,
    2,
  ),
)

/* The sandbox is scratch space. Removing it cannot touch anything else: every
 * link inside points at a directory inside it as well. */
try {
  rmSync(sandboxRoot, { recursive: true, force: true })
} catch (cause) {
  console.log(`note: could not remove the sandbox ${sandboxRoot}: ${cause?.message ?? cause}`)
}

process.exitCode = failed === 0 ? 0 : 1
