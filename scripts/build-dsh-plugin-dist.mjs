#!/usr/bin/env node
/**
 * Materialize the standalone DSH bundle for link-based installation.
 *
 * WHY THIS EXISTS
 * ---------------
 * A DSH bundle must declare `dsh.bundle.patch` in the `package.json` that a
 * spec resolves to. In this repository the bundle lives in `dsh-plugin/`, while
 * the repository root `package.json` is Open Computer Use itself — so a spec
 * aimed at this repository (`github:…`, or a codeload tarball of `main`)
 * resolves to a non-bundle and DSH rejects it with `not-a-bundle`.
 *
 * This script produces a tree whose ROOT is the bundle, which is what a
 * tarball or repository install needs. The tree is published on a generated
 * branch (`dsh-plugin-dist`) so nobody has to build it to install:
 *
 *   https://codeload.github.com/yin1895/open-computer-use/tar.gz/refs/heads/dsh-plugin-dist
 *
 * It also copies the skill into the bundle, because an installed bundle is
 * unpacked on its own and cannot reach the repository's top-level `skills/`.
 * `index.js` looks in both places (`skillDirectoryCandidates`).
 *
 * USAGE
 *   node scripts/build-dsh-plugin-dist.mjs --out <dir> [--force] [--dry-run]
 *
 * The output is a generated artifact: never edit it by hand. Regenerate and
 * re-publish the branch instead.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Generated branch that carries the standalone tree. */
export const DIST_BRANCH = 'dsh-plugin-dist'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = join(REPO_ROOT, 'dsh-plugin')
const SKILL_NAME = 'open-computer-use'
const SKILL_SOURCE = join(REPO_ROOT, 'skills', SKILL_NAME)

/**
 * Entries that are never copied.
 *
 * The complement of this set is what ships, on purpose: a whitelist silently
 * drops a newly added module from the published tree, and that failure is only
 * visible to whoever installs it. One extra file is the cheaper mistake.
 */
const EXCLUDED = new Set(['node_modules', '.git', '.gitignore', '.DS_Store'])

/** Top-level bundle entries to copy, in a stable order. */
function bundleEntries() {
  return readdirSync(BUNDLE_DIR, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !EXCLUDED.has(name))
    .sort()
}

function parseArgs(argv) {
  const options = { out: '', force: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      options.out = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`)
    } else if (!options.out) {
      options.out = arg
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }
  if (!options.out) throw new Error('missing --out <dir>')
  return options
}

/** Every regular file below `directory`, as paths relative to it. */
function walk(directory, base = directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(absolute, base))
    else if (entry.isFile()) found.push(relative(base, absolute).split('\\').join('/'))
  }
  return found.sort()
}

function fail(message) {
  process.stderr.write(`build-dsh-plugin-dist: ${message}\n`)
  process.exit(1)
}

/**
 * Refuse to publish a tree DSH would reject. Each check mirrors something the
 * Loader or the plugin manager actually needs, so a passing tree is installable
 * rather than merely present.
 */
function verifyTree(out) {
  const problems = []
  const manifestPath = join(out, 'package.json')

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    return [`package.json is not readable JSON: ${cause.message}`]
  }

  if (!manifest.name) problems.push('package.json has no name')
  if (!manifest.version) problems.push('package.json has no version')

  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) {
    problems.push('package.json declares no dsh.bundle.patch, so DSH reads this as not-a-bundle')
  } else if (!existsSync(join(out, patch))) {
    problems.push(`dsh.bundle.patch points at a missing file: ${patch}`)
  }

  for (const required of ['index.js', 'icon.svg', join('locale', 'en.json'), join('locale', 'zh.json')]) {
    if (!existsSync(join(out, required))) problems.push(`missing ${required}`)
  }

  const skillFile = join(out, 'skills', SKILL_NAME, 'SKILL.md')
  if (!existsSync(skillFile)) {
    problems.push(`missing skills/${SKILL_NAME}/SKILL.md, so the skill would not register after install`)
  }

  const index = readFileSync(join(out, 'index.js'), 'utf8')
  if (!index.includes('export')) problems.push('index.js exports nothing')

  return problems
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (cause) {
    fail(cause.message)
  }

  const out = resolve(options.out)

  if (!existsSync(BUNDLE_DIR)) fail(`bundle directory not found: ${BUNDLE_DIR}`)
  if (!existsSync(SKILL_SOURCE)) fail(`skill source not found: ${SKILL_SOURCE}`)
  if (out === REPO_ROOT || out === BUNDLE_DIR) fail(`refusing to write into the source tree: ${out}`)

  const alreadyThere = existsSync(out) && readdirSync(out).length > 0
  if (alreadyThere && !options.force) {
    fail(`${out} is not empty; pass --force to replace it`)
  }

  const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, 'package.json'), 'utf8'))

  if (options.dryRun) {
    process.stdout.write(`would build ${manifest.name}@${manifest.version} into ${out}\n`)
    for (const name of bundleEntries()) process.stdout.write(`  ${name}\n`)
    process.stdout.write(`  skills/${SKILL_NAME}/\n`)
    return
  }

  if (alreadyThere) rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  // The bundle directory is self-contained: everything it holds ships, minus
  // EXCLUDED. A whitelist here would silently drop a newly added module from the
  // published tree, and only whoever installs it would ever notice.
  for (const name of bundleEntries()) {
    cpSync(join(BUNDLE_DIR, name), join(out, name), { recursive: true })
  }

  // The installed bundle is unpacked on its own, so it must carry the skill.
  cpSync(SKILL_SOURCE, join(out, 'skills', SKILL_NAME), { recursive: true })

  const problems = verifyTree(out)
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`build-dsh-plugin-dist: ${problem}\n`)
    process.exit(1)
  }

  const files = walk(out)
  const bytes = files.reduce((total, file) => total + statSync(join(out, file)).size, 0)

  process.stdout.write(`${manifest.name}@${manifest.version} -> ${out}\n`)
  process.stdout.write(`${files.length} files, ${bytes} bytes\n`)
  for (const file of files) process.stdout.write(`  ${file}\n`)
  process.stdout.write('\nverified: dsh.bundle.patch resolves, entry and display resources present, skill bundled\n')
  process.stdout.write(`\ninstall from a link once branch ${DIST_BRANCH} is published:\n`)
  process.stdout.write(`  https://codeload.github.com/yin1895/open-computer-use/tar.gz/refs/heads/${DIST_BRANCH}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
