#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const CLIENT_STATE_VERSION = 1
const LEGACY_WORKFLOW_PROTOCOL_VERSION = 1
const RELEASE_WORKFLOW_PROTOCOL_VERSION = 2
const MINIMUM_LEGACY_WORKFLOW_RUNTIME = '1.9.0'
const MINIMUM_RELEASE_WORKFLOW_RUNTIME = '1.14.0'
const MINIMUM_SCENE_PACK_READINESS_RUNTIME = '1.16.1'
const SKILL_ID = 'porta-workflow'
const SKILL_VERSION = '2.4.1'
const RESUMABLE_LEGACY_SKILL_VERSIONS = new Set(['0.1.0', '0.1.1'])
const RESUMABLE_PRIOR_SKILL_VERSIONS = new Set(['2.4.0'])
const MAXIMUM_BRIDGE_OUTPUT_BYTES = 1024 * 1024
const MAXIMUM_SPEC_BYTES = 1024 * 1024
const MAXIMUM_SCENE_PACK_READINESS_SPEC_BYTES = 24 * 1024
const MAXIMUM_OPERATIONS = 256
const providers = new Set(['codex', 'claude', 'gemini'])
const scenePackCapabilityOrder = ['build', 'preview', 'deploy', 'publish']
const scenePackReadinessFields = [
  'capabilities',
  'catalogFingerprint',
  'catalogId',
  'installedSkills',
  'provider',
  'providerDiscovery',
  'readiness',
  'release',
  'reloadObservation',
]
const legacyProgressPhases = new Set(['building', 'implementing', 'planning', 'testing', 'waiting'])
const releaseProgressPhases = new Set([
  ...legacyProgressPhases,
  'freezing',
  'previewing',
  'transferring',
  'verifying',
])
const terminalOutcomes = new Set(['failed', 'unsupported'])
const runKeyPattern = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const operationKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const reasonCodePattern = /^[a-z][a-z0-9._:-]{0,119}$/
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/
const strictSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const workflowRunPattern = /^workrun_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

class ClientError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2)
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(helpText())
    return
  }
  if (command === '--version' || command === 'version') {
    writeResult({ ok: true, skillId: SKILL_ID, skillVersion: SKILL_VERSION, type: 'porta-workflow-client-version' })
    return
  }
  if (command === 'new-run-key') {
    requireNoArguments(tokens)
    writeResult({ ok: true, runKey: `run_${randomUUID()}`, type: 'porta-workflow-run-key' })
    return
  }
  if (command === 'capabilities') {
    const options = parseOptions(tokens, ['workflow-protocol-version'])
    const workflowProtocolVersion = requireWorkflowProtocolVersion(options['workflow-protocol-version'])
    const capabilities = await readCapabilities(workflowProtocolVersion)
    writeResult({ capabilities, ok: true, type: 'porta-workflow-client-capabilities' })
    return
  }
  if (command === 'scene-pack-readiness-observe') {
    await observeScenePackReadiness(tokens)
    return
  }
  if (command === 'begin') {
    await begin(tokens)
    return
  }
  if (command === 'show') {
    await show(tokens)
    return
  }
  if (command === 'release-status') {
    await releaseStatus(tokens)
    return
  }
  if (command === 'manifest') {
    await writeManifest(tokens)
    return
  }
  if ([
    'attention',
    'cancel',
    'candidate-register',
    'fail',
    'preview-start',
    'progress',
    'preview-ready',
    'ready',
    'stop',
  ].includes(command)) {
    await mutate(command, tokens)
    return
  }
  throw new ClientError('unsupported_command', `Unsupported Porta Workflow client command: ${command}`)
}

function helpText() {
  return `Porta Workflow client ${SKILL_VERSION}\n\n` +
    `Scene Pack readiness (Agent-observed UX signal; dedupe/LKG only; no WorkRun or publish authority):\n` +
    `  porta-workflow.mjs scene-pack-readiness-observe --spec <json-file>\n\n` +
    `Workflow v2 Static HTML publication (the version selector is required):\n` +
    `  porta-workflow.mjs capabilities --workflow-protocol-version 2\n` +
    `  porta-workflow.mjs new-run-key\n` +
    `  porta-workflow.mjs begin --workflow-protocol-version 2 --run-key <key> --provider <codex|claude|gemini> [--provider-session-id <id>] [--cwd <path>]\n` +
    `  porta-workflow.mjs show --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs progress --run-key <key> --operation-key <key> --phase <phase> [--percent <0-100>] [--summary <text>] [--cwd <path>]\n` +
    `  porta-workflow.mjs preview-start --run-key <key> --operation-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs attention --run-key <key> --operation-key <key> --reason-code <code> [--cwd <path>]\n` +
    `  porta-workflow.mjs manifest --run-key <key> --spec <json-file> [--cwd <path>]\n` +
    `  porta-workflow.mjs preview-ready --run-key <key> --operation-key <key> [--cwd <path>]  # nonterminal\n` +
    `  porta-workflow.mjs candidate-register --run-key <key> --operation-key <key> --output-root <path> --entry-path <path> --display-name <name> --spa-fallback <0|1> [--cwd <path>]\n` +
    `  porta-workflow.mjs release-status --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs cancel --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs fail --run-key <key> --reason-code <code> [--cwd <path>]\n\n` +
    `Workflow v1 legacy Product Preview (protocol selector omitted or 1):\n` +
    `  porta-workflow.mjs capabilities\n` +
    `  porta-workflow.mjs begin --run-key <key> --provider <codex|claude|gemini> [--provider-session-id <id>] [--cwd <path>]\n` +
    `  porta-workflow.mjs ready --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs fail --run-key <key> --outcome <failed|unsupported> [--reason-code <code>] [--cwd <path>]\n` +
    `  porta-workflow.mjs stop --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs version\n\n` +
    `Set PORTA_BRIDGE_BIN only when Porta installed the Bridge launcher outside PATH.\n`
}

async function observeScenePackReadiness(tokens) {
  const options = parseOptions(tokens, ['spec'])
  const observation = await readScenePackReadinessSpec(options.spec)
  const bridgeCapabilities = await readScenePackReadinessCapabilities()
  const idempotencyKey = scenePackReadinessIdempotencyKey(observation)
  const traceId = `porta-skill-scene-readiness:${randomUUID()}`
  const payload = Buffer.from(JSON.stringify({ ...observation, version: 1 }), 'utf8')
    .toString('base64url')
  const receipt = validateScenePackReadinessReceipt(await runBridge([
    'workflow',
    'scene-pack-readiness-observe',
    '--payload', payload,
    '--idempotency-key', idempotencyKey,
    '--trace-id', traceId,
    '--json',
  ]), observation, traceId)
  writeResult({
    bridgeRuntimeVersion: bridgeCapabilities.runtimeVersion,
    idempotencyKey,
    ok: true,
    receipt,
    type: 'porta-workflow-client-scene-pack-readiness',
  })
}

async function begin(tokens) {
  const options = parseOptions(tokens, [
    'cwd',
    'provider',
    'provider-session-id',
    'run-key',
    'workflow-protocol-version',
  ])
  const runKey = requireRunKey(options['run-key'])
  const provider = requireProvider(options.provider)
  const providerSessionId = optionalBoundedText(options['provider-session-id'], 256, 'provider session id')
  const workflowProtocolVersion = requireWorkflowProtocolVersion(options['workflow-protocol-version'])
  const cwd = await resolveProjectCwd(options.cwd)
  await readCapabilities(workflowProtocolVersion)
  const stateFile = await ensureStateFile(cwd, runKey)
  const existing = await readOptionalState(stateFile)
  let state
  if (existing) {
    if (
      existing.cwd !== cwd ||
      existing.provider !== provider ||
      existing.providerSessionId !== providerSessionId ||
      existing.runKey !== runKey ||
      workflowProtocolVersionForState(existing) !== workflowProtocolVersion
    ) {
      throw new ClientError('run_key_conflict', 'Run key is already bound to different begin input.')
    }
    state = existing
  } else {
    state = {
      beginIdempotencyKey: `porta-skill-begin:${randomUUID()}`,
      cwd,
      operations: {},
      provider,
      ...(providerSessionId ? { providerSessionId } : {}),
      runKey,
      skillId: SKILL_ID,
      skillVersion: SKILL_VERSION,
      version: CLIENT_STATE_VERSION,
      ...(workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
        ? { workflowProtocolVersion }
        : {}),
    }
    await writeState(stateFile, state)
  }
  if (state.receipt) {
    writeResult(clientReceiptResult('begin', stateFile, state.receipt, true))
    return
  }
  const receipt = await runBridge([
    'workflow',
    'begin',
    ...(workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
      ? ['--workflow-protocol-version', String(workflowProtocolVersion)]
      : []),
    '--cwd', cwd,
    '--event-contract-version', String(workflowProtocolVersion),
    '--idempotency-key', state.beginIdempotencyKey,
    '--provider', provider,
    ...(providerSessionId ? ['--provider-session-id', providerSessionId] : []),
    '--skill-id', SKILL_ID,
    '--skill-version', state.skillVersion,
    '--json',
  ])
  state.receipt = validateBeginReceipt(receipt, state)
  await writeState(stateFile, state)
  writeResult(clientReceiptResult('begin', stateFile, state.receipt, false))
}

async function show(tokens) {
  const options = parseOptions(tokens, ['cwd', 'run-key'])
  const { state, stateFile } = await loadState(options)
  writeResult({
    cwd: state.cwd,
    latest: state.latestReceipt ?? state.receipt,
    ok: true,
    operations: Object.entries(state.operations).map(([operationKey, operation]) => ({
      command: operation.command,
      completed: Boolean(operation.receipt),
      operationKey,
    })),
    provider: state.provider,
    ...(state.providerSessionId ? { providerSessionId: state.providerSessionId } : {}),
    receipt: state.receipt,
    runKey: state.runKey,
    stateFile,
    type: 'porta-workflow-client-state',
    workflowProtocolVersion: workflowProtocolVersionForState(state),
  })
}

async function releaseStatus(tokens) {
  const options = parseOptions(tokens, ['cwd', 'run-key'])
  const { state, stateFile } = await loadState(options)
  if (!state.receipt) {
    throw new ClientError('workflow_not_begun', 'Run key has no completed Bridge begin receipt.')
  }
  if (workflowProtocolVersionForState(state) !== RELEASE_WORKFLOW_PROTOCOL_VERSION) {
    throw new ClientError(
      'unsupported_workflow_command',
      'Release status requires a Workflow v2 run.',
    )
  }
  const traceId = `porta-skill-release-status:${randomUUID()}`
  const batch = await runBridge([
    'workflow',
    'pull',
    '--workflow-protocol-version', String(RELEASE_WORKFLOW_PROTOCOL_VERSION),
    '--after', '0',
    '--limit', '1',
    '--trace-id', traceId,
    '--json',
  ])
  const run = validateReleaseStatusBatch(batch, state, traceId)
  writeResult({
    ok: true,
    run,
    runKey: state.runKey,
    stateFile,
    type: 'porta-workflow-client-release-status',
    workflowProtocolVersion: RELEASE_WORKFLOW_PROTOCOL_VERSION,
  })
}

async function mutate(command, tokens) {
  const allowed = mutationAllowedOptions(command)
  const options = parseOptions(tokens, allowed)
  const { state, stateFile } = await loadState(options)
  if (!state.receipt) throw new ClientError('workflow_not_begun', 'Run key has no completed Bridge begin receipt.')
  const mutation = normalizeMutation(command, options, state)
  const inputHash = hashJson({ command: mutation.bridgeCommand, input: mutation.input })
  const prior = state.operations[mutation.operationKey]
  if (prior) {
    if (prior.command !== mutation.bridgeCommand || prior.inputHash !== inputHash) {
      throw new ClientError('operation_key_conflict', 'Operation key is already bound to different input.')
    }
    if (prior.receipt) {
      writeResult(clientReceiptResult(mutation.bridgeCommand, stateFile, prior.receipt, true))
      return
    }
  } else {
    if (Object.keys(state.operations).length >= MAXIMUM_OPERATIONS) {
      throw new ClientError('operation_capacity_exceeded', 'Client state has reached its operation limit.')
    }
    state.operations[mutation.operationKey] = {
      command: mutation.bridgeCommand,
      createdAt: new Date().toISOString(),
      idempotencyKey: operationIdempotencyKey(state.runKey, mutation.operationKey),
      inputHash,
    }
    await writeState(stateFile, state)
  }
  const operation = state.operations[mutation.operationKey]
  const workflowProtocolVersion = workflowProtocolVersionForState(state)
  const receipt = await runBridge([
    'workflow',
    mutation.bridgeCommand,
    ...(workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
      ? ['--workflow-protocol-version', String(workflowProtocolVersion)]
      : []),
    '--work-run-id', state.receipt.workRunId,
    '--idempotency-key', operation.idempotencyKey,
    ...mutation.bridgeArguments,
    '--json',
  ])
  operation.receipt = validateMutationReceipt(receipt, state.receipt, mutation)
  state.latestReceipt = operation.receipt
  await writeState(stateFile, state)
  writeResult(clientReceiptResult(mutation.bridgeCommand, stateFile, operation.receipt, false))
}

function mutationAllowedOptions(command) {
  const common = ['cwd', 'run-key']
  if (command === 'progress') return [...common, 'operation-key', 'percent', 'phase', 'summary']
  if (command === 'attention') return [...common, 'operation-key', 'reason-code']
  if (
    command === 'preview-ready' ||
    command === 'preview-start' ||
    command === 'ready'
  ) return [...common, 'operation-key']
  if (command === 'candidate-register') {
    return [
      ...common,
      'display-name',
      'entry-path',
      'operation-key',
      'output-root',
      'spa-fallback',
    ]
  }
  if (command === 'fail') return [...common, 'outcome', 'reason-code']
  return common
}

function normalizeMutation(command, options, state) {
  const workflowProtocolVersion = workflowProtocolVersionForState(state)
  const isRelease = workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
  if (command === 'progress') {
    const operationKey = requireOperationKey(options['operation-key'])
    const phase = String(options.phase ?? '')
    const allowedPhases = isRelease ? releaseProgressPhases : legacyProgressPhases
    if (!allowedPhases.has(phase)) throw new ClientError('invalid_phase', 'Progress phase is invalid.')
    const percent = optionalPercent(options.percent)
    const summary = optionalBoundedText(options.summary, 240, 'progress summary')
    return {
      bridgeArguments: [
        '--phase', phase,
        ...(percent === undefined ? [] : ['--percent', String(percent)]),
        ...(summary ? ['--summary', summary] : []),
      ],
      bridgeCommand: 'progress',
      expectedStatuses: isRelease
        ? ['freezing', 'implementing', 'preview-ready', 'transferring', 'verifying']
        : ['active', 'building'],
      input: { percent, phase, summary, workRunId: state.receipt.workRunId },
      operationKey,
    }
  }
  if (command === 'attention') {
    const operationKey = requireOperationKey(options['operation-key'])
    const reasonCode = requireReasonCode(options['reason-code'])
    return {
      bridgeArguments: ['--reason-code', reasonCode],
      bridgeCommand: 'attention',
      expectedStatuses: isRelease
        ? ['freezing', 'implementing', 'preview-ready', 'transferring', 'verifying']
        : ['active', 'building'],
      input: { reasonCode, workRunId: state.receipt.workRunId },
      milestoneOptional: isRelease,
      operationKey,
    }
  }
  if (command === 'preview-start') {
    const operationKey = isRelease
      ? requireOperationKey(options['operation-key'])
      : options['operation-key'] === undefined
        ? 'preview-start'
        : requireOperationKey(options['operation-key'])
    return fixedMutation(
      operationKey,
      'preview-start',
      [],
      { workRunId: state.receipt.workRunId },
      [isRelease ? 'implementing' : 'building'],
    )
  }
  if (command === 'ready' || command === 'preview-ready') {
    if (isRelease && command === 'ready') {
      throw new ClientError(
        'unsupported_workflow_command',
        'Workflow v2 uses preview-ready so it cannot be confused with Release Ready.',
      )
    }
    const operationKey = isRelease
      ? requireOperationKey(options['operation-key'])
      : options['operation-key'] === undefined
        ? 'preview-ready'
        : requireOperationKey(options['operation-key'])
    return fixedMutation(
      operationKey,
      'preview-ready',
      [],
      { workRunId: state.receipt.workRunId },
      [isRelease ? 'preview-ready' : 'ready'],
    )
  }
  if (command === 'stop') {
    if (isRelease) {
      throw new ClientError(
        'unsupported_workflow_command',
        'Workflow v2 release runs use cancel instead of legacy stop.',
      )
    }
    return fixedMutation('stop', 'stop', [], { workRunId: state.receipt.workRunId }, ['stopped'])
  }
  if (command === 'cancel') {
    if (!isRelease) {
      throw new ClientError(
        'unsupported_workflow_command',
        'Workflow v1 preview runs use stop instead of release cancel.',
      )
    }
    return {
      ...fixedMutation(
        'cancel',
        'cancel',
        [],
        { workRunId: state.receipt.workRunId },
        ['canceled', 'ready'],
      ),
      milestoneOptional: true,
    }
  }
  if (command === 'candidate-register') {
    if (!isRelease) {
      throw new ClientError(
        'unsupported_workflow_command',
        'Frozen release candidates require Workflow v2.',
      )
    }
    const operationKey = requireOperationKey(options['operation-key'])
    const outputRoot = requireBoundedText(options['output-root'], 4096, 'candidate output root')
    const entryPath = requireBoundedText(options['entry-path'], 4096, 'candidate entry path')
    const displayName = requireBoundedText(options['display-name'], 160, 'candidate display name')
    const spaFallback = requireWorkflowBoolean(options['spa-fallback'], 'candidate SPA fallback')
    return {
      bridgeArguments: [
        '--output-root', outputRoot,
        '--entry-path', entryPath,
        '--display-name', displayName,
        '--spa-fallback', spaFallback,
      ],
      bridgeCommand: 'candidate-register',
      expectedStatuses: ['freezing'],
      input: {
        displayName,
        entryPath,
        outputRoot,
        spaFallback,
        workRunId: state.receipt.workRunId,
      },
      operationKey,
    }
  }
  if (isRelease) {
    if (options.outcome !== undefined && options.outcome !== 'failed') {
      throw new ClientError('invalid_outcome', 'Workflow v2 failure outcome must be failed.')
    }
    const reasonCode = requireReasonCode(options['reason-code'])
    return fixedMutation(
      'fail',
      'fail',
      ['--reason-code', reasonCode],
      { reasonCode, workRunId: state.receipt.workRunId },
      ['failed'],
    )
  }
  const outcome = String(options.outcome ?? '')
  if (!terminalOutcomes.has(outcome)) throw new ClientError('invalid_outcome', 'Failure outcome must be failed or unsupported.')
  const reasonCode = options['reason-code'] === undefined ? undefined : requireReasonCode(options['reason-code'])
  return fixedMutation(
    'fail',
    'fail',
    ['--outcome', outcome, ...(reasonCode ? ['--reason-code', reasonCode] : [])],
    { outcome, reasonCode, workRunId: state.receipt.workRunId },
    [outcome],
  )
}

function fixedMutation(operationKey, bridgeCommand, bridgeArguments, input, expectedStatuses) {
  return { bridgeArguments, bridgeCommand, expectedStatuses, input, operationKey }
}

async function writeManifest(tokens) {
  const options = parseOptions(tokens, ['cwd', 'run-key', 'spec'])
  const { state, stateFile } = await loadState(options)
  if (!state.receipt) throw new ClientError('workflow_not_begun', 'Run key has no completed Bridge begin receipt.')
  const specPath = requireBoundedText(options.spec, 4096, 'manifest spec path')
  const source = await readBoundedRegularFile(specPath, {
    errorCode: 'invalid_manifest_spec',
    maximumBytes: MAXIMUM_SPEC_BYTES,
    message: 'Manifest spec must be a regular non-symlink file no larger than 1 MiB.',
  })
  let spec
  try {
    spec = JSON.parse(source)
  } catch {
    throw new ClientError('invalid_manifest_spec', 'Manifest spec is not valid JSON.')
  }
  const manifest = createManifest(spec, state)
  await ensureSafeDirectory(dirname(state.receipt.manifestPath))
  await writeJsonAtomic(state.receipt.manifestPath, manifest)
  writeResult({
    artifactCount: manifest.artifacts.length,
    manifestPath: state.receipt.manifestPath,
    ok: true,
    runKey: state.runKey,
    stateFile,
    status: manifest.status,
    type: 'porta-workflow-client-manifest',
  })
}

function createManifest(value, state) {
  const spec = requireExactRecord(value, ['artifacts', 'error', 'logs', 'project', 'runner', 'status'], ['error', 'logs', 'runner'], 'manifest spec')
  const statusValue = String(spec.status ?? '')
  if (!['building', 'failed', 'ready', 'unsupported'].includes(statusValue)) {
    throw new ClientError('invalid_manifest_spec', 'Manifest status is invalid.')
  }
  if (!Array.isArray(spec.artifacts) || spec.artifacts.length > 64 || spec.artifacts.some((entry) => !isRecord(entry))) {
    throw new ClientError('invalid_manifest_spec', 'Manifest artifacts must be a bounded object array.')
  }
  if (statusValue === 'ready' && spec.artifacts.length === 0) {
    throw new ClientError('invalid_manifest_spec', 'Ready manifest requires at least one artifact.')
  }
  const project = requireExactRecord(spec.project, ['gitBranch', 'gitCommit', 'name'], ['gitBranch', 'gitCommit'], 'manifest project')
  const name = requireBoundedText(project.name, 240, 'project name')
  const gitBranch = optionalBoundedText(project.gitBranch, 512, 'git branch')
  const gitCommit = optionalBoundedText(project.gitCommit, 160, 'git commit')
  const logs = spec.logs === undefined
    ? {}
    : requireExactRecord(spec.logs, ['summary'], ['summary'], 'manifest logs')
  const summary = optionalBoundedText(logs.summary, 4096, 'log summary')
  const error = optionalBoundedText(spec.error, 4096, 'manifest error')
  if (['failed', 'unsupported'].includes(statusValue) && !error) {
    throw new ClientError('invalid_manifest_spec', `${statusValue} manifest requires an error.`)
  }
  if (!['failed', 'unsupported'].includes(statusValue) && error) {
    throw new ClientError('invalid_manifest_spec', `${statusValue} manifest must not contain an error.`)
  }
  const runner = spec.runner === undefined ? undefined : normalizeRunner(spec.runner)
  return {
    artifacts: spec.artifacts,
    ...(error ? { error } : {}),
    logs: {
      remotePath: state.receipt.logPath,
      ...(summary ? { summary } : {}),
    },
    project: {
      cwd: state.cwd,
      ...(gitBranch ? { gitBranch } : {}),
      ...(gitCommit ? { gitCommit } : {}),
      name,
    },
    requestId: state.receipt.requestId,
    ...(runner ? { runner } : {}),
    schemaVersion: 2,
    status: statusValue,
    traceId: state.receipt.traceId,
  }
}

function normalizeRunner(value) {
  const runner = requireExactRecord(value, ['finishedAt', 'hostId', 'startedAt', 'type'], ['finishedAt', 'hostId', 'startedAt'], 'manifest runner')
  return {
    ...(runner.finishedAt ? { finishedAt: requireIsoDateTime(runner.finishedAt, 'runner finishedAt') } : {}),
    ...(runner.hostId ? { hostId: requireBoundedText(runner.hostId, 256, 'runner host id') } : {}),
    ...(runner.startedAt ? { startedAt: requireIsoDateTime(runner.startedAt, 'runner startedAt') } : {}),
    type: requireBoundedText(runner.type, 160, 'runner type'),
  }
}

async function readScenePackReadinessSpec(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new ClientError(
      'invalid_scene_pack_readiness_spec',
      'Scene Pack readiness spec path must be non-empty bounded text.',
    )
  }
  const specPath = value.trim()
  const source = await readBoundedRegularFile(specPath, {
    errorCode: 'invalid_scene_pack_readiness_spec',
    maximumBytes: MAXIMUM_SCENE_PACK_READINESS_SPEC_BYTES,
    message: 'Scene Pack readiness spec must be a regular non-symlink file no larger than 24 KiB.',
  })
  let spec
  try {
    spec = JSON.parse(source)
  } catch {
    throw new ClientError(
      'invalid_scene_pack_readiness_spec',
      'Scene Pack readiness spec is not valid JSON.',
    )
  }
  return normalizeScenePackReadinessObservation(
    spec,
    'invalid_scene_pack_readiness_spec',
    'Scene Pack readiness spec is invalid.',
  )
}

async function readBoundedRegularFile(path, {
  errorCode,
  maximumBytes,
  message,
}) {
  const fail = () => {
    throw new ClientError(errorCode, message)
  }
  const maximumSize = BigInt(maximumBytes)
  const beforeOpen = await lstat(path, { bigint: true }).catch(fail)
  if (
    !beforeOpen?.isFile() ||
    beforeOpen.size < 1n ||
    beforeOpen.size > maximumSize
  ) fail()

  let handle
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number'
      ? fsConstants.O_NOFOLLOW
      : 0
    handle = await open(path, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino ||
      opened.size < 1n ||
      opened.size > maximumSize
    ) fail()

    const buffer = Buffer.alloc(maximumBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset < 1 || offset > maximumBytes) fail()
    return buffer.subarray(0, offset).toString('utf8')
  } catch (error) {
    if (error instanceof ClientError) throw error
    fail()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function normalizeScenePackReadinessObservation(value, errorCode, errorMessage) {
  const fail = () => {
    throw new ClientError(errorCode, errorMessage)
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== scenePackReadinessFields.length ||
    Object.keys(value).some((key) => !scenePackReadinessFields.includes(key))
  ) fail()
  if (
    typeof value.catalogId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.catalogId) ||
    typeof value.catalogFingerprint !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.catalogFingerprint) ||
    !providers.has(value.provider)
  ) fail()
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length < 1 ||
    value.capabilities.length > scenePackCapabilityOrder.length ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    value.capabilities.some((capability) => !scenePackCapabilityOrder.includes(capability))
  ) fail()
  if (
    !Array.isArray(value.installedSkills) ||
    value.installedSkills.length < 1 ||
    value.installedSkills.length > 32
  ) fail()
  const installedSkills = value.installedSkills.map((skill) => {
    if (
      !isRecord(skill) ||
      Object.keys(skill).length !== 2 ||
      !Object.hasOwn(skill, 'id') ||
      !Object.hasOwn(skill, 'path') ||
      typeof skill.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(skill.id) ||
      !isScenePackRelativePath(skill.path)
    ) fail()
    return { id: skill.id, path: skill.path }
  }).sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path))
  if (
    new Set(installedSkills.map((skill) => skill.id)).size !== installedSkills.length ||
    new Set(installedSkills.map((skill) => skill.path)).size !== installedSkills.length
  ) fail()
  if (
    !isRecord(value.release) ||
    Object.keys(value.release).length !== 3 ||
    !Object.hasOwn(value.release, 'commitSha') ||
    !Object.hasOwn(value.release, 'tag') ||
    !Object.hasOwn(value.release, 'version') ||
    typeof value.release.commitSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.release.commitSha) ||
    typeof value.release.tag !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value.release.tag) ||
    typeof value.release.version !== 'string' ||
    !strictSemverPattern.test(value.release.version)
  ) fail()
  const normalized = {
    capabilities: scenePackCapabilityOrder.filter((capability) =>
      value.capabilities.includes(capability)),
    catalogFingerprint: value.catalogFingerprint,
    catalogId: value.catalogId,
    installedSkills,
    provider: value.provider,
    providerDiscovery: value.providerDiscovery,
    readiness: value.readiness,
    release: {
      commitSha: value.release.commitSha,
      tag: value.release.tag,
      version: value.release.version,
    },
    reloadObservation: value.reloadObservation,
  }
  if (!isCoherentScenePackReadiness(normalized)) fail()
  return normalized
}

function isCoherentScenePackReadiness(value) {
  if (value.readiness === 'ready') {
    return value.providerDiscovery === 'observed' &&
      (value.reloadObservation === 'completed' || value.reloadObservation === 'not-required')
  }
  if (value.readiness === 'reload-required') {
    return value.providerDiscovery === 'observed' && value.reloadObservation === 'required'
  }
  return value.readiness === 'unavailable' &&
    value.providerDiscovery === 'missing' &&
    value.reloadObservation === 'not-required'
}

function isScenePackRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\')
  ) return false
  return value.split('/').every((segment) =>
    /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..')
}

function scenePackReadinessIdempotencyKey(observation) {
  return `porta-skill-scene-readiness:${hashJson(observation)}`
}

async function readScenePackReadinessCapabilities() {
  const traceId = `porta-skill-scene-readiness-capabilities:${randomUUID()}`
  const value = await runBridge([
    'workflow',
    'capabilities',
    '--trace-id', traceId,
    '--json',
  ])
  const compatible =
    isRecord(value) &&
    value.ok === true &&
    value.type === 'workflow-capabilities' &&
    value.protocolVersion === 1 &&
    value.workflowProtocolVersion === LEGACY_WORKFLOW_PROTOCOL_VERSION &&
    value.traceId === traceId &&
    isRuntimeAtLeast(value.runtimeVersion, MINIMUM_SCENE_PACK_READINESS_RUNTIME) &&
    Array.isArray(value.commands) &&
    value.commands.includes('scene-pack-readiness-observe')
  if (!compatible) {
    throw new ClientError(
      'workflow_incompatible',
      'Agent Bridge Runtime 1.16.1 or newer with Scene Pack readiness support is required.',
    )
  }
  return value
}

function validateScenePackReadinessReceipt(value, observation, traceId) {
  const receiptFields = [
    ...scenePackReadinessFields,
    'cursor',
    'idempotent',
    'observedAt',
    'ok',
    'protocolVersion',
    'traceId',
    'type',
    'workflowProtocolVersion',
  ]
  if (
    !isRecord(value) ||
    Object.keys(value).length !== receiptFields.length ||
    Object.keys(value).some((key) => !receiptFields.includes(key)) ||
    typeof value.cursor !== 'string' ||
    !/^\d{1,40}$/.test(value.cursor) ||
    BigInt(value.cursor) < 1n ||
    typeof value.idempotent !== 'boolean' ||
    !isIsoDateTime(value.observedAt) ||
    value.ok !== true ||
    value.protocolVersion !== 1 ||
    value.traceId !== traceId ||
    value.type !== 'workflow-scene-pack-readiness-receipt' ||
    value.workflowProtocolVersion !== LEGACY_WORKFLOW_PROTOCOL_VERSION
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an invalid Scene Pack readiness receipt.',
    )
  }
  const receiptObservation = normalizeScenePackReadinessObservation(
    Object.fromEntries(scenePackReadinessFields.map((key) => [key, value[key]])),
    'malformed_bridge_receipt',
    'Agent Bridge returned an invalid Scene Pack readiness receipt.',
  )
  if (JSON.stringify(receiptObservation) !== JSON.stringify(observation)) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge Scene Pack readiness receipt did not echo the exact observation.',
    )
  }
  return {
    ...receiptObservation,
    cursor: String(value.cursor),
    idempotent: value.idempotent,
    observedAt: value.observedAt,
    ok: true,
    protocolVersion: 1,
    traceId,
    type: 'workflow-scene-pack-readiness-receipt',
    workflowProtocolVersion: LEGACY_WORKFLOW_PROTOCOL_VERSION,
  }
}

async function readCapabilities(workflowProtocolVersion = LEGACY_WORKFLOW_PROTOCOL_VERSION) {
  const traceId = `porta-skill-capabilities:${randomUUID()}`
  const value = await runBridge([
    'workflow',
    'capabilities',
    ...(workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
      ? ['--workflow-protocol-version', String(workflowProtocolVersion)]
      : []),
    '--trace-id', traceId,
    '--json',
  ])
  const commonValid =
    isRecord(value) &&
    value.ok === true &&
    value.type === 'workflow-capabilities' &&
    value.protocolVersion === 1 &&
    value.workflowProtocolVersion === workflowProtocolVersion &&
    value.traceId === traceId &&
    Array.isArray(value.commands)
  const contractValid = workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
    ? commonValid &&
      value.eventContractVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION &&
      isRuntimeAtLeast(value.runtimeVersion, MINIMUM_RELEASE_WORKFLOW_RUNTIME) &&
      [
        'attention',
        'begin',
        'cancel',
        'candidate-register',
        'fail',
        'preview-ready',
        'preview-start',
        'progress',
      ].every((command) => value.commands.includes(command)) &&
      Array.isArray(value.capabilities) &&
      ['static-html-release', 'porta.workflow.event-loop.v2']
        .every((capability) => value.capabilities.includes(capability))
    : commonValid &&
      isRuntimeAtLeast(value.runtimeVersion, MINIMUM_LEGACY_WORKFLOW_RUNTIME) &&
      [
        'attention',
        'begin',
        'fail',
        'preview-ready',
        'preview-start',
        'progress',
        'stop',
      ].every((command) => value.commands.includes(command)) &&
      Array.isArray(value.artifactKinds) &&
      ['web', 'android-apk'].every((kind) => value.artifactKinds.includes(kind))
  if (!contractValid) {
    throw new ClientError(
      'workflow_incompatible',
      `Agent Bridge does not expose the required Workflow v${workflowProtocolVersion} contract.`,
    )
  }
  if (value.platformSupported !== true) {
    throw new ClientError(
      'unsupported_platform',
      workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
        ? 'Agent Bridge reports Static HTML Product Release unsupported on this platform.'
        : 'Agent Bridge reports Product Preview unsupported on this platform.',
    )
  }
  return value
}

async function runBridge(arguments_) {
  const bridge = process.env.PORTA_BRIDGE_BIN?.trim() || 'porta-bridge'
  try {
    const { stdout } = await execFile(bridge, arguments_, {
      encoding: 'utf8',
      maxBuffer: MAXIMUM_BRIDGE_OUTPUT_BYTES,
      timeout: 30_000,
    })
    return parseBridgeJson(stdout)
  } catch (error) {
    const structured = parseOptionalBridgeJson(error?.stderr) ?? parseOptionalBridgeJson(error?.stdout)
    if (structured) {
      throw new ClientError(
        typeof structured.code === 'string' ? structured.code : 'bridge_failed',
        typeof structured.message === 'string' ? structured.message : 'Agent Bridge rejected the Workflow command.',
        { bridge: structured },
      )
    }
    if (error?.code === 'ENOENT') {
      throw new ClientError('bridge_missing', 'porta-bridge is not available in PATH.')
    }
    if (error?.killed || error?.code === 'ETIMEDOUT') {
      throw new ClientError('bridge_timeout', 'Agent Bridge command timed out; retry with the same Run and operation keys.')
    }
    throw new ClientError('bridge_failed', 'Agent Bridge command failed without a structured receipt.')
  }
}

function parseBridgeJson(source) {
  const parsed = parseOptionalBridgeJson(source)
  if (!parsed) throw new ClientError('malformed_bridge_output', 'Agent Bridge did not return one JSON object.')
  return parsed
}

function parseOptionalBridgeJson(source) {
  if (typeof source !== 'string' || !source.trim()) return undefined
  try {
    const value = JSON.parse(source.trim())
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function validateBeginReceipt(value, state) {
  if (!isRecord(value)) {
    throw new ClientError('malformed_bridge_receipt', 'Agent Bridge returned an invalid begin receipt.')
  }
  const workflowProtocolVersion = workflowProtocolVersionForState(state)
  const isRelease = workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
  const receipt = requireExactRecord(value, [
    'created',
    'eventContractVersion',
    'logPath',
    'manifestPath',
    'milestoneCursor',
    'ok',
    'protocolVersion',
    'provider',
    'publishIntent',
    'requestId',
    'skillId',
    'skillVersion',
    'sourceSequence',
    'status',
    'traceId',
    'type',
    'workflowProtocolVersion',
    'workRunId',
  ], isRelease ? [] : ['provider', 'publishIntent'], 'begin receipt')
  const requestId = requireUuid(receipt.requestId, 'request id')
  const expectedManifestPath = join(state.cwd, '.porta', 'previews', `${requestId}.json`)
  const expectedLogPath = join(state.cwd, '.porta', 'previews', `${requestId}.log`)
  if (
    receipt.ok !== true ||
    receipt.type !== 'workflow-begin' ||
    receipt.protocolVersion !== 1 ||
    receipt.workflowProtocolVersion !== workflowProtocolVersion ||
    receipt.eventContractVersion !== workflowProtocolVersion ||
    receipt.skillId !== SKILL_ID ||
    receipt.skillVersion !== state.skillVersion ||
    receipt.status !== (isRelease ? 'implementing' : 'active') ||
    (!isRelease && (receipt.provider !== undefined || receipt.publishIntent !== undefined)) ||
    receipt.manifestPath !== expectedManifestPath ||
    receipt.logPath !== expectedLogPath ||
    !workflowRunPattern.test(String(receipt.workRunId ?? '')) ||
    !Number.isSafeInteger(receipt.sourceSequence) ||
    receipt.sourceSequence < 1
  ) {
    throw new ClientError('malformed_bridge_receipt', 'Agent Bridge returned an invalid begin receipt.')
  }
  if (isRelease) {
    if (
      receipt.provider !== state.provider ||
      !isWorkflowV2PublishIntent(receipt.publishIntent)
    ) {
      throw new ClientError(
        'malformed_bridge_receipt',
        'Agent Bridge returned an invalid Workflow v2 Publish Intent receipt.',
      )
    }
  }
  requireUuid(receipt.traceId, 'trace id')
  requirePositiveCursor(receipt.milestoneCursor, 'milestone cursor')
  if (typeof receipt.created !== 'boolean') {
    throw new ClientError('malformed_bridge_receipt', 'Agent Bridge begin receipt has an invalid created flag.')
  }
  return receipt
}

function validateMutationReceipt(value, beginReceipt, mutation) {
  const workflowProtocolVersion = beginReceipt.workflowProtocolVersion
  const receipt = requireExactRecord(value, [
    'command',
    'idempotent',
    'milestoneCursor',
    'ok',
    'protocolVersion',
    'sourceSequence',
    'status',
    'traceId',
    'type',
    'workflowProtocolVersion',
    'workRunId',
  ], mutation.bridgeCommand === 'progress' || mutation.milestoneOptional
    ? ['milestoneCursor']
    : [], 'workflow receipt')
  if (
    receipt.ok !== true ||
    receipt.type !== 'workflow-receipt' ||
    receipt.protocolVersion !== 1 ||
    receipt.workflowProtocolVersion !== workflowProtocolVersion ||
    receipt.command !== mutation.bridgeCommand ||
    receipt.workRunId !== beginReceipt.workRunId ||
    receipt.traceId !== beginReceipt.traceId ||
    !mutation.expectedStatuses.includes(receipt.status) ||
    typeof receipt.idempotent !== 'boolean' ||
    !Number.isSafeInteger(receipt.sourceSequence) ||
    receipt.sourceSequence < 1
  ) {
    throw new ClientError('malformed_bridge_receipt', 'Agent Bridge returned an invalid Workflow receipt.')
  }
  if (receipt.milestoneCursor !== undefined) requirePositiveCursor(receipt.milestoneCursor, 'milestone cursor')
  return receipt
}

function validateReleaseStatusBatch(value, state, traceId) {
  const batch = requireExactRecord(value, [
    'cursor',
    'events',
    'protocolVersion',
    'runs',
    'traceId',
    'type',
    'workflowProtocolVersion',
  ], [], 'Workflow v2 pull batch')
  if (
    batch.protocolVersion !== 1 ||
    batch.workflowProtocolVersion !== RELEASE_WORKFLOW_PROTOCOL_VERSION ||
    batch.type !== 'workflow-pull' ||
    batch.traceId !== traceId ||
    !isNonNegativeCursor(batch.cursor) ||
    !Array.isArray(batch.events) ||
    !Array.isArray(batch.runs)
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an invalid Workflow v2 pull batch.',
    )
  }
  const matches = batch.runs.filter((run) =>
    isRecord(run) && run.workRunId === state.receipt.workRunId,
  )
  if (matches.length !== 1) {
    throw new ClientError(
      'work_run_not_found',
      'Agent Bridge did not return the exact Workflow v2 WorkRun.',
    )
  }
  return normalizeReleaseStatusRun(matches[0], state)
}

function normalizeReleaseStatusRun(value, state) {
  const statuses = new Set([
    'canceled',
    'failed',
    'freezing',
    'implementing',
    'preview-ready',
    'ready',
    'transferring',
    'verifying',
  ])
  if (
    value.workflowProtocolVersion !== RELEASE_WORKFLOW_PROTOCOL_VERSION ||
    value.eventContractVersion !== RELEASE_WORKFLOW_PROTOCOL_VERSION ||
    value.workRunId !== state.receipt.workRunId ||
    value.requestId !== state.receipt.requestId ||
    value.traceId !== state.receipt.traceId ||
    value.skillId !== SKILL_ID ||
    value.skillVersion !== state.skillVersion ||
    value.provider !== state.provider ||
    value.cwd !== state.cwd ||
    value.manifestPath !== state.receipt.manifestPath ||
    value.logPath !== state.receipt.logPath ||
    JSON.stringify(value.publishIntent) !== JSON.stringify(state.receipt.publishIntent) ||
    typeof value.attentionRequired !== 'boolean' ||
    !Number.isSafeInteger(value.sourceSequence) ||
    value.sourceSequence < state.receipt.sourceSequence ||
    !statuses.has(value.status) ||
    !isIsoDateTime(value.updatedAt)
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an invalid Workflow v2 WorkRun snapshot.',
    )
  }
  const candidate = value.candidate === undefined
    ? undefined
    : normalizeReleaseCandidateSummary(value.candidate)
  const release = value.release === undefined
    ? undefined
    : normalizeReleaseSummary(value.release)
  const progress = value.progress === undefined
    ? undefined
    : normalizeReleaseProgress(value.progress)
  const terminalAt = value.terminalAt === undefined
    ? undefined
    : requireIsoDateTime(value.terminalAt, 'Workflow terminal time')
  const terminal = ['canceled', 'failed', 'ready'].includes(value.status)
  if (
    (['freezing', 'transferring', 'verifying', 'ready'].includes(value.status) && !candidate) ||
    (['transferring', 'verifying', 'ready'].includes(value.status) && !release) ||
    (value.status === 'ready' && !release?.revisionRef) ||
    (terminal !== Boolean(terminalAt))
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an inconsistent Workflow v2 WorkRun snapshot.',
    )
  }
  return {
    attentionRequired: value.attentionRequired,
    ...(candidate ? { candidate } : {}),
    ...(progress ? { progress } : {}),
    ...(release ? { release } : {}),
    sourceSequence: value.sourceSequence,
    status: value.status,
    ...(terminalAt ? { terminalAt } : {}),
    updatedAt: value.updatedAt,
    workRunId: value.workRunId,
  }
}

function normalizeReleaseCandidateSummary(value) {
  const candidate = requireExactRecord(value, [
    'candidateDigest',
    'candidateRef',
    'registeredAt',
    'replacedCandidateRef',
  ], ['replacedCandidateRef'], 'Workflow v2 candidate summary')
  if (
    !/^[a-f0-9]{64}$/.test(String(candidate.candidateDigest ?? '')) ||
    !isWorkflowOpaqueRef(candidate.candidateRef) ||
    !isIsoDateTime(candidate.registeredAt) ||
    (candidate.replacedCandidateRef !== undefined && (
      !isWorkflowOpaqueRef(candidate.replacedCandidateRef) ||
      candidate.replacedCandidateRef === candidate.candidateRef
    ))
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an invalid Workflow v2 candidate summary.',
    )
  }
  return candidate
}

function normalizeReleaseSummary(value) {
  const release = requireExactRecord(value, [
    'attemptRef',
    'productRef',
    'releaseRef',
    'revisionRef',
  ], ['revisionRef'], 'Workflow v2 release summary')
  if (
    !isWorkflowOpaqueRef(release.attemptRef) ||
    !isWorkflowOpaqueRef(release.productRef) ||
    !isWorkflowOpaqueRef(release.releaseRef) ||
    (release.revisionRef !== undefined && !isWorkflowOpaqueRef(release.revisionRef))
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an invalid Workflow v2 release summary.',
    )
  }
  return release
}

function normalizeReleaseProgress(value) {
  const progress = requireExactRecord(value, [
    'percent',
    'phase',
    'summary',
    'updatedAt',
  ], ['percent', 'summary'], 'Workflow v2 progress')
  if (
    !releaseProgressPhases.has(progress.phase) ||
    (progress.percent !== undefined && (
      !Number.isSafeInteger(progress.percent) ||
      progress.percent < 0 ||
      progress.percent > 100
    )) ||
    (progress.summary !== undefined && (
      typeof progress.summary !== 'string' ||
      progress.summary.length < 1 ||
      progress.summary.length > 240
    )) ||
    !isIsoDateTime(progress.updatedAt)
  ) {
    throw new ClientError(
      'malformed_bridge_receipt',
      'Agent Bridge returned an invalid Workflow v2 progress snapshot.',
    )
  }
  return progress
}

async function loadState(options) {
  const runKey = requireRunKey(options['run-key'])
  const cwd = await resolveProjectCwd(options.cwd)
  await rejectExistingUnsafeStateDirectories(cwd)
  const stateFile = stateFilePath(cwd, runKey)
  const state = await readOptionalState(stateFile)
  if (!state) throw new ClientError('client_state_missing', 'No client state exists for this Run key and cwd.')
  if (state.cwd !== cwd || state.runKey !== runKey) {
    throw new ClientError('client_state_mismatch', 'Client state identity does not match this request.')
  }
  return { state, stateFile }
}

async function resolveProjectCwd(value) {
  const candidate = resolve(String(value || process.cwd()))
  const actual = await realpath(candidate).catch(() => undefined)
  const info = actual ? await stat(actual).catch(() => undefined) : undefined
  if (!actual || !info?.isDirectory()) throw new ClientError('invalid_cwd', 'Workflow cwd must be an existing directory.')
  return actual
}

async function ensureStateFile(cwd, runKey) {
  const portaDirectory = join(cwd, '.porta')
  const clientDirectory = join(portaDirectory, 'workflow-client')
  await ensureSafeDirectory(portaDirectory)
  await ensureSafeDirectory(clientDirectory)
  await chmod(clientDirectory, 0o700).catch(() => undefined)
  return join(clientDirectory, `${runKey}.json`)
}

function stateFilePath(cwd, runKey) {
  return join(cwd, '.porta', 'workflow-client', `${runKey}.json`)
}

async function rejectSymlink(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ClientError('unsafe_state_directory', `Refusing unsafe Porta state directory: ${path}`)
  }
}

async function ensureSafeDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true })
  await rejectSymlink(path)
}

async function rejectExistingUnsafeStateDirectories(cwd) {
  for (const path of [join(cwd, '.porta'), join(cwd, '.porta', 'workflow-client')]) {
    const info = await lstat(path).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new ClientError('unsafe_state_directory', `Refusing unsafe Porta state directory: ${path}`)
    }
  }
}

async function readOptionalState(path) {
  const source = await readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (source === undefined) return undefined
  if (Buffer.byteLength(source) > 256 * 1024) throw new ClientError('invalid_client_state', 'Client state is too large.')
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new ClientError('invalid_client_state', 'Client state is not valid JSON.')
  }
  return validateState(value)
}

function validateState(value) {
  const state = requireExactRecord(value, [
    'beginIdempotencyKey',
    'cwd',
    'latestReceipt',
    'operations',
    'provider',
    'providerSessionId',
    'receipt',
    'runKey',
    'skillId',
    'skillVersion',
    'version',
    'workflowProtocolVersion',
  ], [
    'latestReceipt',
    'providerSessionId',
    'receipt',
    'workflowProtocolVersion',
  ], 'client state')
  const workflowProtocolVersion = workflowProtocolVersionForState(state)
  const skillVersionValid = state.skillVersion === SKILL_VERSION ||
    RESUMABLE_PRIOR_SKILL_VERSIONS.has(state.skillVersion) ||
    (
      workflowProtocolVersion === LEGACY_WORKFLOW_PROTOCOL_VERSION &&
      RESUMABLE_LEGACY_SKILL_VERSIONS.has(state.skillVersion)
    )
  if (
    state.version !== CLIENT_STATE_VERSION ||
    state.skillId !== SKILL_ID ||
    !skillVersionValid ||
    !runKeyPattern.test(String(state.runKey ?? '')) ||
    !providers.has(state.provider) ||
    typeof state.cwd !== 'string' ||
    !/^porta-skill-begin:[0-9a-f-]{36}$/.test(String(state.beginIdempotencyKey ?? '')) ||
    !isRecord(state.operations) ||
    Object.keys(state.operations).length > MAXIMUM_OPERATIONS
  ) {
    throw new ClientError('invalid_client_state', 'Client state failed validation.')
  }
  if (state.providerSessionId !== undefined) requireBoundedText(state.providerSessionId, 256, 'provider session id')
  const completedReceipts = []
  const allowedOperationCommands = workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION
    ? new Set([
      'attention',
      'cancel',
      'candidate-register',
      'fail',
      'preview-ready',
      'preview-start',
      'progress',
    ])
    : new Set(['attention', 'fail', 'preview-ready', 'preview-start', 'progress', 'stop'])
  for (const [operationKey, operationValue] of Object.entries(state.operations)) {
    requireOperationKey(operationKey)
    const operation = requireExactRecord(operationValue, ['command', 'createdAt', 'idempotencyKey', 'inputHash', 'receipt'], ['receipt'], 'client operation')
    if (
      typeof operation.command !== 'string' ||
      !isIsoDateTime(operation.createdAt) ||
      !/^porta-skill-op:[a-f0-9]{64}$/.test(String(operation.idempotencyKey ?? '')) ||
      !/^[a-f0-9]{64}$/.test(String(operation.inputHash ?? '')) ||
      !allowedOperationCommands.has(operation.command) ||
      (operation.receipt !== undefined && !isRecord(operation.receipt))
    ) throw new ClientError('invalid_client_state', 'Client operation failed validation.')
  }
  const beginReceipt = state.receipt === undefined ? undefined : validateBeginReceipt(state.receipt, state)
  for (const operation of Object.values(state.operations)) {
    if (!operation.receipt) continue
    if (!beginReceipt) throw new ClientError('invalid_client_state', 'Completed operation has no begin receipt.')
    const receipt = validateMutationReceipt(operation.receipt, beginReceipt, {
      bridgeCommand: operation.command,
      expectedStatuses: storedExpectedStatuses(operation.command, workflowProtocolVersion),
      milestoneOptional: storedMilestoneOptional(operation.command, workflowProtocolVersion),
    })
    completedReceipts.push(receipt)
  }
  if (state.latestReceipt !== undefined) {
    if (
      !isRecord(state.latestReceipt) ||
      !completedReceipts.some((receipt) => JSON.stringify(receipt) === JSON.stringify(state.latestReceipt))
    ) throw new ClientError('invalid_client_state', 'Latest receipt does not match a completed operation.')
  }
  return state
}

function storedExpectedStatuses(command, workflowProtocolVersion) {
  if (workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION) {
    if (command === 'progress' || command === 'attention') {
      return ['freezing', 'implementing', 'preview-ready', 'transferring', 'verifying']
    }
    if (command === 'preview-start') return ['implementing']
    if (command === 'preview-ready') return ['preview-ready']
    if (command === 'candidate-register') return ['freezing']
    if (command === 'cancel') return ['canceled', 'ready']
    if (command === 'fail') return ['failed']
    throw new ClientError('invalid_client_state', 'Stored Workflow v2 operation command is invalid.')
  }
  if (command === 'progress' || command === 'attention') return ['active', 'building']
  if (command === 'preview-start') return ['building']
  if (command === 'preview-ready') return ['ready']
  if (command === 'stop') return ['stopped']
  if (command === 'fail') return ['failed', 'unsupported']
  throw new ClientError('invalid_client_state', 'Stored operation command is invalid.')
}

function storedMilestoneOptional(command, workflowProtocolVersion) {
  return workflowProtocolVersion === RELEASE_WORKFLOW_PROTOCOL_VERSION &&
    ['attention', 'cancel'].includes(command)
}

function workflowProtocolVersionForState(state) {
  const value = state.workflowProtocolVersion ?? LEGACY_WORKFLOW_PROTOCOL_VERSION
  if (
    value !== LEGACY_WORKFLOW_PROTOCOL_VERSION &&
    value !== RELEASE_WORKFLOW_PROTOCOL_VERSION
  ) {
    throw new ClientError('invalid_client_state', 'Client state Workflow protocol version is invalid.')
  }
  return value
}

async function writeState(path, state) {
  validateState(state)
  await writeJsonAtomic(path, state)
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => undefined)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function clientReceiptResult(command, stateFile, receipt, cached) {
  return {
    cached,
    command,
    ok: true,
    receipt,
    stateFile,
    type: 'porta-workflow-client-receipt',
  }
}

function operationIdempotencyKey(runKey, operationKey) {
  return `porta-skill-op:${createHash('sha256').update(`${runKey}\0${operationKey}`).digest('hex')}`
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function parseOptions(tokens, allowedKeys) {
  const allowed = new Set(allowedKeys)
  const options = {}
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index]
    const value = tokens[index + 1]
    if (!token?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ClientError('invalid_arguments', 'Options must use --name value pairs.')
    }
    const key = token.slice(2)
    if (!allowed.has(key) || Object.hasOwn(options, key)) {
      throw new ClientError('invalid_arguments', `Unsupported or duplicate option: --${key}`)
    }
    options[key] = value
  }
  return options
}

function requireNoArguments(tokens) {
  if (tokens.length !== 0) throw new ClientError('invalid_arguments', 'Command does not accept arguments.')
}

function requireRunKey(value) {
  const normalized = String(value ?? '')
  if (!runKeyPattern.test(normalized)) throw new ClientError('invalid_run_key', 'Run key is invalid.')
  return normalized
}

function requireOperationKey(value) {
  const normalized = String(value ?? '')
  if (!operationKeyPattern.test(normalized)) throw new ClientError('invalid_operation_key', 'Operation key is invalid.')
  return normalized
}

function requireProvider(value) {
  const normalized = String(value ?? '')
  if (!providers.has(normalized)) throw new ClientError('invalid_provider', 'Provider must be codex, claude, or gemini.')
  return normalized
}

function requireWorkflowProtocolVersion(value) {
  if (value === undefined) return LEGACY_WORKFLOW_PROTOCOL_VERSION
  if (value !== '1' && value !== '2') {
    throw new ClientError('invalid_workflow_version', 'Workflow protocol version must be 1 or 2.')
  }
  return Number(value)
}

function requireWorkflowBoolean(value, label) {
  if (value === '0' || value === '1') return value
  throw new ClientError('invalid_arguments', `${label} must be 0 or 1.`)
}

function requireReasonCode(value) {
  const normalized = String(value ?? '')
  if (!reasonCodePattern.test(normalized)) throw new ClientError('invalid_reason_code', 'Reason code is invalid.')
  return normalized
}

function optionalPercent(value) {
  if (value === undefined) return undefined
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 100) {
    throw new ClientError('invalid_percent', 'Percent must be an integer from 0 through 100.')
  }
  return normalized
}

function requireBoundedText(value, maximum, label) {
  const normalized = optionalBoundedText(value, maximum, label)
  if (!normalized) throw new ClientError('invalid_arguments', `${label} is required.`)
  return normalized
}

function optionalBoundedText(value, maximum, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new ClientError('invalid_arguments', `${label} must be non-empty bounded text.`)
  }
  return value.trim()
}

function requireUuid(value, label) {
  const normalized = String(value ?? '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new ClientError('malformed_bridge_receipt', `Agent Bridge ${label} is invalid.`)
  }
  return normalized
}

function requirePositiveCursor(value, label) {
  if (!/^\d+$/.test(String(value ?? '')) || BigInt(value) < 1n) {
    throw new ClientError('malformed_bridge_receipt', `Agent Bridge ${label} is invalid.`)
  }
}

function isNonNegativeCursor(value) {
  return /^\d+$/.test(String(value ?? '')) && BigInt(value) >= 0n
}

function requireIsoDateTime(value, label) {
  const normalized = String(value ?? '')
  if (!isIsoDateTime(normalized)) throw new ClientError('invalid_arguments', `${label} must be an ISO date-time.`)
  return normalized
}

function isIsoDateTime(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
}

function isWorkflowV2PublishIntent(value) {
  return isRecord(value) &&
    Object.keys(value).length === 4 &&
    Object.hasOwn(value, 'issuedAt') &&
    Object.hasOwn(value, 'projectContextGeneration') &&
    Object.hasOwn(value, 'projectRef') &&
    Object.hasOwn(value, 'ref') &&
    isIsoDateTime(value.issuedAt) &&
    Number.isSafeInteger(value.projectContextGeneration) &&
    value.projectContextGeneration > 0 &&
    /^project_[A-Za-z0-9-]{4,152}$/.test(String(value.projectRef ?? '')) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(String(value.ref ?? ''))
}

function isWorkflowOpaqueRef(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value)
}

function isRuntimeAtLeast(value, minimum) {
  const left = semverPattern.exec(String(value ?? ''))
  const right = semverPattern.exec(minimum)
  if (!left || !right) return false
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference > 0
  }
  return true
}

function requireExactRecord(value, allowedKeys, optionalKeys, label) {
  if (!isRecord(value)) throw new ClientError('invalid_arguments', `${label} must be an object.`)
  const allowed = new Set(allowedKeys)
  const optional = new Set(optionalKeys)
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    allowedKeys.some((key) => !optional.has(key) && !Object.hasOwn(value, key))
  ) throw new ClientError('invalid_arguments', `${label} has an invalid field set.`)
  return value
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function writeError(error) {
  const normalized = error instanceof ClientError
    ? error
    : new ClientError('client_failed', 'Porta Workflow client failed unexpectedly.')
  process.stderr.write(`${JSON.stringify({
    code: normalized.code,
    ...(normalized.details ? { details: normalized.details } : {}),
    message: normalized.message,
    ok: false,
    type: 'porta-workflow-client-error',
  }, null, 2)}\n`)
}

main().catch((error) => {
  writeError(error)
  process.exitCode = 1
})
