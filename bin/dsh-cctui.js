#!/usr/bin/env node
// Launcher: boots the dsh profile that carries the dsh-cctui bundle.
// Pure JS on purpose — it runs before any build output exists and must give
// actionable errors when the environment is missing pieces.
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE = process.env.DSH_CCTUI_PROFILE || 'dsh-cctui'
const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-V')) {
  console.log(pkg.version)
  process.exit(0)
}

const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' })

if (probe.error || probe.status !== 0) {
  console.error('dsh-cctui: the `dsh` CLI is not on PATH.')
  console.error('Install deepseek-harness first, e.g.:  npm install -g @deepseek-ai/dsh')
  process.exit(1)
}

const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh')
const profileDir = join(home, 'profiles', PROFILE)

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`dsh-cctui: profile "${PROFILE}" is not set up yet.`)
  console.error('From a checkout of this repository, run:  ./install.sh')
  console.error(`(or manually:  dsh plugin --profile ${PROFILE} add <path-to-checkout>)`)
  process.exit(1)
}

const env = { ...process.env }

env.NODE_ENV ??= 'production'

const child = spawn('dsh', ['--profile', PROFILE, ...args], { env, stdio: 'inherit' })

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)

    return
  }

  process.exit(code ?? 0)
})
