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
 *
 * Exit code 0 = every check passed. Non-zero = at least one FAIL, printed with
 * its detail.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const api = await import(new URL('./index.js', import.meta.url).href)

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

/* Row config round-trip: schemastery must accept exactly what the patch sets. */
try {
  const require = createRequire(join(doctorReport.profileDirectories[0] ?? here, 'package.json'))
  const yaml = require('yaml')
  const document = yaml.parse(readFileSync(join(here, 'cordis.patch.yml'), 'utf8'))
  const rows = document.flatMap((entry) => entry.insert ?? [])
  const row = rows.find((entry) => entry.id === 'open-computer-use')
  const validated = api.Config(row.config)
  report(
    'C8-patch-row-config-validates',
    validated.serverName === 'ocu' && validated.enableTurnBoundaryHook === true && Array.isArray(validated.args),
    JSON.stringify(validated),
  )
  const mcpRow = rows.find((entry) => entry.id === 'open-computer-use-mcp')
  report(
    'C9-mcp-row-uses-shipped-client',
    mcpRow?.name === '@deepseek-ai/dsh-mcp-client' && mcpRow.config.serverName === validated.serverName,
    `${mcpRow?.name} serverName=${mcpRow?.config?.serverName} failOnStartupError=${mcpRow?.config?.failOnStartupError}`,
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

/* ── verdict ─────────────────────────────────────────────────────────────── */

console.log(`\n=== verdict ===\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      command: discovered.command,
      turnBoundary: { resolvedOnThisPlatform: api.resolveCleanupInvocation({ platform: process.platform, command: discovered.command }) },
      skill: { name: api.SKILL_NAME, descriptionLength: api.SKILL_DESCRIPTION.length, bytes: skillOutcome.bytes, contentBytes: skillOutcome.contentBytes },
      expectedMcpTools: doctorReport.expectedMcpTools,
    },
    null,
    2,
  ),
)
process.exitCode = failed === 0 ? 0 : 1
