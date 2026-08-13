import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../scripts/porta-workflow.mjs', import.meta.url))
const referencePath = fileURLToPath(new URL('../references/bridge-workflow-v1.md', import.meta.url))
const releaseReferencePath = fileURLToPath(new URL('../references/bridge-workflow-v2.md', import.meta.url))
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
const optionFrom = (tokens, name) => tokens[tokens.indexOf(name) + 1]
const option = (name) => optionFrom(args, name)
const command = args[1]
const workflowVersion = option('--workflow-protocol-version') === '2' ? 2 : 1
const requestId = '11111111-1111-4111-8111-111111111111'
const traceId = '22222222-2222-4222-8222-222222222222'
const workRunId = 'workrun_33333333-3333-4333-8333-333333333333'
if (command === 'capabilities') {
  if (workflowVersion === 2) {
    console.log(JSON.stringify({
      capabilities: [
        'static-html-release',
        ...(process.env.FAKE_INCLUDE_EVENT_LOOP_CAPABILITY === '0' ? [] : ['porta.workflow.event-loop.v2'])
      ],
      commands: ['capabilities', 'attention', 'begin', 'preview-start', 'preview-ready', 'progress', 'candidate-register', 'cancel', 'fail', 'handle', 'pull'],
      eventContractVersion: 2,
      ok: true,
      platformSupported: true,
      protocolVersion: 1,
      runtimeVersion: process.env.FAKE_RUNTIME_VERSION,
      staleAfterSeconds: 900,
      traceId: option('--trace-id'),
      type: 'workflow-capabilities',
      workflowProtocolVersion: 2
    }))
    process.exit(0)
  }
  console.log(JSON.stringify({
    artifactKinds: ['web', 'android-apk'],
    commands: [
      'capabilities',
      'attention',
      'begin',
      'fail',
      'preview-ready',
      'preview-start',
      'progress',
      'stop',
      ...(process.env.FAKE_INCLUDE_READINESS_COMMAND === '0' ? [] : ['scene-pack-readiness-observe'])
    ],
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
if (command === 'scene-pack-readiness-observe') {
  const payload = JSON.parse(Buffer.from(option('--payload'), 'base64url').toString('utf8'))
  const { version, ...observation } = payload
  if (version !== 1) process.exit(2)
  const calls = fs.readFileSync(process.env.FAKE_BRIDGE_LOG, 'utf8').trim().split('\\n').map(JSON.parse)
  const idempotencyKey = option('--idempotency-key')
  const matchingCalls = calls.filter((call) => (
    call[1] === 'scene-pack-readiness-observe' &&
    optionFrom(call, '--idempotency-key') === idempotencyKey
  ))
  console.log(JSON.stringify({
    ...observation,
    cursor: process.env.FAKE_READINESS_CURSOR_TYPE === 'number' ? 1 : '1',
    idempotent: matchingCalls.length > 1,
    observedAt: '2026-08-12T00:00:00.000Z',
    ok: true,
    protocolVersion: 1,
    traceId: option('--trace-id'),
    type: 'workflow-scene-pack-readiness-receipt',
    workflowProtocolVersion: 1
  }))
  process.exit(0)
}
if (command === 'pull' && workflowVersion === 2) {
  const status = process.env.FAKE_PULL_STATUS || 'freezing'
  const hasCandidate = !['implementing', 'preview-ready'].includes(status)
  const hasRelease = ['ready', 'transferring', 'verifying'].includes(status)
  console.log(JSON.stringify({
    cursor: '0',
    events: [],
    protocolVersion: 1,
    runs: [{
      attentionRequired: false,
      ...(hasCandidate ? {
        candidate: {
          candidateDigest: 'a'.repeat(64),
          candidateRef: 'candidate_fixture-1234',
          registeredAt: '2026-07-31T10:05:00.000Z'
        }
      } : {}),
      createdAt: '2026-07-31T10:00:00.000Z',
      cwd: process.cwd(),
      eventContractVersion: 2,
      lastActivityAt: '2026-07-31T10:10:00.000Z',
      logPath: path.join(process.cwd(), '.porta', 'previews', requestId + '.log'),
      manifestPath: path.join(process.cwd(), '.porta', 'previews', requestId + '.json'),
      provider: 'codex',
      publishIntent: {
        issuedAt: '2026-07-31T10:00:00.000Z',
        projectContextGeneration: 1,
        projectRef: 'project_fixture-1234',
        ref: 'publish_fixture-1234'
      },
      ...(hasRelease ? {
        release: {
          attemptRef: 'attempt_fixture-1234',
          productRef: 'product_fixture-1234',
          releaseRef: 'release_fixture-1234',
          ...(status === 'ready' ? { revisionRef: 'revision_fixture-1234' } : {})
        }
      } : {}),
      requestId,
      skillId: 'porta-workflow',
      skillVersion: '2.4.0',
      sourceSequence: 7,
      status,
      ...(status === 'ready' ? { terminalAt: '2026-07-31T10:10:00.000Z' } : {}),
      traceId,
      updatedAt: '2026-07-31T10:10:00.000Z',
      workflowProtocolVersion: 2,
      workRunId
    }],
    traceId: option('--trace-id'),
    type: 'workflow-pull',
    workflowProtocolVersion: 2
  }))
  process.exit(0)
}
if (command === 'begin') {
  const cwd = option('--cwd')
  if (workflowVersion === 2) {
    console.log(JSON.stringify({
      created: true,
      eventContractVersion: 2,
      logPath: path.join(cwd, '.porta', 'previews', requestId + '.log'),
      manifestPath: path.join(cwd, '.porta', 'previews', requestId + '.json'),
      milestoneCursor: '1',
      ok: true,
      protocolVersion: 1,
      provider: option('--provider'),
      publishIntent: {
        issuedAt: '2026-07-31T10:00:00.000Z',
        projectContextGeneration: 1,
        projectRef: 'project_fixture-1234',
        ref: 'publish_fixture-1234'
      },
      requestId,
      skillId: option('--skill-id'),
      skillVersion: option('--skill-version'),
      sourceSequence: 1,
      status: 'implementing',
      traceId,
      type: 'workflow-begin',
      workflowProtocolVersion: 2,
      workRunId
    }))
    process.exit(0)
  }
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
const releaseStatuses = {
  attention: 'implementing',
  cancel: process.env.FAKE_CANCEL_STATUS || 'canceled',
  'candidate-register': 'freezing',
  fail: 'failed',
  'preview-ready': 'preview-ready',
  'preview-start': 'implementing',
  progress: 'preview-ready'
}
console.log(JSON.stringify({
  command,
  idempotent: false,
  ...(command === 'progress' ? {} : { milestoneCursor: '2' }),
  ok: true,
  protocolVersion: 1,
  sourceSequence: command === 'progress' ? 1 : 2,
  status: workflowVersion === 2 ? releaseStatuses[command] : statuses[command],
  traceId,
  type: 'workflow-receipt',
  workflowProtocolVersion: workflowVersion,
  workRunId
}))
`)
  await chmod(bridge, 0o755)
  return {
    bridge,
    cleanup: () => rm(root, { force: true, recursive: true }),
    environment: {
      FAKE_BRIDGE_LOG: log,
      FAKE_RUNTIME_VERSION: '1.16.1',
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
      PORTA_BRIDGE_DISABLE_RELEASE_SPAWN: '1',
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

function runAsync(fixture, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [clientPath, ...args], {
      cwd: fixture.project,
      env: {
        ...process.env,
        PORTA_BRIDGE_BIN: fixture.bridge,
        ...fixture.environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('close', (status) => {
      resolvePromise({ status, stderr, stdout })
    })
  })
}

function runBridgeDirect(fixture, args) {
  return spawnSync(fixture.bridge, args, {
    cwd: fixture.project,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...fixture.environment,
    },
  })
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function configureRealBridgeReleaseFixture(fixture) {
  const requests = []
  const delegatedToken = `nkd_${'release-token'.repeat(4)}`
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    const body = bytes.length === 0 ? undefined : JSON.parse(bytes.toString('utf8'))
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      path: request.url,
      traceId: request.headers['x-trace-id'],
    })
    response.setHeader('content-type', 'application/json')
    if (typeof request.headers['x-trace-id'] === 'string') {
      response.setHeader('x-trace-id', request.headers['x-trace-id'])
    }
    if (
      request.url ===
      '/v1/products/porta/functions/identity.delegated_token.exchange/invoke'
    ) {
      response.end(JSON.stringify({
        result: {
          output: { token: delegatedToken },
          status: 'succeeded',
        },
      }))
      return
    }
    if (request.url === '/v1/web-release/preflight') {
      if (request.headers.authorization !== `Bearer ${delegatedToken}`) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { code: 'authorization_required' } }))
        return
      }
      response.end(JSON.stringify({
        eligible: true,
        projectRef: body.projectRef,
        target: 'create',
      }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'route_not_found' } }))
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  parseSuccess(run(fixture, ['capabilities', '--workflow-protocol-version', '2']))
  const installationId = 'pinst_skill-v2-12345678'
  await writeFile(join(fixture.bridgeHome, 'cloud', 'config.json'), JSON.stringify({
    baseUrl,
    bindingGeneration: 1,
    capabilities: ['event-relay', 'live-presentation'],
    cloudStartCursor: '0',
    environmentId: 'development',
    installationId,
    productId: 'porta',
    protectionLevel: 'file_acl',
    state: 'linked',
    updatedAt: '2026-07-31T10:00:00.000Z',
    version: 1,
    webRelease: {
      audience: 'porta-web-release',
      baseUrl,
      limits: {
        maximumDisplayNameCharacters: 80,
        maximumFileBytes: 64 * 1024,
        maximumFiles: 100,
        maximumPathBytes: 240,
        maximumTotalBytes: 512 * 1024,
        maximumUploadBatchFiles: 20,
      },
      scopes: ['web_release:publish'],
      version: 1,
    },
  }))
  await writeFile(join(fixture.bridgeHome, 'cloud', 'authorization.json'), JSON.stringify({
    credential: `nki_${'installation-credential'.repeat(3)}`,
    version: 1,
  }))
  const projectRoot = await realpath(fixture.project)
  const projectContext = {
    contextVersion: 1,
    generation: 1,
    hostId: 'host_skill-v2-12345678',
    installationBindingGeneration: 1,
    installationId,
    isDefault: false,
    projectId: 'project-local-skill-v2-12345678',
    projectRef: 'project_skill-v2-12345678',
    rootPath: projectRoot,
    state: 'active',
    updatedAt: '2026-07-31T10:00:00.000Z',
  }
  const contextSync = runBridgeDirect(fixture, [
    'workflow',
    'context-sync',
    '--workflow-protocol-version', '2',
    '--payload', Buffer.from(JSON.stringify({
      contexts: [projectContext],
      hostId: projectContext.hostId,
      version: 1,
    }), 'utf8').toString('base64url'),
    '--trace-id', 'workflow-v2-skill-context-sync',
    '--json',
  ])
  const contextReceipt = parseSuccess(contextSync)
  assert.equal(contextReceipt.acceptedContexts, 1)

  return {
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise())
    }),
    projectRoot,
    requests,
  }
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

async function beginReleaseRun(fixture) {
  const key = parseSuccess(run(fixture, ['new-run-key'])).runKey
  const result = parseSuccess(run(fixture, [
    'begin',
    '--workflow-protocol-version', '2',
    '--run-key', key,
    '--provider', 'codex',
  ]))
  return { key, result }
}

async function beginReleaseRunAsync(fixture) {
  const key = parseSuccess(run(fixture, ['new-run-key'])).runKey
  const result = parseSuccess(await runAsync(fixture, [
    'begin',
    '--workflow-protocol-version', '2',
    '--run-key', key,
    '--provider', 'codex',
  ]))
  return { key, result }
}

async function writeScenePackReadinessSpec(fixture, name, overrides = {}) {
  const base = {
    capabilities: ['preview', 'build'],
    catalogFingerprint: '0123456789abcdef0123456789abcdef',
    catalogId: 'porta-workflow',
    installedSkills: [{ id: 'porta-workflow', path: 'porta-workflow' }],
    provider: 'codex',
    providerDiscovery: 'observed',
    readiness: 'ready',
    release: {
      commitSha: 'e9a5f27ef036f2dcc16f8b73dea2e53c913d76c8',
      tag: 'porta-workflow-v0.1.1',
      version: '0.1.1',
    },
    reloadObservation: 'not-required',
  }
  const spec = {
    ...base,
    ...overrides,
    release: { ...base.release, ...(overrides.release ?? {}) },
  }
  const specPath = join(fixture.project, `${name}.json`)
  await writeFile(specPath, JSON.stringify(spec))
  return { spec, specPath }
}

test('begin persists exact Bridge identity and replays locally without a duplicate WorkRun', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginRun(fixture)
    assert.equal(result.receipt.skillVersion, '2.4.0')
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

test('new client can recover an uncertain begin from the released v1 Skill state', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginRun(fixture)
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'))
    delete state.receipt
    state.skillVersion = '0.1.1'
    await writeFile(result.stateFile, JSON.stringify(state))

    const recovered = parseSuccess(run(fixture, [
      'begin',
      '--run-key', key,
      '--provider', 'codex',
    ]))
    assert.equal(recovered.receipt.skillVersion, '0.1.1')
    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    const beginCalls = calls.filter((call) => call[1] === 'begin')
    assert.equal(beginCalls.length, 2)
    assert.equal(beginCalls.at(-1)[beginCalls.at(-1).indexOf('--skill-version') + 1], '0.1.1')
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

test('Scene Pack readiness is neutral, deterministic, replayable, and never begins a WorkRun', async () => {
  const fixture = await createFixture()
  try {
    const help = run(fixture, ['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /scene-pack-readiness-observe --spec <json-file>/)
    assert.match(help.stdout, /Agent-observed UX signal; dedupe\/LKG only/u)

    const ready = await writeScenePackReadinessSpec(fixture, 'scene-ready')
    const first = parseSuccess(run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', ready.specPath,
    ]))
    assert.equal(first.type, 'porta-workflow-client-scene-pack-readiness')
    assert.equal(first.bridgeRuntimeVersion, '1.16.1')
    assert.match(first.idempotencyKey, /^porta-skill-scene-readiness:[a-f0-9]{64}$/)
    assert.equal(first.receipt.idempotent, false)
    assert.equal(first.receipt.readiness, 'ready')
    assert.deepEqual(first.receipt.capabilities, ['build', 'preview'])
    assert.equal(Object.hasOwn(first, 'workRunId'), false)
    assert.equal(Object.hasOwn(first.receipt, 'workRunId'), false)
    for (const authorityField of [
      'attested',
      'installationVerified',
      'publishAuthorized',
      'securityGatePassed',
      'verified',
    ]) {
      assert.equal(Object.hasOwn(first, authorityField), false)
      assert.equal(Object.hasOwn(first.receipt, authorityField), false)
    }

    const replay = parseSuccess(run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', ready.specPath,
    ]))
    assert.equal(replay.idempotencyKey, first.idempotencyKey)
    assert.equal(replay.receipt.idempotent, true)
    assert.equal(replay.receipt.cursor, first.receipt.cursor)

    const reloadRequired = await writeScenePackReadinessSpec(fixture, 'scene-reload-required', {
      readiness: 'reload-required',
      reloadObservation: 'required',
    })
    const changed = parseSuccess(run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', reloadRequired.specPath,
    ]))
    assert.notEqual(changed.idempotencyKey, first.idempotencyKey)
    assert.equal(changed.receipt.idempotent, false)
    assert.equal(changed.receipt.readiness, 'reload-required')

    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    const observeCalls = calls.filter((call) => call[1] === 'scene-pack-readiness-observe')
    assert.equal(observeCalls.length, 3)
    assert.equal(calls.some((call) => call[1] === 'begin'), false)
    assert.ok(observeCalls.every((call) => !call.includes('--work-run-id')))
    assert.ok(observeCalls.every((call) => !call.includes('--workflow-protocol-version')))
    const option = (call, name) => call[call.indexOf(name) + 1]
    assert.equal(option(observeCalls[0], '--idempotency-key'), first.idempotencyKey)
    assert.equal(option(observeCalls[1], '--idempotency-key'), first.idempotencyKey)
    assert.equal(option(observeCalls[2], '--idempotency-key'), changed.idempotencyKey)
    const payload = JSON.parse(Buffer.from(
      option(observeCalls[0], '--payload'),
      'base64url',
    ).toString('utf8'))
    assert.deepEqual(payload, {
      ...ready.spec,
      capabilities: ['build', 'preview'],
      version: 1,
    })
    assert.equal((await readdir(fixture.project)).includes('.porta'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('Scene Pack readiness requires Runtime 1.16.1 and the neutral Bridge command', async () => {
  for (const incompatible of [
    { environment: { FAKE_RUNTIME_VERSION: '1.16.0' }, name: 'previous-runtime' },
    { environment: { FAKE_INCLUDE_READINESS_COMMAND: '0' }, name: 'missing-command' },
  ]) {
    const fixture = await createFixture()
    Object.assign(fixture.environment, incompatible.environment)
    try {
      const { specPath } = await writeScenePackReadinessSpec(fixture, incompatible.name)
      const result = run(fixture, ['scene-pack-readiness-observe', '--spec', specPath])
      assert.equal(result.status, 1)
      const error = JSON.parse(result.stderr)
      assert.equal(error.code, 'workflow_incompatible')
      assert.match(error.message, /Runtime 1\.16\.1 or newer/u)
      const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.deepEqual(calls.map((call) => call[1]), ['capabilities'])
    } finally {
      await fixture.cleanup()
    }
  }
})

test('Scene Pack readiness accepts only coherent Agent claims and terminal readiness states', async () => {
  const fixture = await createFixture()
  try {
    const invalidCases = [
      { readiness: 'installed' },
      { providerDiscovery: 'missing' },
      { readiness: 'reload-required', reloadObservation: 'not-required' },
      { readiness: 'unavailable', providerDiscovery: 'missing', reloadObservation: 'required' },
      { catalogFingerprint: 'not-a-fingerprint' },
      { installedSkills: [{ id: 'porta-workflow', path: '../outside' }] },
      { unexpected: 'field' },
    ]
    for (const [index, overrides] of invalidCases.entries()) {
      const { specPath } = await writeScenePackReadinessSpec(
        fixture,
        `scene-invalid-${index}`,
        overrides,
      )
      const result = run(fixture, ['scene-pack-readiness-observe', '--spec', specPath])
      assert.equal(result.status, 1)
      assert.equal(JSON.parse(result.stderr).code, 'invalid_scene_pack_readiness_spec')
    }

    const valid = await writeScenePackReadinessSpec(fixture, 'scene-valid-target')
    const symlinkPath = join(fixture.project, 'scene-symlink.json')
    await symlink(valid.specPath, symlinkPath)
    const symlinkResult = run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', symlinkPath,
    ])
    assert.equal(symlinkResult.status, 1)
    assert.equal(
      JSON.parse(symlinkResult.stderr).code,
      'invalid_scene_pack_readiness_spec',
    )

    const oversizedPath = join(fixture.project, 'scene-oversized.json')
    await writeFile(oversizedPath, ' '.repeat((24 * 1024) + 1))
    const oversizedResult = run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', oversizedPath,
    ])
    assert.equal(oversizedResult.status, 1)
    assert.equal(
      JSON.parse(oversizedResult.stderr).code,
      'invalid_scene_pack_readiness_spec',
    )

    await assert.rejects(readFile(fixture.log, 'utf8'), { code: 'ENOENT' })
  } finally {
    await fixture.cleanup()
  }
})

test('Scene Pack readiness accepts an exact 24 KiB regular spec', async () => {
  const fixture = await createFixture()
  try {
    const { spec, specPath } = await writeScenePackReadinessSpec(
      fixture,
      'scene-exact-boundary',
    )
    const source = JSON.stringify(spec)
    assert.ok(source.length < 24 * 1024)
    await writeFile(specPath, source + ' '.repeat((24 * 1024) - source.length))

    const result = parseSuccess(run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', specPath,
    ]))
    assert.equal(result.receipt.readiness, 'ready')
  } finally {
    await fixture.cleanup()
  }
})

test('Scene Pack readiness rejects a receipt that violates the exact cursor type', async () => {
  const fixture = await createFixture()
  fixture.environment.FAKE_READINESS_CURSOR_TYPE = 'number'
  try {
    const { specPath } = await writeScenePackReadinessSpec(fixture, 'scene-invalid-receipt')
    const result = run(fixture, ['scene-pack-readiness-observe', '--spec', specPath])
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stderr).code, 'malformed_bridge_receipt')
  } finally {
    await fixture.cleanup()
  }
})

test('Workflow v2 capability preflight and begin are explicit and preserve the Publish Intent receipt', async () => {
  const fixture = await createFixture()
  try {
    const capabilities = parseSuccess(run(fixture, [
      'capabilities',
      '--workflow-protocol-version', '2',
    ]))
    assert.equal(capabilities.capabilities.workflowProtocolVersion, 2)
    assert.deepEqual(capabilities.capabilities.capabilities, [
      'static-html-release',
      'porta.workflow.event-loop.v2',
    ])

    const { key, result } = await beginReleaseRun(fixture)
    assert.equal(result.receipt.skillVersion, '2.4.0')
    assert.equal(result.receipt.status, 'implementing')
    assert.equal(result.receipt.publishIntent.projectRef, 'project_fixture-1234')
    assert.equal(result.receipt.publishIntent.projectContextGeneration, 1)
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'))
    assert.equal(state.workflowProtocolVersion, 2)

    const conflictingLegacyBegin = run(fixture, [
      'begin',
      '--run-key', key,
      '--provider', 'codex',
    ])
    assert.equal(conflictingLegacyBegin.status, 1)
    assert.equal(JSON.parse(conflictingLegacyBegin.stderr).code, 'run_key_conflict')

    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    const releaseCalls = calls.filter((call) => call.includes('--workflow-protocol-version'))
    assert.ok(releaseCalls.length >= 3)
    assert.ok(releaseCalls.every((call) =>
      call[call.indexOf('--workflow-protocol-version') + 1] === '2'))
  } finally {
    await fixture.cleanup()
  }
})

test('Workflow v2 rejects a static-only Bridge before publication begin', async () => {
  const fixture = await createFixture()
  fixture.environment.FAKE_INCLUDE_EVENT_LOOP_CAPABILITY = '0'
  try {
    const capabilities = run(fixture, ['capabilities', '--workflow-protocol-version', '2'])
    assert.equal(capabilities.status, 1)
    assert.equal(JSON.parse(capabilities.stderr).code, 'workflow_incompatible')
    const key = parseSuccess(run(fixture, ['new-run-key'])).runKey
    const begun = run(fixture, [
      'begin',
      '--workflow-protocol-version', '2',
      '--run-key', key,
      '--provider', 'codex',
    ])
    assert.equal(begun.status, 1)
    assert.equal(JSON.parse(begun.stderr).code, 'workflow_incompatible')
    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some((call) => call[1] === 'begin'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('workflow protocol version accepts only the exact 1 or 2 CLI literals', async () => {
  const fixture = await createFixture()
  try {
    for (const invalidVersion of ['02', '2.0', '+2']) {
      const result = run(fixture, [
        'capabilities',
        '--workflow-protocol-version', invalidVersion,
      ])
      assert.equal(result.status, 1)
      assert.equal(JSON.parse(result.stderr).code, 'invalid_workflow_version')
    }
    await assert.rejects(readFile(fixture.log, 'utf8'), { code: 'ENOENT' })
  } finally {
    await fixture.cleanup()
  }
})

test('Workflow v2 keeps Preview Ready nonterminal and hands one frozen candidate to Bridge', async () => {
  const fixture = await createFixture()
  try {
    const { key, result } = await beginReleaseRun(fixture)
    parseSuccess(run(fixture, [
      'preview-start',
      '--run-key', key,
      '--operation-key', 'preview-start-release-1',
    ]))
    const specPath = join(fixture.project, '.porta', 'release-preview-spec.json')
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
      logs: { summary: 'Preview endpoint and core route verified' },
      project: { name: 'Fixture project' },
      status: 'ready',
    }))
    parseSuccess(run(fixture, ['manifest', '--run-key', key, '--spec', specPath]))
    const previewReady = parseSuccess(run(fixture, [
      'preview-ready',
      '--run-key', key,
      '--operation-key', 'preview-ready-release-1',
    ]))
    assert.equal(previewReady.receipt.status, 'preview-ready')
    assert.notEqual(previewReady.receipt.status, 'ready')

    parseSuccess(run(fixture, [
      'preview-start',
      '--run-key', key,
      '--operation-key', 'preview-start-release-2',
    ]))
    parseSuccess(run(fixture, ['manifest', '--run-key', key, '--spec', specPath]))
    const secondPreviewReady = parseSuccess(run(fixture, [
      'preview-ready',
      '--run-key', key,
      '--operation-key', 'preview-ready-release-2',
    ]))
    assert.equal(secondPreviewReady.receipt.status, 'preview-ready')

    const progress = parseSuccess(run(fixture, [
      'progress',
      '--run-key', key,
      '--operation-key', 'progress-previewing-1',
      '--phase', 'previewing',
      '--percent', '100',
      '--summary', 'Preview verified; preparing immutable candidate',
    ]))
    assert.equal(progress.receipt.status, 'preview-ready')

    const candidateArgs = [
      'candidate-register',
      '--run-key', key,
      '--operation-key', 'candidate-static-html-1',
      '--output-root', 'dist',
      '--entry-path', 'index.html',
      '--display-name', 'Fixture Product',
      '--spa-fallback', '1',
    ]
    const registered = parseSuccess(run(fixture, candidateArgs))
    assert.equal(registered.receipt.status, 'freezing')
    assert.equal(registered.cached, false)
    assert.equal(parseSuccess(run(fixture, candidateArgs)).cached, true)
    const status = parseSuccess(run(fixture, ['release-status', '--run-key', key]))
    assert.equal(status.run.status, 'freezing')
    assert.equal(status.run.workRunId, result.receipt.workRunId)

    const changedCandidateArgs = [...candidateArgs]
    changedCandidateArgs[10] = 'Different Product'
    const changedCandidate = run(fixture, changedCandidateArgs)
    assert.equal(changedCandidate.status, 1)
    assert.equal(JSON.parse(changedCandidate.stderr).code, 'operation_key_conflict')

    const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter((call) => call[1] === 'preview-start').length, 2)
    assert.equal(calls.filter((call) => call[1] === 'preview-ready').length, 2)
    assert.equal(calls.filter((call) => call[1] === 'pull').length, 1)
    const candidateCalls = calls.filter((call) => call[1] === 'candidate-register')
    assert.equal(candidateCalls.length, 1)
    assert.ok(candidateCalls[0].includes('--workflow-protocol-version'))
    assert.equal(candidateCalls[0][candidateCalls[0].indexOf('--workflow-protocol-version') + 1], '2')
    assert.equal(calls.some((call) => call[0] === 'release-worker'), false)
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'))
    assert.equal(state.operations['candidate-static-html-1'].command, 'candidate-register')
  } finally {
    await fixture.cleanup()
  }
})

test('Workflow v2 reports Release Ready only from an authoritative pull', async () => {
  const fixture = await createFixture()
  fixture.environment.FAKE_PULL_STATUS = 'ready'
  try {
    const { key, result } = await beginReleaseRun(fixture)
    const status = parseSuccess(run(fixture, ['release-status', '--run-key', key]))
    assert.equal(status.run.workRunId, result.receipt.workRunId)
    assert.equal(status.run.status, 'ready')
    assert.equal(status.run.release.revisionRef, 'revision_fixture-1234')
    assert.equal(status.run.terminalAt, '2026-07-31T10:10:00.000Z')
  } finally {
    await fixture.cleanup()
  }
})

test('Workflow v2 cancel is exact and an activation-won receipt is not mislabeled canceled', async () => {
  const localFixture = await createFixture()
  try {
    const { key } = await beginReleaseRun(localFixture)
    const canceled = parseSuccess(run(localFixture, ['cancel', '--run-key', key]))
    assert.equal(canceled.receipt.status, 'canceled')
    assert.equal(parseSuccess(run(localFixture, ['cancel', '--run-key', key])).cached, true)
    const legacyStop = run(localFixture, ['stop', '--run-key', key])
    assert.equal(legacyStop.status, 1)
    assert.equal(JSON.parse(legacyStop.stderr).code, 'unsupported_workflow_command')
  } finally {
    await localFixture.cleanup()
  }

  const activationFixture = await createFixture()
  activationFixture.environment.FAKE_CANCEL_STATUS = 'ready'
  try {
    const { key } = await beginReleaseRun(activationFixture)
    const activationWon = parseSuccess(run(activationFixture, ['cancel', '--run-key', key]))
    assert.equal(activationWon.receipt.status, 'ready')
  } finally {
    await activationFixture.cleanup()
  }
})

test('Workflow v2 guidance keeps project choice model-owned and Bridge-owned release boundaries explicit', async () => {
  const [skill, reference] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(releaseReferencePath, 'utf8'),
  ])
  assert.match(skill, /current user message to unambiguously ask to publish or/u)
  assert.match(skill, /Do not require the message to name this[\s\S]*Skill, say Porta, or use `\$porta-workflow`/u)
  assert.match(skill, /Bridge[\s\S]*preflight remains the final fail-closed authority/u)
  assert.match(skill, /Scene Pack installation Agent may run the bundled readiness client directly without activating this Skill/u)
  assert.match(skill, /readiness command never calls `begin` or creates a WorkRun/u)
  assert.doesNotMatch(skill, /Continue only when the current user message explicitly invokes or names Porta Workflow/u)
  assert.match(skill, /before modifying product[\s\S]*source/u)
  assert.match(skill, /repository evidence determine/u)
  assert.match(reference, /Preview Ready is nonterminal/u)
  assert.match(reference, /candidate-register.*not Release Ready/us)
  assert.match(reference, /Do not run.*release-worker/us)
  assert.match(reference, /does not inspect.*account.*PRO/us)
  assert.match(reference, /Project Context.*Bridge/us)
  assert.match(reference, /Scene Pack readiness observation is a neutral, Agent-observed UX signal and\s+creates no WorkRun/u)
  assert.match(skill, /Bridge Runtime `1\.16\.1` or newer/u)
  assert.match(reference, /Runtime `1\.16\.1`[\s\S]*scene-pack-readiness-observe/u)
  assert.match(reference, /static-html-release[\s\S]*porta\.workflow\.event-loop\.v2/u)
  assert.match(reference, /symlink.*fail/us)
  assert.match(reference, /local asset reference.*fail/us)
  assert.match(reference, /same operation key.*identical input/us)
  assert.match(reference, /Immediately after this accepted[\s\S]*stop the exact Preview process/u)
})

test('Scene Pack readiness is an Agent claim for UX dedupe and LKG, never an attestation or security gate', async () => {
  const [skill, reference] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(releaseReferencePath, 'utf8'),
  ])
  const skillSection = skill.match(/## Scene Pack readiness[\s\S]*?(?=\n## )/u)?.[0] ?? ''
  const referenceSection = reference.match(
    /## Scene Pack readiness observation[\s\S]*?(?=\n## Preflight and begin)/u,
  )?.[0] ?? ''

  assert.match(skillSection, /current Agent's structured claim/u)
  assert.match(skillSection, /UX reminder deduplication and last-known-good/u)
  assert.match(skillSection, /not verified or attested/u)
  assert.match(skillSection, /never.*security gate/isu)
  assert.doesNotMatch(skillSection, /trusted Scene prompt/u)
  assert.doesNotMatch(skillSection, /normalizes evidence/u)

  assert.match(referenceSection, /does not inspect the Provider's\s+user-level Skill directory/u)
  assert.match(referenceSection, /does not hash installed content/u)
  assert.match(referenceSection, /does not\s+independently query Provider discovery or reload state/u)
  assert.match(referenceSection, /does not\s+authenticate the Agent making the claim/u)
  assert.match(referenceSection, /project-controlled prompt[\s\S]*public catalog values/u)
  assert.match(referenceSection, /UX reminder deduplication and\s+last-known-good/u)
  assert.match(referenceSection, /not a security gate/u)
  assert.match(referenceSection, /cannot authorize `begin`, a WorkRun, or publication/u)
  assert.match(referenceSection, /while that receipt remains in the\s+Bridge's bounded retained history/u)
  assert.match(referenceSection, /same observation and cursor[\s\S]*`idempotent=true`[\s\S]*diagnostic trace/u)
  assert.match(referenceSection, /After pruning[\s\S]*new cursor and observation receipt/u)
  assert.doesNotMatch(referenceSection, /trusted Scene prompt/u)
})

test('client reports neutral Scene Pack readiness against the real Agent Bridge', {
  skip: realBridgeSource ? false : 'set PORTA_WORKFLOW_TEST_BRIDGE_SOURCE to the Agent Bridge module',
}, async () => {
  const fixture = await createRealBridgeFixture()
  try {
    const { specPath } = await writeScenePackReadinessSpec(fixture, 'real-scene-ready')
    const first = parseSuccess(run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', specPath,
    ]))
    assert.equal(first.bridgeRuntimeVersion, '1.16.1')
    const replay = parseSuccess(run(fixture, [
      'scene-pack-readiness-observe',
      '--spec', specPath,
    ]))
    assert.equal(first.receipt.idempotent, false)
    assert.equal(replay.receipt.idempotent, true)
    assert.equal(replay.idempotencyKey, first.idempotencyKey)
    assert.equal(replay.receipt.cursor, first.receipt.cursor)

    const state = JSON.parse(await readFile(
      join(fixture.bridgeHome, 'workflow', 'state.json'),
      'utf8',
    ))
    assert.equal(Object.keys(state.scenePackReadinessReceipts).length, 1)
    assert.deepEqual(state.beginReceipts, {})
    assert.deepEqual(state.runs, {})
    assert.equal((await readdir(fixture.project)).includes('.porta'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('client hands a frozen candidate to the real Workflow v2 Agent Bridge', {
  skip: realBridgeSource ? false : 'set PORTA_WORKFLOW_TEST_BRIDGE_SOURCE to the Agent Bridge module',
}, async () => {
  const fixture = await createRealBridgeFixture()
  let releaseFixture
  try {
    releaseFixture = await configureRealBridgeReleaseFixture(fixture)
    const { key, result } = await beginReleaseRunAsync(fixture)
    assert.equal(result.receipt.publishIntent.projectRef, 'project_skill-v2-12345678')
    parseSuccess(run(fixture, [
      'preview-start',
      '--run-key', key,
      '--operation-key', 'preview-start-real-v2-1',
    ]))

    const specPath = join(fixture.project, '.porta', 'real-release-preview-spec.json')
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
      logs: { summary: 'Real Bridge contract preview evidence' },
      project: { name: 'Real release fixture' },
      status: 'ready',
    }))
    parseSuccess(run(fixture, ['manifest', '--run-key', key, '--spec', specPath]))
    const previewReady = parseSuccess(run(fixture, [
      'preview-ready',
      '--run-key', key,
      '--operation-key', 'preview-ready-real-v2-1',
    ]))
    assert.equal(previewReady.receipt.status, 'preview-ready')

    const outputRoot = join(fixture.project, 'dist')
    await mkdir(outputRoot)
    await writeFile(
      join(outputRoot, 'index.html'),
      '<!doctype html><html><body><main>Real Bridge v2 fixture</main></body></html>',
    )
    const registered = parseSuccess(run(fixture, [
      'candidate-register',
      '--run-key', key,
      '--operation-key', 'candidate-real-bridge-v2-1',
      '--output-root', 'dist',
      '--entry-path', 'index.html',
      '--display-name', 'Real Bridge Fixture',
      '--spa-fallback', '0',
    ]))
    assert.equal(registered.receipt.status, 'freezing')
    const status = parseSuccess(run(fixture, ['release-status', '--run-key', key]))
    assert.equal(status.run.status, 'freezing')

    const bridgeState = JSON.parse(await readFile(
      join(fixture.bridgeHome, 'workflow', 'v2', 'state.json'),
      'utf8',
    ))
    assert.equal(bridgeState.runs[result.receipt.workRunId].status, 'freezing')
    assert.match(
      bridgeState.runs[result.receipt.workRunId].candidate.candidateDigest,
      /^[a-f0-9]{64}$/,
    )
    const jobs = await readdir(join(fixture.bridgeHome, 'workflow', 'v2', 'jobs'))
    assert.equal(jobs.filter((entry) => entry.endsWith('.json')).length, 1)
    assert.deepEqual(
      releaseFixture.requests.map((request) => request.path),
      [
        '/v1/products/porta/functions/identity.delegated_token.exchange/invoke',
        '/v1/web-release/preflight',
      ],
    )
    const preflightRequest = releaseFixture.requests.find((request) => (
      request.path === '/v1/web-release/preflight'
    ))
    assert.equal(typeof preflightRequest?.traceId, 'string')
    assert.ok(preflightRequest.traceId.length > 0)

    const canceled = parseSuccess(run(fixture, ['cancel', '--run-key', key]))
    assert.equal(canceled.receipt.status, 'canceled')
  } finally {
    await releaseFixture?.close()
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
