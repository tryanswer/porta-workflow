import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  activatePortaWorkflowSkill,
  resolvePortaWorkflowSkillDestination,
} from '../scripts/porta-workflow-skill-activation.mjs'

const activationScriptPath = fileURLToPath(new URL('../scripts/porta-workflow-skill-activation.mjs', import.meta.url))
const repositoryUrl = 'https://github.com/tryanswer/porta-workflow.git'
const tag = 'porta-workflow-v2.4.1'

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function createSourceRepository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'porta-workflow-activation-source-')))
  const repository = join(root, 'repository')
  await mkdir(join(repository, 'porta-workflow', 'scripts'), { recursive: true })
  execFileSync('git', ['init', '-q', repository])
  git(repository, 'config', 'user.email', 'porta-workflow-test@example.invalid')
  git(repository, 'config', 'user.name', 'Porta Workflow Test')
  git(repository, 'remote', 'add', 'origin', repositoryUrl)
  await writeFile(join(repository, 'porta-workflow', 'SKILL.md'), '---\nname: porta-workflow\ndescription: fixture\n---\n\n# Fixture\n')
  await writeFile(join(repository, 'porta-workflow', 'version.txt'), '2.4.1\n')
  await writeFile(join(repository, 'porta-workflow', 'scripts', 'tool.mjs'), '#!/usr/bin/env node\n')
  await chmod(join(repository, 'porta-workflow', 'scripts', 'tool.mjs'), 0o755)
  git(repository, 'add', 'porta-workflow')
  git(repository, 'commit', '-qm', 'fixture release')
  git(repository, 'tag', '-a', tag, '-m', 'fixture release')
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    commit: git(repository, 'rev-parse', 'HEAD'),
    repository,
  }
}

async function createProviderFixture(provider = 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'porta-workflow-activation-provider-')))
  const providerHome = join(root, 'provider-home')
  const destination = resolvePortaWorkflowSkillDestination({ provider, providerHome })
  await mkdir(dirname(destination), { recursive: true })
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    destination,
    provider,
    providerHome,
    root,
  }
}

async function writePreviousRelease(destination) {
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'SKILL.md'), 'previous release\n')
  await writeFile(join(destination, 'version.txt'), '0.1.1\n')
}

async function readInstalledVersion(destination) {
  return (await readFile(join(destination, 'version.txt'), 'utf8')).trim()
}

function activationInput(source, provider, overrides = {}) {
  return {
    expectedCommit: source.commit,
    expectedRepositoryUrl: repositoryUrl,
    expectedTag: tag,
    provider: provider.provider,
    providerHome: provider.providerHome,
    sourceRepository: source.repository,
    ...overrides,
  }
}

test('resolves only the exact user-level provider skill destination', async () => {
  const providerHome = '/tmp/porta-workflow-provider-home'
  for (const provider of ['codex', 'claude', 'gemini']) {
    assert.equal(
      resolvePortaWorkflowSkillDestination({ provider, providerHome }),
      join(providerHome, 'skills', 'porta-workflow'),
    )
  }
  assert.throws(
    () => resolvePortaWorkflowSkillDestination({ provider: 'unknown', providerHome }),
    /provider/i,
  )
  assert.throws(
    () => resolvePortaWorkflowSkillDestination({ provider: 'codex', providerHome: 'relative' }),
    /absolute/i,
  )
})

test('installs the complete immutable tagged subdirectory and preserves executable mode', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    const receipt = await activatePortaWorkflowSkill(activationInput(source, provider))
    assert.equal(receipt.action, 'installed')
    assert.equal(receipt.commitSha, source.commit)
    assert.equal(receipt.provider, 'codex')
    assert.equal(receipt.tag, tag)
    assert.match(receipt.treeDigest, /^[0-9a-f]{64}$/)
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
    assert.equal((await readFile(join(provider.destination, 'SKILL.md'), 'utf8')).includes('# Fixture'), true)
    const executable = await import('node:fs/promises').then(({ stat }) => stat(join(provider.destination, 'scripts', 'tool.mjs')))
    assert.equal(executable.mode & 0o111, 0o111)
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('CLI resolves the current Codex user root and returns the bounded activation receipt', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    const result = spawnSync(process.execPath, [
      activationScriptPath,
      'activate',
      '--provider', 'codex',
      '--source-repository', source.repository,
      '--expected-repository-url', repositoryUrl,
      '--expected-tag', tag,
      '--expected-commit', source.commit,
    ], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: provider.providerHome },
    })
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.action, 'installed')
    assert.equal(receipt.installedPath, provider.destination)
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('rejects a mismatched tag, commit, origin, or symbolic-link Git entry before mutation', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('claude')
  try {
    await writePreviousRelease(provider.destination)
    for (const override of [
      { expectedCommit: 'a'.repeat(40) },
      { expectedTag: 'porta-workflow-v9.9.9' },
      { expectedRepositoryUrl: 'https://github.com/tryanswer/other.git' },
    ]) {
      await assert.rejects(activatePortaWorkflowSkill(activationInput(source, provider, override)))
      assert.equal(await readInstalledVersion(provider.destination), '0.1.1')
    }

    await symlink('../version.txt', join(source.repository, 'porta-workflow', 'linked-version'))
    git(source.repository, 'add', 'porta-workflow/linked-version')
    git(source.repository, 'commit', '-qm', 'unsafe symlink')
    git(source.repository, 'tag', '-f', '-a', tag, '-m', 'unsafe symlink')
    const unsafeCommit = git(source.repository, 'rev-parse', 'HEAD')
    await assert.rejects(
      activatePortaWorkflowSkill(activationInput(source, provider, { expectedCommit: unsafeCommit })),
      /symbolic|mode|entry/i,
    )
    assert.equal(await readInstalledVersion(provider.destination), '0.1.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('rejects a dirty or non-release checkout even when the tagged Git objects are present', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    await writePreviousRelease(provider.destination)
    await writeFile(join(source.repository, 'porta-workflow', 'version.txt'), 'dirty\n')
    await assert.rejects(
      activatePortaWorkflowSkill(activationInput(source, provider)),
      /clean exact release checkout/i,
    )
    assert.equal(await readInstalledVersion(provider.destination), '0.1.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('updates an existing release and reports the exact previous and active tree digests', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('gemini')
  try {
    await writePreviousRelease(provider.destination)
    const receipt = await activatePortaWorkflowSkill(activationInput(source, provider))
    assert.equal(receipt.action, 'updated')
    assert.match(receipt.previousTreeDigest, /^[0-9a-f]{64}$/)
    assert.notEqual(receipt.previousTreeDigest, receipt.treeDigest)
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('an exact installed release is a read-only idempotent replay', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    const installed = await activatePortaWorkflowSkill(activationInput(source, provider))
    const replayed = await activatePortaWorkflowSkill(activationInput(source, provider))
    assert.equal(installed.action, 'installed')
    assert.equal(replayed.action, 'unchanged')
    assert.equal(replayed.treeDigest, installed.treeDigest)
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('a failure before settlement restores the exact previous release across every activation phase', async () => {
  const source = await createSourceRepository()
  for (const phase of ['after-staged', 'after-previous-retired', 'after-activated']) {
    const provider = await createProviderFixture('codex')
    try {
      await writePreviousRelease(provider.destination)
      await assert.rejects(
        activatePortaWorkflowSkill(activationInput(source, provider, {
          hooks: {
            async onPhase(current) {
              if (current === phase) throw new Error(`injected ${phase}`)
            },
          },
        })),
        new RegExp(`injected ${phase}`),
      )
      assert.equal(await readInstalledVersion(provider.destination), '0.1.1')
    } finally {
      await provider.cleanup()
    }
  }
  await source.cleanup()
})

test('a failed fresh activation restores the previously absent installation', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    await assert.rejects(
      activatePortaWorkflowSkill(activationInput(source, provider, {
        hooks: {
          async onPhase(phase) {
            if (phase === 'after-activated') throw new Error('injected fresh activation failure')
          },
        },
      })),
      /injected fresh activation failure/,
    )
    await assert.rejects(readFile(join(provider.destination, 'SKILL.md')), /ENOENT/)
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('an unknown replacement during activation is preserved and blocks destructive recovery', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    await writePreviousRelease(provider.destination)
    await assert.rejects(
      activatePortaWorkflowSkill(activationInput(source, provider, {
        hooks: {
          async onPhase(phase) {
            if (phase !== 'after-previous-retired') return
            await mkdir(provider.destination)
            await writeFile(join(provider.destination, 'SKILL.md'), 'replacement\n')
            await writeFile(join(provider.destination, 'version.txt'), 'unknown\n')
            throw new Error('injected replacement')
          },
        },
      })),
      /exact recovery|required|cannot be recovered/i,
    )
    assert.equal(await readInstalledVersion(provider.destination), 'unknown')
    const siblingNames = await import('node:fs/promises').then(({ readdir }) => readdir(dirname(provider.destination)))
    assert.equal(siblingNames.some((name) => name.startsWith('.porta-workflow.backup-')), true)
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('a process killed after retiring the previous release is recovered before the next update', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    await writePreviousRelease(provider.destination)
    const childCode = `
      import { activatePortaWorkflowSkill } from ${JSON.stringify(pathToFileURL(activationScriptPath).href)}
      await activatePortaWorkflowSkill({
        ...${JSON.stringify(activationInput(source, provider))},
        hooks: { async onPhase(phase) { if (phase === 'after-previous-retired') process.kill(process.pid, 'SIGKILL') } },
      })
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    assert.equal(exit.signal, 'SIGKILL')

    const receipt = await activatePortaWorkflowSkill(activationInput(source, provider))
    assert.equal(receipt.action, 'updated')
    assert.equal(receipt.recoveredPreviousRelease, true)
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('a process killed after activating but before settlement restores the prior release before retry', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  try {
    await writePreviousRelease(provider.destination)
    const childCode = `
      import { activatePortaWorkflowSkill } from ${JSON.stringify(pathToFileURL(activationScriptPath).href)}
      await activatePortaWorkflowSkill({
        ...${JSON.stringify(activationInput(source, provider))},
        hooks: { async onPhase(phase) { if (phase === 'after-activated') process.kill(process.pid, 'SIGKILL') } },
      })
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    assert.equal(exit.signal, 'SIGKILL')

    const receipt = await activatePortaWorkflowSkill(activationInput(source, provider))
    assert.equal(receipt.action, 'updated')
    assert.equal(receipt.recoveredPreviousRelease, true)
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
  } finally {
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})

test('a concurrent activation fails closed while the exact first transaction owns the destination', async () => {
  const source = await createSourceRepository()
  const provider = await createProviderFixture('codex')
  let releaseStaged
  const staged = new Promise((resolve) => { releaseStaged = resolve })
  let continueFirst
  const blocked = new Promise((resolve) => { continueFirst = resolve })
  try {
    await writePreviousRelease(provider.destination)
    const first = activatePortaWorkflowSkill(activationInput(source, provider, {
      hooks: {
        async onPhase(phase) {
          if (phase === 'after-staged') {
            releaseStaged()
            await blocked
          }
        },
      },
    }))
    await staged
    await assert.rejects(
      activatePortaWorkflowSkill(activationInput(source, provider)),
      /activation|lock|transaction/i,
    )
    continueFirst()
    await first
    assert.equal(await readInstalledVersion(provider.destination), '2.4.1')
  } finally {
    continueFirst?.()
    await Promise.all([source.cleanup(), provider.cleanup()])
  }
})
