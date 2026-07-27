import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../scripts/porta-workflow.mjs', import.meta.url))
const referencePath = fileURLToPath(new URL('../references/bridge-workflow-v1.md', import.meta.url))
const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const realBridgeSource = process.env.PORTA_WORKFLOW_TEST_BRIDGE_SOURCE

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'porta-workflow-skill-'))
  const project = join(root, 'project')
  const bridge = join(root, 'porta-bridge')
  const log = join(root, 'bridge-calls.jsonl')
  await mkdir(project)
  await writeFile(bridge, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_BRIDGE_LOG, JSON.stringify(args) + '\\n')
const option = (name) => args[args.indexOf(name) + 1]
const command = args[1]
const requestId = '11111111-1111-4111-8111-111111111111'
const traceId = '22222222-2222-4222-8222-222222222222'
const workRunId = 'workrun_33333333-3333-4333-8333-333333333333'
if (command === 'capabilities') {
  console.log(JSON.stringify({
    artifactKinds: ['web', 'android-apk'],
    commands: ['capabilities', 'attention', 'begin', 'fail', 'preview-ready', 'preview-start', 'progress', 'stop'],
    ok: true,
    platformSupported: true,
    protocolVersion: 1,
    runtimeVersion: process.env.FAKE_RUNTIME_VERSION,
    staleAfterSeconds: 900,
    traceId: option('--trace-id'),
    type: 'workflow-capabilities',
    workflowProtocolVersion: 1
  }))
  process.exit(0)
}
if (command === 'begin') {
  const cwd = option('--cwd')
  console.log(JSON.stringify({
    created: true,
    eventContractVersion: 1,
    logPath: path.join(cwd, '.porta', 'previews', requestId + '.log'),
    manifestPath: path.join(cwd, '.porta', 'previews', requestId + '.json'),
    milestoneCursor: '1',
    ok: true,
    protocolVersion: 1,
    requestId,
    skillId: option('--skill-id'),
    skillVersion: option('--skill-version'),
    sourceSequence: 1,
    status: 'active',
    traceId,
    type: 'workflow-begin',
    workflowProtocolVersion: 1,
    workRunId
  }))
  process.exit(0)
}
const statuses = {
  attention: 'active',
  fail: option('--outcome'),
  'preview-ready': 'ready',
  'preview-start': 'building',
  progress: 'active',
  stop: 'stopped'
}
console.log(JSON.stringify({
  command,
  idempotent: false,
  ...(command === 'progress' ? {} : { milestoneCursor: '2' }),
  ok: true,
  protocolVersion: 1,
  sourceSequence: command === 'progress' ? 1 : 2,
  status: statuses[command],
  traceId,
  type: 'workflow-receipt',
  workflowProtocolVersion: 1,
  workRunId
}))
`)
  await chmod(bridge, 0o755)
  return {
    bridge,
    cleanup: () => rm(root, { force: true, recursive: true }),
    environment: {
      FAKE_BRIDGE_LOG: log,
      FAKE_RUNTIME_VERSION: '1.11.0',
    },
    log,
    project,
  }
}

async function createRealBridgeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'porta-workflow-real-bridge-'))
  const project = join(root, 'project')
  const bridge = join(root, 'porta-bridge')
  const bridgeHome = join(root, 'bridge-home')
  await mkdir(project)
  await writeFile(bridge, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const result = spawnSync(process.execPath, [process.env.PORTA_WORKFLOW_TEST_BRIDGE_SOURCE, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit'
})
if (result.error) {
  process.stderr.write(String(result.error.message) + '\\n')
  process.exit(1)
}
process.exit(result.status ?? 1)
`)
  await chmod(bridge, 0o755)
  return {
    bridge,
    bridgeHome,
    cleanup: () => rm(root, { force: true, recursive: true }),
    environment: {
      NODE_ENV: 'test',
      PORTA_BRIDGE_DISABLE_CLOUD_SPAWN: '1',
      PORTA_BRIDGE_HOME: bridgeHome,
      PORTA_WORKFLOW_TEST_BRIDGE_SOURCE: realBridgeSource,
    },
    project,
  }
}

function run(fixture, args) {
  return spawnSync(process.execPath, [clientPath, ...args], {
    cwd: fixture.project,
    encoding: 'utf8',
    env: {
      ...process.env,
      PORTA_BRIDGE_BIN: fixture.bridge,
      ...fixture.environment,
    },
  })
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function beginRun(fixture) {
  const key = parseSuccess(run(fixture, ['new-run-key'])).runKey
  const result = parseSuccess(run(fixture, [
    'begin',
    '--run-key', key,
    '--provider', 'codex',
  ]))
  return { key, result }
}

test('begin persists exact Bridge identity and replays locally without a duplicate WorkRun', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginRun(fixture)
    assert.equal(result.receipt.skillVersion, '0.1.1')
    assert.equal(result.receipt.workRunId, 'workrun_33333333-3333-4333-8333-333333333333')
    const replay = parseSuccess(run(fixture, ['begin', '--run-key', key, '--provider', 'codex']))
    assert.equal(replay.cached, true)
    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter((call) => call[1] === 'begin').length, 1)
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'))
    assert.deepEqual(Object.keys(state).sort(), [
      'beginIdempotencyKey',
      'cwd',
      'operations',
      'provider',
      'receipt',
      'runKey',
      'skillId',
      'skillVersion',
      'version',
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('Web Ready contract requires process durability beyond the Agent session', async () => {
  const [skill, reference] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(referencePath, 'utf8'),
  ])
  assert.match(skill, /durable process that can outlive the current Agent command\/session/u)
  assert.match(skill, /transient command runner is not Ready evidence/u)
  assert.match(reference, /survives the transient Agent command\/session/u)
  assert.match(reference, /temporary tool session, or immediate probe alone is insufficient/u)
  assert.match(reference, /preview_process_failed/u)
})

test('manifest injects Bridge identities and ready uses the exact WorkRun', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginRun(fixture)
    const specPath = join(fixture.project, '.porta', 'ready-spec.json')
    await mkdir(dirname(specPath), { recursive: true })
    await writeFile(specPath, JSON.stringify({
      artifacts: [{
        id: 'web-primary',
        name: 'Web preview',
        path: '/',
        remoteHost: '127.0.0.1',
        remotePort: 4173,
        scheme: 'http',
        type: 'web',
      }],
      logs: { summary: 'Verified' },
      project: { name: 'Fixture project' },
      status: 'ready',
    }))
    parseSuccess(run(fixture, ['preview-start', '--run-key', key]))
    parseSuccess(run(fixture, ['manifest', '--run-key', key, '--spec', specPath]))
    const manifest = JSON.parse(await readFile(result.receipt.manifestPath, 'utf8'))
    assert.equal(manifest.requestId, result.receipt.requestId)
    assert.equal(manifest.traceId, result.receipt.traceId)
    assert.equal(manifest.project.cwd, await realpath(fixture.project))
    assert.equal(manifest.logs.remotePath, result.receipt.logPath)
    const ready = parseSuccess(run(fixture, ['ready', '--run-key', key]))
    assert.equal(ready.receipt.command, 'preview-ready')
  } finally {
    await fixture.cleanup()
  }
})

test('operation keys make retries exact and reject changed input', async () => {
  const fixture = await createFixture()
  try {
    const { key } = await beginRun(fixture)
    const args = [
      'progress',
      '--run-key', key,
      '--operation-key', 'progress-planning-1',
      '--phase', 'planning',
      '--summary', 'Inspecting project',
    ]
    assert.equal(parseSuccess(run(fixture, args)).cached, false)
    assert.equal(parseSuccess(run(fixture, args)).cached, true)
    const conflict = run(fixture, [
      ...args.slice(0, -1),
      'Changed input',
    ])
    assert.equal(conflict.status, 1)
    assert.equal(JSON.parse(conflict.stderr).code, 'operation_key_conflict')
    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter((call) => call[1] === 'progress').length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('failed terminal manifest is written before the exact failure transition', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginRun(fixture)
    parseSuccess(run(fixture, ['preview-start', '--run-key', key]))
    const specPath = join(fixture.project, '.porta', 'failed-spec.json')
    await writeFile(specPath, JSON.stringify({
      artifacts: [],
      error: 'Gradle build failed',
      logs: { summary: 'See request-scoped log' },
      project: { name: 'Fixture project' },
      status: 'failed',
    }))
    parseSuccess(run(fixture, ['manifest', '--run-key', key, '--spec', specPath]))
    const manifest = JSON.parse(await readFile(result.receipt.manifestPath, 'utf8'))
    assert.equal(manifest.status, 'failed')
    assert.deepEqual(manifest.artifacts, [])
    assert.equal(manifest.error, 'Gradle build failed')
    const failed = parseSuccess(run(fixture, [
      'fail',
      '--run-key', key,
      '--outcome', 'failed',
      '--reason-code', 'build_failed',
    ]))
    assert.equal(failed.receipt.status, 'failed')
  } finally {
    await fixture.cleanup()
  }
})

test('malformed persisted identity fails closed without contacting a mutation', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginRun(fixture)
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'))
    state.receipt.workRunId = 'workrun_00000000-0000-0000-0000-000000000000'
    await writeFile(result.stateFile, JSON.stringify(state))
    const shown = run(fixture, ['show', '--run-key', key])
    assert.equal(shown.status, 1)
    assert.equal(JSON.parse(shown.stderr).code, 'malformed_bridge_receipt')
    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter((call) => call[1] !== 'capabilities' && call[1] !== 'begin').length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('symlinked Porta state directory is refused', async () => {
  const fixture = await createFixture()
  try {
    const outside = join(dirname(fixture.project), 'outside-state')
    await mkdir(outside)
    await symlink(outside, join(fixture.project, '.porta'))
    const key = parseSuccess(run(fixture, ['new-run-key'])).runKey
    const begun = run(fixture, ['begin', '--run-key', key, '--provider', 'codex'])
    assert.equal(begun.status, 1)
    assert.equal(JSON.parse(begun.stderr).code, 'unsafe_state_directory')
  } finally {
    await fixture.cleanup()
  }
})

test('incompatible Bridge runtime is rejected before a WorkRun begins', async () => {
  const fixture = await createFixture()
  fixture.environment.FAKE_RUNTIME_VERSION = '1.8.9'
  try {
    const capabilities = run(fixture, ['capabilities'])
    assert.equal(capabilities.status, 1)
    assert.equal(JSON.parse(capabilities.stderr).code, 'workflow_incompatible')
    const key = parseSuccess(run(fixture, ['new-run-key'])).runKey
    const begun = run(fixture, ['begin', '--run-key', key, '--provider', 'codex'])
    assert.equal(begun.status, 1)
    assert.equal(JSON.parse(begun.stderr).code, 'workflow_incompatible')
    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some((call) => call[1] === 'begin'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('client completes a Ready lifecycle against the real Agent Bridge', {
  skip: realBridgeSource ? false : 'set PORTA_WORKFLOW_TEST_BRIDGE_SOURCE to the Agent Bridge module',
}, async () => {
  const fixture = await createRealBridgeFixture()
  try {
    const { key, result } = await beginRun(fixture)
    parseSuccess(run(fixture, [
      'progress',
      '--run-key', key,
      '--operation-key', 'progress-planning-1',
      '--phase', 'planning',
      '--summary', 'Inspecting project',
    ]))
    parseSuccess(run(fixture, ['preview-start', '--run-key', key]))
    const specPath = join(fixture.project, '.porta', 'real-ready-spec.json')
    await writeFile(specPath, JSON.stringify({
      artifacts: [{
        id: 'web-primary',
        name: 'Web preview',
        path: '/',
        remoteHost: '127.0.0.1',
        remotePort: 4173,
        scheme: 'http',
        type: 'web',
      }],
      logs: { summary: 'Endpoint probe passed' },
      project: { name: 'Real Bridge fixture' },
      status: 'ready',
    }))
    parseSuccess(run(fixture, ['manifest', '--run-key', key, '--spec', specPath]))
    const ready = parseSuccess(run(fixture, ['ready', '--run-key', key]))
    assert.equal(ready.receipt.workRunId, result.receipt.workRunId)
    assert.equal(ready.receipt.status, 'ready')
    const bridgeState = JSON.parse(await readFile(join(fixture.bridgeHome, 'workflow', 'state.json'), 'utf8'))
    assert.equal(bridgeState.runs[result.receipt.workRunId].status, 'ready')
    assert.equal(bridgeState.runs[result.receipt.workRunId].requestId, result.receipt.requestId)
  } finally {
    await fixture.cleanup()
  }
})
