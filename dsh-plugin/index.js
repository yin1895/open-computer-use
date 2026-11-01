/**
 * Host half of the `@yin1895/dsh-open-computer-use` bundle.
 *
 * SCOPE: scaffold only. This module imports cleanly and `apply()` resolves the
 * row configuration and wires nothing yet — it is the loading, activating
 * skeleton that the implementation change fills in. Every anchor is marked
 * TODO(impl) below.
 *
 * Integration shape (decided, not speculative):
 *   - The tools themselves come from the SECOND row this bundle inserts,
 *     `@deepseek-ai/dsh-mcp-client` with `serverName: ocu`, which spawns the
 *     Open Computer Use native stdio MCP server and exposes its nine tools to
 *     the model as `mcp__ocu__<tool>`.
 *   - THIS row owns what the MCP client cannot do: turn-boundary cursor cleanup
 *     and skill registration.
 *
 * `inject` deliberately lists only services this deployment actually provides.
 * `computerUse` is NOT injected: it is optional, and no package in this dsh
 * installation provides that provider slot, so a hard dependency on it would
 * leave the plugin unloaded. Reach it optionally where needed, e.g.
 * `const computerUse = ctx.get('computerUse')` behind a falsy check.
 */

/** Defaults mirror `dsh-plugin/cordis.patch.yml`. */
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

/**
 * Services this plugin consumes. Activation waits for these and no others:
 * every name added here means the plugin does not load without it.
 *
 * NOTE: `computerUse` is intentionally absent — see the header comment.
 */
export const inject = ['skills', 'subprocess']

/**
 * Row configuration schema. The Loader validates a row's `config` against this
 * before `apply` runs, so a `config` that fails here means the plugin never
 * activates. Re-read the live document with
 * `cordis_inspect_query({ platform: 'host', provider: 'Config', method:
 * 'listConfigs' })` before changing it.
 */
export const Config = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      default: '',
      description:
        'Absolute path to the Open Computer Use native binary. A bare name resolved through PATH is not enough for a GUI or background launch.',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      default: ['mcp'],
      description: 'Arguments passed to `command`.',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      default: {},
      description: 'Extra environment variables for the child process.',
    },
    cwd: {
      type: 'string',
      default: '',
      description:
        'Working directory for the child process; empty means the Harness default.',
    },
    serverName: {
      type: 'string',
      default: 'ocu',
      description:
        'MCP server name, and therefore the `mcp__<serverName>__<tool>` prefix the model sees; must match the `@deepseek-ai/dsh-mcp-client` row.',
    },
    toolCallTimeoutMs: {
      type: 'number',
      default: 60000,
      description: 'Per-tool-call timeout in milliseconds.',
    },
    enableTurnBoundaryHook: {
      type: 'boolean',
      default: true,
      description:
        'Hide the Open Computer Use software cursor at each turn boundary.',
    },
    registerSkill: {
      type: 'boolean',
      default: true,
      description: 'Register the bundled Open Computer Use skill.',
    },
    cursorCleanupCommand: {
      type: 'string',
      default: '',
      description:
        'Optional override for the cursor cleanup invocation; empty selects the built-in default.',
    },
  },
}

/** Merge a row's `config` over `DEFAULT_CONFIG`. */
export function resolveConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) }
}

/**
 * Host half entry point.
 *
 * Scaffold behaviour: resolve configuration, register nothing, dispose nothing.
 * Every registration added later MUST happen inside `ctx.effect(...)` or
 * `ctx.on(...)` so it is torn down with the plugin.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)

  // TODO(impl) 1 — turn boundary.
  // Open Computer Use only hides its software cursor when it is told the turn
  // ended, and `@deepseek-ai/dsh-mcp-client` never sends that notification. Map
  // the authoritative serial turn event onto the cleanup command:
  //   ctx.on('agent/turn-stopping', async () => { /* options.cursorCleanupCommand */ })
  // Gated on `options.enableTurnBoundaryHook`.

  // TODO(impl) 2 — skill.
  // Register the Open Computer Use skill shipped in `skills/open-computer-use`,
  // or copy it into the profile skill directory:
  //   ctx.skills.register({ /* ... */ })
  // Gated on `options.registerSkill`.

  // TODO(impl) 3 — process lifecycle, only if the MCP row is not enough.
  // Prefer the shipped `@deepseek-ai/dsh-mcp-client` row (`serverName:
  // options.serverName`) and spawn here only when this plugin must own the
  // child process:
  //   ctx.subprocess.spawn({ /* ... options.command, options.args ... */ })

  if (!options.command) {
    ctx.logger?.warn?.(
      '[dsh-open-computer-use] `command` is empty; set it to the absolute path of the Open Computer Use native binary.',
    )
  }
}
