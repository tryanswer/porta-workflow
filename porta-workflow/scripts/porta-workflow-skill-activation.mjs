#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const SKILL_ID = 'porta-workflow'
const RELEASE_SUBDIRECTORY = 'porta-workflow'
const PROVIDERS = new Set(['claude', 'codex', 'gemini'])
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const MAX_FILES = 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TREE_BYTES = 16 * 1024 * 1024
const MAX_JOURNAL_BYTES = 16 * 1024
const TRANSACTION_VERSION = 2
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const commitPattern = /^[0-9a-f]{40}$/
const gitObjectPattern = /^[0-9a-f]{40,64}$/
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TRANSITION_INTENTS = new Set(['install', 'rollback', 'update'])

class ActivationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new ActivationError(code, message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireProvider(provider) {
  if (!PROVIDERS.has(provider)) fail('invalid_provider', 'Provider must be codex, claude, or gemini.')
  return provider
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) {
    fail('invalid_path', `${label} must be an absolute normalized path.`)
  }
  return value
}

function requireSafeTag(value) {
  if (typeof value !== 'string' || !tagPattern.test(value) || value.includes('..') || value.includes('//')) {
    fail('invalid_release', 'Expected tag is invalid.')
  }
  return value
}

function requireCommit(value) {
  if (typeof value !== 'string' || !commitPattern.test(value)) {
    fail('invalid_release', 'Expected commit must be a lowercase full SHA-1 commit id.')
  }
  return value
}

function requireRepositoryUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail('invalid_release', 'Expected repository URL is invalid.')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || !parsed.pathname.endsWith('.git')
    || parsed.pathname.endsWith('/.git')
    || parsed.toString() !== value
  ) {
    fail('invalid_release', 'Expected repository URL must be a canonical HTTPS Git URL.')
  }
  return value
}

function hasExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort(compareStrings)
  const expected = [...expectedKeys].sort(compareStrings)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function requireReleaseEvidence(value, label) {
  if (!isRecord(value) || !hasExactKeys(value, ['commitSha', 'tag'])) {
    fail('invalid_transition', `${label} release evidence is invalid.`)
  }
  return {
    commitSha: requireCommit(value.commitSha),
    tag: requireSafeTag(value.tag),
  }
}

function requireTransition(value) {
  if (!isRecord(value) || !TRANSITION_INTENTS.has(value.intent)) {
    fail('invalid_transition', 'Activation requires an explicit install, update, or rollback transition.')
  }
  if (value.intent === 'install') {
    if (!hasExactKeys(value, ['intent', 'to'])) {
      fail('invalid_transition', 'Install transition must declare only its exact target release.')
    }
    return { intent: value.intent, to: requireReleaseEvidence(value.to, 'Target') }
  }
  if (!hasExactKeys(value, ['from', 'intent', 'to'])) {
    fail('invalid_transition', 'Update and rollback transitions require exact source and target releases.')
  }
  const from = requireReleaseEvidence(value.from, 'Source')
  const to = requireReleaseEvidence(value.to, 'Target')
  if (from.commitSha === to.commitSha && from.tag === to.tag) {
    fail('invalid_transition', 'Transition source and target releases must differ.')
  }
  return { from, intent: value.intent, to }
}

export function resolvePortaWorkflowSkillDestination({ provider, providerHome }) {
  requireProvider(provider)
  requireAbsolutePath(providerHome, 'Provider home')
  return join(providerHome, 'skills', SKILL_ID)
}

function resolveDefaultProviderHome(provider, environment = process.env) {
  requireProvider(provider)
  if (provider === 'codex') {
    return requireAbsolutePath(environment.CODEX_HOME || join(homedir(), '.codex'), 'Codex home')
  }
  if (provider === 'claude') {
    return requireAbsolutePath(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'Claude config directory')
  }
  return requireAbsolutePath(join(homedir(), '.gemini'), 'Gemini home')
}

async function runGit(repository, args, options = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  Object.assign(environment, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: 'C',
    LC_ALL: 'C',
  })
  try {
    const result = await execFileAsync('git', [
      '--no-optional-locks',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.untrackedCache=false',
      '-C', repository,
      ...args,
    ], {
      encoding: options.encoding ?? 'utf8',
      env: environment,
      maxBuffer: options.maxBuffer ?? MAX_TREE_BYTES + (1024 * 1024),
      windowsHide: true,
    })
    return result.stdout
  } catch {
    fail('release_verification_failed', 'The immutable Git release could not be verified.')
  }
}

function normalizeGitPath(path) {
  const segments = typeof path === 'string' ? path.split('/') : []
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || segments.some((segment) => (
      !segment
      || segment === '.'
      || segment === '..'
      || !/^[A-Za-z0-9._-]+$/.test(segment)
    ))
    || Buffer.byteLength(path, 'utf8') > 1024
  ) {
    fail('release_verification_failed', 'The release contains an unsafe or non-portable Git path.')
  }
  return path
}

function buildDirectoryEntries(fileEntries) {
  const paths = new Set()
  for (const entry of fileEntries) {
    let parent = dirname(entry.path)
    while (parent !== '.') {
      paths.add(parent)
      parent = dirname(parent)
    }
  }
  return [...paths].sort(compareStrings).map((path) => ({ path, type: 'directory' }))
}

function hashTreeEntries(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) {
    if (entry.type === 'directory') {
      hash.update(`d\0${entry.path}\0`)
      continue
    }
    hash.update(`f\0${entry.path}\0${entry.mode}\0${entry.content.length}\0`)
    hash.update(entry.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function verifySourceRepository({ expectedRepositoryUrl, helperRelease, sourceRepository }) {
  requireAbsolutePath(sourceRepository, 'Source repository')
  requireRepositoryUrl(expectedRepositoryUrl)
  requireReleaseEvidence(helperRelease, 'Helper')

  const canonicalRepository = await realpath(sourceRepository).catch(() => {
    fail('release_verification_failed', 'Source repository does not exist.')
  })
  if (canonicalRepository !== sourceRepository) {
    fail('release_verification_failed', 'Source repository must use its canonical path.')
  }
  const origin = (await runGit(sourceRepository, ['remote', 'get-url', 'origin'])).trim()
  if (origin !== expectedRepositoryUrl) {
    fail('release_verification_failed', 'Git origin does not match the approved repository URL.')
  }
  const tagType = (await runGit(sourceRepository, ['cat-file', '-t', `refs/tags/${helperRelease.tag}`])).trim()
  if (tagType !== 'tag') {
    fail('release_verification_failed', 'The approved helper release tag must be annotated.')
  }
  const resolvedCommit = (await runGit(
    sourceRepository,
    ['rev-parse', '--verify', `refs/tags/${helperRelease.tag}^{commit}`],
  )).trim()
  if (resolvedCommit !== helperRelease.commitSha) {
    fail('release_verification_failed', 'The approved helper tag does not resolve to the exact commit.')
  }
  const checkedOutCommit = (await runGit(sourceRepository, ['rev-parse', '--verify', 'HEAD'])).trim()
  const worktreeStatus = (await runGit(
    sourceRepository,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', RELEASE_SUBDIRECTORY],
  )).trim()
  if (checkedOutCommit !== helperRelease.commitSha || worktreeStatus) {
    fail('release_verification_failed', 'The activation helper must run from its clean exact release checkout.')
  }
}

async function loadImmutableRelease({ release, sourceRepository }) {
  const { commitSha: expectedCommit, tag: expectedTag } = requireReleaseEvidence(release, 'Release')
  const tagType = (await runGit(sourceRepository, ['cat-file', '-t', `refs/tags/${expectedTag}`])).trim()
  if (tagType !== 'tag') fail('release_verification_failed', 'The approved release tag must be annotated.')
  const resolvedCommit = (await runGit(
    sourceRepository,
    ['rev-parse', '--verify', `refs/tags/${expectedTag}^{commit}`],
  )).trim()
  if (resolvedCommit !== expectedCommit) {
    fail('release_verification_failed', 'The approved release tag does not resolve to the exact commit.')
  }

  const treeOutput = await runGit(
    sourceRepository,
    ['ls-tree', '-r', '-z', '--full-tree', expectedCommit, '--', RELEASE_SUBDIRECTORY],
    { encoding: 'buffer' },
  )
  const records = Buffer.from(treeOutput).toString('utf8').split('\0').filter(Boolean)
  if (records.length === 0 || records.length > MAX_FILES) {
    fail('release_verification_failed', 'The release has an invalid file count.')
  }

  const files = []
  let totalBytes = 0
  for (const record of records) {
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/.exec(record)
    if (!match) fail('release_verification_failed', 'The release tree entry is malformed.')
    const [, mode, type, objectId, gitPath] = match
    if (type !== 'blob' || !gitObjectPattern.test(objectId) || (mode !== '100644' && mode !== '100755')) {
      fail('release_verification_failed', 'The release contains a symbolic link, submodule, or unsupported mode.')
    }
    const prefix = `${RELEASE_SUBDIRECTORY}/`
    if (!gitPath.startsWith(prefix)) {
      fail('release_verification_failed', 'The release tree escaped its approved subdirectory.')
    }
    const path = normalizeGitPath(gitPath.slice(prefix.length))
    const sizeText = (await runGit(sourceRepository, ['cat-file', '-s', objectId])).trim()
    if (!/^\d+$/.test(sizeText)) fail('release_verification_failed', 'The release blob size is invalid.')
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || totalBytes + size > MAX_TREE_BYTES) {
      fail('release_verification_failed', 'The release exceeds the bounded content budget.')
    }
    const content = Buffer.from(await runGit(
      sourceRepository,
      ['cat-file', 'blob', objectId],
      { encoding: 'buffer', maxBuffer: size + (1024 * 16) },
    ))
    if (content.length !== size) fail('release_verification_failed', 'The release blob readback is incomplete.')
    totalBytes += size
    files.push({ content, mode, path, type: 'file' })
  }
  files.sort((left, right) => compareStrings(left.path, right.path))
  if (!files.some((entry) => entry.path === 'SKILL.md')) {
    fail('release_verification_failed', 'The release does not contain SKILL.md.')
  }
  const entries = [...buildDirectoryEntries(files), ...files].sort((left, right) => (
    compareStrings(left.path, right.path) || compareStrings(left.type, right.type)
  ))
  const portablePaths = new Set()
  for (const entry of entries) {
    const portablePath = entry.path.toLowerCase()
    if (portablePaths.has(portablePath)) {
      fail('release_verification_failed', 'The release contains a case-colliding path.')
    }
    portablePaths.add(portablePath)
  }
  return {
    commitSha: expectedCommit,
    entries,
    fileCount: files.length,
    tag: expectedTag,
    treeDigest: hashTreeEntries(entries),
  }
}

async function fsyncDirectory(path) {
  const descriptor = await open(path, fsConstants.O_RDONLY)
  try {
    const descriptorStat = await descriptor.stat({ bigint: true })
    if (!descriptorStat.isDirectory()) fail('filesystem_changed', 'Activation parent is no longer a directory.')
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

async function ensureActivationParent(providerHome) {
  await mkdir(providerHome, { recursive: true, mode: 0o700 })
  const canonicalHome = await realpath(providerHome)
  if (canonicalHome !== providerHome) fail('invalid_path', 'Provider home must be canonical and must not be a symbolic link.')
  const skillsDirectory = join(providerHome, 'skills')
  await mkdir(skillsDirectory, { recursive: true, mode: 0o700 })
  const skillsStat = await lstat(skillsDirectory, { bigint: true })
  if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
    fail('invalid_path', 'Provider skills path must be a real directory.')
  }
  return skillsDirectory
}

function transactionPaths(parent, operationId) {
  return {
    backup: join(parent, `.porta-workflow.backup-${operationId}`),
    journal: join(parent, '.porta-workflow.activation.json'),
    lock: join(parent, '.porta-workflow.activation.lock'),
    recoveryClaim: join(parent, '.porta-workflow.activation.recovery'),
    stage: join(parent, `.porta-workflow.stage-${operationId}`),
  }
}

async function writeDescriptorJson(descriptor, value) {
  const content = Buffer.from(`${JSON.stringify(value)}\n`)
  if (content.length > MAX_JOURNAL_BYTES) fail('transaction_failed', 'Activation state exceeds its bounded size.')
  await descriptor.writeFile(content)
  await descriptor.sync()
}

async function publishJson(path, value) {
  const parent = dirname(path)
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.candidate`)
  let descriptor
  try {
    descriptor = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    await writeDescriptorJson(descriptor, value)
    await descriptor.close()
    descriptor = undefined
    await rename(temporary, path)
    await fsyncDirectory(parent)
  } catch (error) {
    await descriptor?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function readBoundedJsonReceipt(path) {
  const descriptor = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await descriptor.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 2n || before.size > BigInt(MAX_JOURNAL_BYTES)) {
      fail('transaction_corrupt', 'Activation state is malformed.')
    }
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat({ bigint: true })
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) fail('filesystem_changed', 'Activation state changed during readback.')
    return {
      identity: { dev: before.dev, ino: before.ino },
      value: JSON.parse(bytes.toString('utf8')),
    }
  } catch (error) {
    if (error instanceof ActivationError) throw error
    fail('transaction_corrupt', 'Activation state is not valid JSON.')
  } finally {
    await descriptor.close()
  }
}

async function readBoundedJson(path) {
  return (await readBoundedJsonReceipt(path)).value
}

function requireOwner(value, label) {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['pid', 'startedAt', 'token', 'version'])
    || value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || !operationIdPattern.test(value.token)
    || typeof value.startedAt !== 'string'
    || Number.isNaN(Date.parse(value.startedAt))
    || new Date(value.startedAt).toISOString() !== value.startedAt
  ) fail('transaction_corrupt', `${label} owner receipt is invalid.`)
  return value
}

async function createOwnedJson(path, owner, parent) {
  const descriptor = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  let identity
  let closed = false
  try {
    const initial = await descriptor.stat({ bigint: true })
    if (!initial.isFile() || initial.nlink !== 1n || initial.size !== 0n) {
      fail('filesystem_changed', 'Activation owner file was not created exclusively.')
    }
    identity = { dev: initial.dev, ino: initial.ino }
    await writeDescriptorJson(descriptor, owner)
    const stat = await descriptor.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || !sameIdentity(identity, stat)) {
      fail('filesystem_changed', 'Activation owner file is unsafe.')
    }
    await descriptor.close()
    closed = true
    await fsyncDirectory(parent)
    return { identity, owner, path }
  } catch (error) {
    if (!closed) await descriptor.close().catch(() => {})
    if (identity) {
      try {
        await removeFileByIdentity(path, identity, 'incomplete-owner', parent)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Activation owner publication failed and exact cleanup is required.')
      }
    }
    throw error
  }
}

async function readOwnedJson(path, label) {
  const receipt = await readBoundedJsonReceipt(path)
  return {
    identity: receipt.identity,
    owner: requireOwner(receipt.value, label),
    path,
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function restoreQuarantinedUnknown(quarantine, path, parent) {
  try {
    await link(quarantine, path)
    await unlink(quarantine)
    await fsyncDirectory(parent)
  } catch {
    fail('filesystem_changed', 'Unknown activation ownership evidence was preserved for explicit recovery.')
  }
}

async function removeFileByIdentity(path, identity, label, parent) {
  const quarantine = `${path}.${label}-${randomUUID()}`
  await rename(path, quarantine)
  await fsyncDirectory(parent)
  const descriptor = await open(quarantine, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let observed
  try {
    observed = await descriptor.stat({ bigint: true })
  } finally {
    await descriptor.close()
  }
  if (!observed.isFile() || observed.nlink !== 1n || !sameIdentity(observed, identity)) {
    await restoreQuarantinedUnknown(quarantine, path, parent)
    fail('filesystem_changed', `${label} ownership changed before cleanup.`)
  }
  await unlink(quarantine)
  await fsyncDirectory(parent)
}

async function removeOwnedJson(receipt, label, parent) {
  const quarantine = `${receipt.path}.${label}-${randomUUID()}`
  try {
    await rename(receipt.path, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('filesystem_changed', `${label} ownership disappeared before settlement.`)
    throw error
  }
  await fsyncDirectory(parent)
  let observed
  try {
    observed = await readOwnedJson(quarantine, label)
  } catch (error) {
    await restoreQuarantinedUnknown(quarantine, receipt.path, parent)
    throw error
  }
  if (
    !sameIdentity(observed.identity, receipt.identity)
    || observed.owner.token !== receipt.owner.token
    || observed.owner.pid !== receipt.owner.pid
  ) {
    await restoreQuarantinedUnknown(quarantine, receipt.path, parent)
    fail('filesystem_changed', `${label} ownership changed before settlement.`)
  }
  await unlink(quarantine)
  await fsyncDirectory(parent)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function acquireTransactionLock(parent) {
  const paths = transactionPaths(parent, 'pending')
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID(), version: 1 }
  const tryCreate = async () => {
    return createOwnedJson(paths.lock, owner, parent)
  }
  try {
    return await tryCreate()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const claimOwner = { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID(), version: 1 }
  let claimReceipt
  try {
    claimReceipt = await createOwnedJson(paths.recoveryClaim, claimOwner, parent)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existingClaim = await readOwnedJson(paths.recoveryClaim, 'Activation recovery claim')
    if (processIsAlive(existingClaim.owner.pid)) {
      fail('activation_in_progress', 'Another activation or recovery owns this provider destination.')
    }
    await removeOwnedJson(existingClaim, 'recovered-claim', parent)
    claimReceipt = await createOwnedJson(paths.recoveryClaim, claimOwner, parent).catch((claimError) => {
      if (claimError?.code === 'EEXIST') {
        fail('activation_in_progress', 'Another activation or recovery owns this provider destination.')
      }
      throw claimError
    })
  }
  try {
    const existing = await readOwnedJson(paths.lock, 'Activation lock')
    if (processIsAlive(existing.owner.pid)) {
      fail('activation_in_progress', 'Another activation owns this provider destination.')
    }
    await removeOwnedJson(existing, 'recovered-lock', parent)
    return await tryCreate()
  } finally {
    if (claimReceipt) await removeOwnedJson(claimReceipt, 'settled-claim', parent)
  }
}

async function materializeRelease(stage, release) {
  await mkdir(stage, { mode: 0o700 })
  for (const entry of release.entries) {
    const target = join(stage, ...entry.path.split('/'))
    const relativeTarget = relative(stage, target)
    if (!relativeTarget || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      fail('release_verification_failed', 'A release entry escaped the activation stage.')
    }
    if (entry.type === 'directory') {
      await mkdir(target, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const descriptor = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      entry.mode === '100755' ? 0o755 : 0o644,
    )
    try {
      await descriptor.writeFile(entry.content)
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    await chmod(target, entry.mode === '100755' ? 0o755 : 0o644)
  }
  await fsyncDirectory(stage)
}

function sameStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
}

async function readExactFile(path) {
  const descriptor = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await descriptor.stat({ bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_FILE_BYTES)) {
      fail('filesystem_changed', 'Installed Skill contains an unsafe file.')
    }
    const content = await descriptor.readFile()
    const after = await descriptor.stat({ bigint: true })
    if (!sameStat(before, after) || BigInt(content.length) !== before.size) {
      fail('filesystem_changed', 'Installed Skill changed during verification.')
    }
    return { content, mode: (Number(before.mode) & 0o111) === 0 ? '100644' : '100755' }
  } finally {
    await descriptor.close()
  }
}

async function readFilesystemTree(root) {
  const rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('filesystem_changed', 'Installed Skill must be a real directory.')
  }
  const entries = []
  let fileCount = 0
  let totalBytes = 0
  async function walk(directory, prefix = '', expectedDirectoryStat = undefined) {
    const before = await lstat(directory, { bigint: true })
    if (
      !before.isDirectory()
      || before.isSymbolicLink()
      || (expectedDirectoryStat && !sameStat(before, expectedDirectoryStat))
    ) fail('filesystem_changed', 'Installed Skill directory changed before verification.')
    const children = await readdir(directory, { withFileTypes: true })
    if (children.length > MAX_FILES * 2) fail('filesystem_changed', 'Installed Skill exceeds the entry budget.')
    children.sort((left, right) => compareStrings(left.name, right.name))
    for (const child of children) {
      const childPath = join(directory, child.name)
      const path = normalizeGitPath(prefix ? `${prefix}/${child.name}` : child.name)
      const childStat = await lstat(childPath, { bigint: true })
      if (childStat.isSymbolicLink()) fail('filesystem_changed', 'Installed Skill contains a symbolic link.')
      if (childStat.isDirectory()) {
        entries.push({ path, type: 'directory' })
        await walk(childPath, path, childStat)
        continue
      }
      if (!childStat.isFile()) fail('filesystem_changed', 'Installed Skill contains a special file.')
      fileCount += 1
      if (fileCount > MAX_FILES) fail('filesystem_changed', 'Installed Skill exceeds the file budget.')
      const file = await readExactFile(childPath)
      totalBytes += file.content.length
      if (totalBytes > MAX_TREE_BYTES) fail('filesystem_changed', 'Installed Skill exceeds the content budget.')
      entries.push({ ...file, path, type: 'file' })
    }
    const after = await lstat(directory, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || !sameStat(before, after)) {
      fail('filesystem_changed', 'Installed Skill directory changed during verification.')
    }
  }
  await walk(root, '', rootStat)
  entries.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.type, right.type))
  return { fileCount, treeDigest: hashTreeEntries(entries) }
}

async function readTreeIfPresent(path) {
  try {
    return await readFilesystemTree(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function requireJournal(value, destination, expectedProvider) {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'destination',
      'fromCommit',
      'fromTag',
      'helperCommit',
      'helperTag',
      'intent',
      'newTreeDigest',
      'operationId',
      'phase',
      'previousTreeDigest',
      'provider',
      'targetCommit',
      'targetTag',
      'version',
    ])
    || value.version !== TRANSACTION_VERSION
    || value.provider !== expectedProvider
    || value.destination !== destination
    || typeof value.operationId !== 'string'
    || !operationIdPattern.test(value.operationId)
    || !TRANSITION_INTENTS.has(value.intent)
    || !commitPattern.test(value.helperCommit)
    || !tagPattern.test(value.helperTag)
    || !commitPattern.test(value.targetCommit)
    || !tagPattern.test(value.targetTag)
    || !(
      value.intent === 'install'
        ? value.fromCommit === null && value.fromTag === null && value.previousTreeDigest === null
        : commitPattern.test(value.fromCommit)
          && tagPattern.test(value.fromTag)
          && /^[0-9a-f]{64}$/.test(value.previousTreeDigest)
    )
    || !/^[0-9a-f]{64}$/.test(value.newTreeDigest)
    || !['staged', 'previous-retired', 'activated'].includes(value.phase)
  ) fail('transaction_corrupt', 'Activation journal is invalid.')
  return value
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function removeOwnedTree(path, expectedDigest) {
  const tree = await readTreeIfPresent(path)
  if (!tree) return
  if (tree.treeDigest !== expectedDigest) fail('filesystem_changed', 'Activation-owned directory no longer matches its receipt.')
  const parent = dirname(path)
  const quarantine = `${path}.settled-${randomUUID()}`
  await rename(path, quarantine)
  await fsyncDirectory(parent)
  const moved = await readFilesystemTree(quarantine)
  if (moved.treeDigest !== expectedDigest || moved.fileCount !== tree.fileCount) {
    fail('filesystem_changed', 'Activation-owned directory changed before cleanup; the moved tree was preserved.')
  }
  await rm(quarantine, { recursive: true })
  await fsyncDirectory(parent)
}

async function removeJournal(journalPath, parent) {
  await unlink(journalPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  await fsyncDirectory(parent)
}

async function recoverTransaction({ destination, journalPath, parent, provider }) {
  let rawJournal
  try {
    rawJournal = await readBoundedJson(journalPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { recoveredPreviousRelease: false }
    throw error
  }
  const journal = requireJournal(rawJournal, destination, provider)
  const paths = transactionPaths(parent, journal.operationId)
  const [active, backup, stage] = await Promise.all([
    readTreeIfPresent(destination),
    readTreeIfPresent(paths.backup),
    readTreeIfPresent(paths.stage),
  ])

  if (active?.treeDigest === journal.newTreeDigest) {
    if (stage && stage.treeDigest !== journal.newTreeDigest) {
      fail('filesystem_changed', 'Activation stage was replaced before recovery.')
    }
    if (journal.previousTreeDigest && backup?.treeDigest === journal.previousTreeDigest) {
      if (stage) fail('filesystem_changed', 'Activation has two candidate trees during rollback.')
      await rename(destination, paths.stage)
      await rename(paths.backup, destination)
      await fsyncDirectory(parent)
      const restored = await readFilesystemTree(destination)
      if (restored.treeDigest !== journal.previousTreeDigest) {
        fail('filesystem_changed', 'Previous Skill release could not be restored after an incomplete activation.')
      }
      await removeOwnedTree(paths.stage, journal.newTreeDigest)
      await removeJournal(journalPath, parent)
      return { recoveredPreviousRelease: true }
    }
    if (backup) fail('filesystem_changed', 'Activation backup was replaced before recovery.')
    if (journal.previousTreeDigest) {
      if (stage) await removeOwnedTree(paths.stage, stage.treeDigest)
      await removeJournal(journalPath, parent)
      return { activatedTreeDigest: journal.newTreeDigest, recoveredPreviousRelease: false }
    }
    await removeOwnedTree(destination, journal.newTreeDigest)
    if (stage) await removeOwnedTree(paths.stage, stage.treeDigest)
    await removeJournal(journalPath, parent)
    return { recoveredPreviousRelease: false }
  }

  if (journal.previousTreeDigest) {
    if (active?.treeDigest === journal.previousTreeDigest && !backup) {
      if (stage) await removeOwnedTree(paths.stage, journal.newTreeDigest)
      await removeJournal(journalPath, parent)
      return { recoveredPreviousRelease: false }
    }
    if (!active && backup?.treeDigest === journal.previousTreeDigest) {
      if (stage && stage.treeDigest !== journal.newTreeDigest) {
        fail('filesystem_changed', 'Activation stage was replaced before rollback.')
      }
      await rename(paths.backup, destination)
      await fsyncDirectory(parent)
      const restored = await readFilesystemTree(destination)
      if (restored.treeDigest !== journal.previousTreeDigest) {
        fail('filesystem_changed', 'Previous Skill release could not be restored exactly.')
      }
      if (stage) await removeOwnedTree(paths.stage, journal.newTreeDigest)
      await removeJournal(journalPath, parent)
      return { recoveredPreviousRelease: true }
    }
  } else if (!active && !backup) {
    if (stage) await removeOwnedTree(paths.stage, journal.newTreeDigest)
    await removeJournal(journalPath, parent)
    return { recoveredPreviousRelease: false }
  }

  fail('filesystem_changed', 'Activation state cannot be recovered without risking an installed release.')
}

async function writeJournal(path, journal) {
  await publishJson(path, journal)
}

async function invokeHook(hooks, phase) {
  await hooks?.onPhase?.(phase)
}

export async function activatePortaWorkflowSkill(input) {
  if (!isRecord(input)) fail('invalid_arguments', 'Activation input is required.')
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    fail('unsupported_platform', 'Atomic Skill activation currently requires macOS, Linux, or WSL.')
  }
  const provider = requireProvider(input.provider)
  const providerHome = requireAbsolutePath(input.providerHome, 'Provider home')
  const destination = resolvePortaWorkflowSkillDestination({ provider, providerHome })
  const helperRelease = requireReleaseEvidence(input.helperRelease, 'Helper')
  const transition = requireTransition(input.transition)
  await verifySourceRepository({
    expectedRepositoryUrl: input.expectedRepositoryUrl,
    helperRelease,
    sourceRepository: input.sourceRepository,
  })
  const release = await loadImmutableRelease({
    release: transition.to,
    sourceRepository: input.sourceRepository,
  })
  const approvedPreviousRelease = transition.from
    ? await loadImmutableRelease({ release: transition.from, sourceRepository: input.sourceRepository })
    : undefined
  const parent = await ensureActivationParent(providerHome)
  if (dirname(destination) !== parent) fail('invalid_path', 'Provider destination does not match its canonical user-level root.')

  const lockReceipt = await acquireTransactionLock(parent)
  const commonPaths = transactionPaths(parent, 'pending')
  let recovery = { recoveredPreviousRelease: false }
  let currentOperationPaths
  let journal
  try {
    recovery = await recoverTransaction({ destination, journalPath: commonPaths.journal, parent, provider })
    if (recovery.activatedTreeDigest === release.treeDigest) {
      const installed = await readFilesystemTree(destination)
      return {
        action: transition.intent === 'rollback' ? 'rolled-back' : 'updated',
        commitSha: release.commitSha,
        fileCount: installed.fileCount,
        helperCommitSha: helperRelease.commitSha,
        helperTag: helperRelease.tag,
        installedPath: destination,
        intent: transition.intent,
        provider,
        recoveredPreviousRelease: false,
        repositoryUrl: input.expectedRepositoryUrl,
        ...(transition.from ? {
          sourceCommitSha: transition.from.commitSha,
          sourceTag: transition.from.tag,
        } : {}),
        tag: release.tag,
        treeDigest: installed.treeDigest,
        type: 'porta-workflow-skill-activation-receipt',
      }
    }

    const previous = await readTreeIfPresent(destination)
    if (previous?.treeDigest === release.treeDigest) {
      return {
        action: 'unchanged',
        commitSha: release.commitSha,
        fileCount: previous.fileCount,
        helperCommitSha: helperRelease.commitSha,
        helperTag: helperRelease.tag,
        installedPath: destination,
        intent: transition.intent,
        provider,
        recoveredPreviousRelease: recovery.recoveredPreviousRelease,
        repositoryUrl: input.expectedRepositoryUrl,
        ...(transition.from ? {
          sourceCommitSha: transition.from.commitSha,
          sourceTag: transition.from.tag,
        } : {}),
        tag: release.tag,
        treeDigest: previous.treeDigest,
        type: 'porta-workflow-skill-activation-receipt',
      }
    }
    if (transition.intent === 'install') {
      if (previous) {
        fail('transition_source_mismatch', 'Fresh installation requires the Provider destination to be absent.')
      }
    } else if (
      !previous
      || !approvedPreviousRelease
      || previous.treeDigest !== approvedPreviousRelease.treeDigest
      || previous.fileCount !== approvedPreviousRelease.fileCount
    ) {
      fail('transition_source_mismatch', 'Installed Skill does not match the exact approved source release for this transition.')
    }
    const operationId = randomUUID()
    currentOperationPaths = transactionPaths(parent, operationId)
    if (await pathExists(currentOperationPaths.stage) || await pathExists(currentOperationPaths.backup)) {
      fail('transaction_conflict', 'Activation operation paths already exist.')
    }
    try {
      await materializeRelease(currentOperationPaths.stage, release)
    } catch (error) {
      await rm(currentOperationPaths.stage, { force: true, recursive: true }).catch(() => {})
      await fsyncDirectory(parent).catch(() => {})
      throw error
    }
    const staged = await readFilesystemTree(currentOperationPaths.stage)
    if (staged.treeDigest !== release.treeDigest || staged.fileCount !== release.fileCount) {
      fail('release_verification_failed', 'The staged Skill does not match the immutable Git release.')
    }
    journal = {
      destination,
      fromCommit: transition.from?.commitSha ?? null,
      fromTag: transition.from?.tag ?? null,
      helperCommit: helperRelease.commitSha,
      helperTag: helperRelease.tag,
      intent: transition.intent,
      newTreeDigest: release.treeDigest,
      operationId,
      phase: 'staged',
      previousTreeDigest: previous?.treeDigest ?? null,
      provider,
      targetCommit: transition.to.commitSha,
      targetTag: transition.to.tag,
      version: TRANSACTION_VERSION,
    }
    await writeJournal(commonPaths.journal, journal)
    await invokeHook(input.hooks, 'after-staged')

    if (previous) {
      const current = await readFilesystemTree(destination)
      if (current.treeDigest !== previous.treeDigest) {
        fail('filesystem_changed', 'Installed Skill changed before activation.')
      }
      await rename(destination, currentOperationPaths.backup)
      await fsyncDirectory(parent)
      const backup = await readFilesystemTree(currentOperationPaths.backup)
      if (backup.treeDigest !== previous.treeDigest || backup.fileCount !== previous.fileCount) {
        fail('filesystem_changed', 'Retired Skill no longer matches the approved source release.')
      }
      journal = { ...journal, phase: 'previous-retired' }
      await writeJournal(commonPaths.journal, journal)
      await invokeHook(input.hooks, 'after-previous-retired')
    }

    await rename(currentOperationPaths.stage, destination)
    await fsyncDirectory(parent)
    journal = { ...journal, phase: 'activated' }
    await writeJournal(commonPaths.journal, journal)
    await invokeHook(input.hooks, 'after-activated')

    const active = await readFilesystemTree(destination)
    if (active.treeDigest !== release.treeDigest || active.fileCount !== release.fileCount) {
      fail('filesystem_changed', 'Activated Skill does not match the staged release.')
    }
    if (previous) await removeOwnedTree(currentOperationPaths.backup, previous.treeDigest)
    await removeJournal(commonPaths.journal, parent)
    return {
      action: previous
        ? transition.intent === 'rollback' ? 'rolled-back' : 'updated'
        : 'installed',
      commitSha: release.commitSha,
      fileCount: active.fileCount,
      helperCommitSha: helperRelease.commitSha,
      helperTag: helperRelease.tag,
      installedPath: destination,
      intent: transition.intent,
      ...(previous ? { previousTreeDigest: previous.treeDigest } : {}),
      provider,
      recoveredPreviousRelease: recovery.recoveredPreviousRelease,
      repositoryUrl: input.expectedRepositoryUrl,
      ...(transition.from ? {
        sourceCommitSha: transition.from.commitSha,
        sourceTag: transition.from.tag,
      } : {}),
      tag: release.tag,
      treeDigest: active.treeDigest,
      type: 'porta-workflow-skill-activation-receipt',
    }
  } catch (error) {
    try {
      await recoverTransaction({ destination, journalPath: commonPaths.journal, parent, provider })
      if (!journal && currentOperationPaths && await pathExists(currentOperationPaths.stage)) {
        await removeOwnedTree(currentOperationPaths.stage, release.treeDigest)
      }
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Skill activation failed and exact recovery is required.')
    }
    throw error
  } finally {
    await removeOwnedJson(lockReceipt, 'settled-lock', parent)
  }
}

function parseArguments(tokens) {
  const values = new Map()
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index]
    const value = tokens[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--') || values.has(name)) {
      fail('invalid_arguments', 'Activation arguments are invalid or duplicated.')
    }
    values.set(name, value)
  }
  const base = new Set([
    '--expected-repository-url',
    '--helper-commit',
    '--helper-tag',
    '--intent',
    '--provider',
    '--source-repository',
    '--target-commit',
    '--target-tag',
  ])
  const intent = values.get('--intent')
  const expected = new Set(base)
  if (intent === 'update' || intent === 'rollback') {
    expected.add('--source-commit')
    expected.add('--source-tag')
  }
  if (
    !TRANSITION_INTENTS.has(intent)
    || values.size !== expected.size
    || [...values.keys()].some((name) => !expected.has(name))
  ) {
    fail('invalid_arguments', 'Activation requires the exact documented option set.')
  }
  return values
}

function help() {
  return `Porta Workflow Skill activation transaction\n\n` +
    `Usage:\n` +
    `  node porta-workflow-skill-activation.mjs activate --provider <codex|claude|gemini> --source-repository <canonical-path> --expected-repository-url <https-url> --helper-tag <tag> --helper-commit <full-sha> --intent install --target-tag <tag> --target-commit <full-sha>\n` +
    `  node porta-workflow-skill-activation.mjs activate --provider <codex|claude|gemini> --source-repository <canonical-path> --expected-repository-url <https-url> --helper-tag <tag> --helper-commit <full-sha> --intent <update|rollback> --source-tag <tag> --source-commit <full-sha> --target-tag <tag> --target-commit <full-sha>\n\n` +
    `The command verifies the helper checkout, exact approved source and target releases, stages the complete target tree beside the provider's user-level Skill directory, and restores the source release after a recoverable failure. It never activates a WorkRun.\n`
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2)
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(help())
    return
  }
  if (command !== 'activate') fail('invalid_arguments', 'Unknown activation command.')
  const values = parseArguments(tokens)
  const provider = values.get('--provider')
  const receipt = await activatePortaWorkflowSkill({
    expectedRepositoryUrl: values.get('--expected-repository-url'),
    helperRelease: {
      commitSha: values.get('--helper-commit'),
      tag: values.get('--helper-tag'),
    },
    provider,
    providerHome: resolveDefaultProviderHome(provider),
    sourceRepository: values.get('--source-repository'),
    transition: {
      ...(values.get('--intent') === 'install' ? {} : {
        from: {
          commitSha: values.get('--source-commit'),
          tag: values.get('--source-tag'),
        },
      }),
      intent: values.get('--intent'),
      to: {
        commitSha: values.get('--target-commit'),
        tag: values.get('--target-tag'),
      },
    },
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt }, null, 2)}\n`)
}

function writeError(error) {
  const normalized = error instanceof ActivationError
    ? error
    : new ActivationError('activation_failed', 'Porta Workflow Skill activation failed.')
  process.stderr.write(`${JSON.stringify({
    code: normalized.code,
    message: normalized.message,
    ok: false,
    type: 'porta-workflow-skill-activation-error',
  }, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    writeError(error)
    process.exitCode = 1
  })
}
