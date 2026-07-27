#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
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
const EVENT_CONTRACT_VERSION = 1
const MINIMUM_WORKFLOW_RUNTIME = '1.9.0'
const SKILL_ID = 'porta-workflow'
const SKILL_VERSION = '0.1.1'
const MAXIMUM_BRIDGE_OUTPUT_BYTES = 1024 * 1024
const MAXIMUM_SPEC_BYTES = 1024 * 1024
const MAXIMUM_OPERATIONS = 256
const providers = new Set(['codex', 'claude', 'gemini'])
const progressPhases = new Set(['building', 'implementing', 'planning', 'testing', 'waiting'])
const terminalOutcomes = new Set(['failed', 'unsupported'])
const runKeyPattern = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const operationKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const reasonCodePattern = /^[a-z][a-z0-9._:-]{0,119}$/
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/
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
    requireNoArguments(tokens)
    const capabilities = await readCapabilities()
    writeResult({ capabilities, ok: true, type: 'porta-workflow-client-capabilities' })
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
  if (command === 'manifest') {
    await writeManifest(tokens)
    return
  }
  if (['attention', 'fail', 'preview-start', 'progress', 'ready', 'stop'].includes(command)) {
    await mutate(command, tokens)
    return
  }
  throw new ClientError('unsupported_command', `Unsupported Porta Workflow client command: ${command}`)
}

function helpText() {
  return `Porta Workflow client ${SKILL_VERSION}\n\n` +
    `Usage:\n` +
    `  porta-workflow.mjs capabilities\n` +
    `  porta-workflow.mjs new-run-key\n` +
    `  porta-workflow.mjs begin --run-key <key> --provider <codex|claude|gemini> [--provider-session-id <id>] [--cwd <path>]\n` +
    `  porta-workflow.mjs show --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs progress --run-key <key> --operation-key <key> --phase <phase> [--percent <0-100>] [--summary <text>] [--cwd <path>]\n` +
    `  porta-workflow.mjs preview-start --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs attention --run-key <key> --operation-key <key> --reason-code <code> [--cwd <path>]\n` +
    `  porta-workflow.mjs manifest --run-key <key> --spec <json-file> [--cwd <path>]\n` +
    `  porta-workflow.mjs ready --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs fail --run-key <key> --outcome <failed|unsupported> [--reason-code <code>] [--cwd <path>]\n` +
    `  porta-workflow.mjs stop --run-key <key> [--cwd <path>]\n` +
    `  porta-workflow.mjs version\n\n` +
    `Set PORTA_BRIDGE_BIN only when Porta installed the Bridge launcher outside PATH.\n`
}

async function begin(tokens) {
  const options = parseOptions(tokens, ['cwd', 'provider', 'provider-session-id', 'run-key'])
  const runKey = requireRunKey(options['run-key'])
  const provider = requireProvider(options.provider)
  const providerSessionId = optionalBoundedText(options['provider-session-id'], 256, 'provider session id')
  const cwd = await resolveProjectCwd(options.cwd)
  await readCapabilities()
  const stateFile = await ensureStateFile(cwd, runKey)
  const existing = await readOptionalState(stateFile)
  let state
  if (existing) {
    if (
      existing.cwd !== cwd ||
      existing.provider !== provider ||
      existing.providerSessionId !== providerSessionId ||
      existing.runKey !== runKey
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
    '--cwd', cwd,
    '--event-contract-version', String(EVENT_CONTRACT_VERSION),
    '--idempotency-key', state.beginIdempotencyKey,
    '--provider', provider,
    ...(providerSessionId ? ['--provider-session-id', providerSessionId] : []),
    '--skill-id', SKILL_ID,
    '--skill-version', SKILL_VERSION,
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
  const receipt = await runBridge([
    'workflow',
    mutation.bridgeCommand,
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
  if (command === 'fail') return [...common, 'outcome', 'reason-code']
  return common
}

function normalizeMutation(command, options, state) {
  if (command === 'progress') {
    const operationKey = requireOperationKey(options['operation-key'])
    const phase = String(options.phase ?? '')
    if (!progressPhases.has(phase)) throw new ClientError('invalid_phase', 'Progress phase is invalid.')
    const percent = optionalPercent(options.percent)
    const summary = optionalBoundedText(options.summary, 240, 'progress summary')
    return {
      bridgeArguments: [
        '--phase', phase,
        ...(percent === undefined ? [] : ['--percent', String(percent)]),
        ...(summary ? ['--summary', summary] : []),
      ],
      bridgeCommand: 'progress',
      expectedStatuses: ['active', 'building'],
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
      expectedStatuses: ['active', 'building'],
      input: { reasonCode, workRunId: state.receipt.workRunId },
      operationKey,
    }
  }
  if (command === 'preview-start') {
    return fixedMutation('preview-start', 'preview-start', [], { workRunId: state.receipt.workRunId }, ['building'])
  }
  if (command === 'ready') {
    return fixedMutation('preview-ready', 'preview-ready', [], { workRunId: state.receipt.workRunId }, ['ready'])
  }
  if (command === 'stop') {
    return fixedMutation('stop', 'stop', [], { workRunId: state.receipt.workRunId }, ['stopped'])
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
  const sourceStat = await stat(specPath).catch(() => undefined)
  if (!sourceStat?.isFile() || sourceStat.size > MAXIMUM_SPEC_BYTES) {
    throw new ClientError('invalid_manifest_spec', 'Manifest spec must be a file no larger than 1 MiB.')
  }
  let spec
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8'))
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

async function readCapabilities() {
  const traceId = `porta-skill-capabilities:${randomUUID()}`
  const value = await runBridge(['workflow', 'capabilities', '--trace-id', traceId, '--json'])
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.type !== 'workflow-capabilities' ||
    value.protocolVersion !== 1 ||
    value.workflowProtocolVersion !== 1 ||
    value.traceId !== traceId ||
    !isRuntimeAtLeast(value.runtimeVersion, MINIMUM_WORKFLOW_RUNTIME) ||
    !Array.isArray(value.commands) ||
    ['attention', 'begin', 'fail', 'preview-ready', 'preview-start', 'progress', 'stop'].some((command) => !value.commands.includes(command)) ||
    !Array.isArray(value.artifactKinds) ||
    !['web', 'android-apk'].every((kind) => value.artifactKinds.includes(kind))
  ) {
    throw new ClientError('workflow_incompatible', 'Agent Bridge does not expose the required Workflow v1 contract.')
  }
  if (value.platformSupported !== true) {
    throw new ClientError('unsupported_platform', 'Agent Bridge reports Product Preview unsupported on this platform.')
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
  const receipt = requireExactRecord(value, [
    'created',
    'eventContractVersion',
    'logPath',
    'manifestPath',
    'milestoneCursor',
    'ok',
    'protocolVersion',
    'requestId',
    'skillId',
    'skillVersion',
    'sourceSequence',
    'status',
    'traceId',
    'type',
    'workflowProtocolVersion',
    'workRunId',
  ], [], 'begin receipt')
  const requestId = requireUuid(receipt.requestId, 'request id')
  const expectedManifestPath = join(state.cwd, '.porta', 'previews', `${requestId}.json`)
  const expectedLogPath = join(state.cwd, '.porta', 'previews', `${requestId}.log`)
  if (
    receipt.ok !== true ||
    receipt.type !== 'workflow-begin' ||
    receipt.protocolVersion !== 1 ||
    receipt.workflowProtocolVersion !== 1 ||
    receipt.eventContractVersion !== EVENT_CONTRACT_VERSION ||
    receipt.skillId !== SKILL_ID ||
    receipt.skillVersion !== SKILL_VERSION ||
    receipt.status !== 'active' ||
    receipt.manifestPath !== expectedManifestPath ||
    receipt.logPath !== expectedLogPath ||
    !workflowRunPattern.test(String(receipt.workRunId ?? '')) ||
    !Number.isSafeInteger(receipt.sourceSequence) ||
    receipt.sourceSequence < 1
  ) {
    throw new ClientError('malformed_bridge_receipt', 'Agent Bridge returned an invalid begin receipt.')
  }
  requireUuid(receipt.traceId, 'trace id')
  requirePositiveCursor(receipt.milestoneCursor, 'milestone cursor')
  if (typeof receipt.created !== 'boolean') {
    throw new ClientError('malformed_bridge_receipt', 'Agent Bridge begin receipt has an invalid created flag.')
  }
  return receipt
}

function validateMutationReceipt(value, beginReceipt, mutation) {
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
  ], mutation.bridgeCommand === 'progress' ? ['milestoneCursor'] : [], 'workflow receipt')
  if (
    receipt.ok !== true ||
    receipt.type !== 'workflow-receipt' ||
    receipt.protocolVersion !== 1 ||
    receipt.workflowProtocolVersion !== 1 ||
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
  ], ['latestReceipt', 'providerSessionId', 'receipt'], 'client state')
  if (
    state.version !== CLIENT_STATE_VERSION ||
    state.skillId !== SKILL_ID ||
    state.skillVersion !== SKILL_VERSION ||
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
  for (const [operationKey, operationValue] of Object.entries(state.operations)) {
    requireOperationKey(operationKey)
    const operation = requireExactRecord(operationValue, ['command', 'createdAt', 'idempotencyKey', 'inputHash', 'receipt'], ['receipt'], 'client operation')
    if (
      typeof operation.command !== 'string' ||
      !isIsoDateTime(operation.createdAt) ||
      !/^porta-skill-op:[a-f0-9]{64}$/.test(String(operation.idempotencyKey ?? '')) ||
      !/^[a-f0-9]{64}$/.test(String(operation.inputHash ?? '')) ||
      !['attention', 'fail', 'preview-ready', 'preview-start', 'progress', 'stop'].includes(operation.command) ||
      (operation.receipt !== undefined && !isRecord(operation.receipt))
    ) throw new ClientError('invalid_client_state', 'Client operation failed validation.')
  }
  const beginReceipt = state.receipt === undefined ? undefined : validateBeginReceipt(state.receipt, state)
  for (const operation of Object.values(state.operations)) {
    if (!operation.receipt) continue
    if (!beginReceipt) throw new ClientError('invalid_client_state', 'Completed operation has no begin receipt.')
    const receipt = validateMutationReceipt(operation.receipt, beginReceipt, {
      bridgeCommand: operation.command,
      expectedStatuses: storedExpectedStatuses(operation.command),
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

function storedExpectedStatuses(command) {
  if (command === 'progress' || command === 'attention') return ['active', 'building']
  if (command === 'preview-start') return ['building']
  if (command === 'preview-ready') return ['ready']
  if (command === 'stop') return ['stopped']
  if (command === 'fail') return ['failed', 'unsupported']
  throw new ClientError('invalid_client_state', 'Stored operation command is invalid.')
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
