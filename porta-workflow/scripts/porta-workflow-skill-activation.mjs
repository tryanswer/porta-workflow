#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
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
const TRANSACTION_VERSION = 1
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const commitPattern = /^[0-9a-f]{40}$/
const gitObjectPattern = /^[0-9a-f]{40,64}$/

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

export function resolvePortaWorkflowSkillDestination({ provider, providerHome }) {
  requireProvider(provider)
  requireAbsolutePath(providerHome, 'Provider home')
  return join(providerHome, 'skills', SKILL_ID)
}

function resolveDefaultProviderHome(provider, environment = process.env) {
  requireProvider(provider)
  if (provider === 'codex') {
    return resolve(environment.CODEX_HOME || join(homedir(), '.codex'))
  }
  if (provider === 'claude') {
    return resolve(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  }
  return resolve(join(homedir(), '.gemini'))
}

async function runGit(repository, args, options = {}) {
  try {
    const result = await execFileAsync('git', ['-C', repository, ...args], {
      encoding: options.encoding ?? 'utf8',
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
  return [...paths].sort().map((path) => ({ path, type: 'directory' }))
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

async function loadImmutableRelease({
  expectedCommit,
  expectedRepositoryUrl,
  expectedTag,
  sourceRepository,
}) {
  requireAbsolutePath(sourceRepository, 'Source repository')
  requireCommit(expectedCommit)
  requireRepositoryUrl(expectedRepositoryUrl)
  requireSafeTag(expectedTag)

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
  const tagType = (await runGit(sourceRepository, ['cat-file', '-t', `refs/tags/${expectedTag}`])).trim()
  if (tagType !== 'tag') {
    fail('release_verification_failed', 'The approved release tag must be annotated.')
  }
  const resolvedCommit = (await runGit(
    sourceRepository,
    ['rev-parse', '--verify', `refs/tags/${expectedTag}^{commit}`],
  )).trim()
  if (resolvedCommit !== expectedCommit) {
    fail('release_verification_failed', 'The approved tag does not resolve to the exact commit.')
  }
  const checkedOutCommit = (await runGit(sourceRepository, ['rev-parse', '--verify', 'HEAD'])).trim()
  const worktreeStatus = (await runGit(
    sourceRepository,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', RELEASE_SUBDIRECTORY],
  )).trim()
  if (checkedOutCommit !== expectedCommit || worktreeStatus) {
    fail('release_verification_failed', 'The activation helper must run from the clean exact release checkout.')
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
  files.sort((left, right) => left.path.localeCompare(right.path))
  if (!files.some((entry) => entry.path === 'SKILL.md')) {
    fail('release_verification_failed', 'The release does not contain SKILL.md.')
  }
  const entries = [...buildDirectoryEntries(files), ...files].sort((left, right) => (
    left.path.localeCompare(right.path) || left.type.localeCompare(right.type)
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

async function readBoundedJson(path) {
  const descriptor = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await descriptor.stat({ bigint: true })
    if (!before.isFile() || before.size < 2n || before.size > BigInt(MAX_JOURNAL_BYTES)) {
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
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error instanceof ActivationError) throw error
    fail('transaction_corrupt', 'Activation state is not valid JSON.')
  } finally {
    await descriptor.close()
  }
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
    const descriptor = await open(
      paths.lock,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await writeDescriptorJson(descriptor, owner)
    } finally {
      await descriptor.close()
    }
    await fsyncDirectory(parent)
  }
  try {
    await tryCreate()
    return paths.lock
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  let claim
  try {
    claim = await open(
      paths.recoveryClaim,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
  } catch (error) {
    if (error?.code === 'EEXIST') fail('activation_in_progress', 'Another activation or recovery owns this provider destination.')
    throw error
  }
  try {
    const existing = await readBoundedJson(paths.lock)
    if (processIsAlive(existing?.pid)) {
      fail('activation_in_progress', 'Another activation owns this provider destination.')
    }
    await unlink(paths.lock)
    await fsyncDirectory(parent)
    await tryCreate()
  } finally {
    await claim.close().catch(() => {})
    await unlink(paths.recoveryClaim).catch(() => {})
    await fsyncDirectory(parent).catch(() => {})
  }
  return paths.lock
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
  async function walk(directory, prefix = '') {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const childPath = join(directory, child.name)
      const path = normalizeGitPath(prefix ? `${prefix}/${child.name}` : child.name)
      const childStat = await lstat(childPath, { bigint: true })
      if (childStat.isSymbolicLink()) fail('filesystem_changed', 'Installed Skill contains a symbolic link.')
      if (childStat.isDirectory()) {
        entries.push({ path, type: 'directory' })
        await walk(childPath, path)
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
  }
  await walk(root)
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type))
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

function requireJournal(value, destination) {
  if (
    !isRecord(value)
    || value.version !== TRANSACTION_VERSION
    || !PROVIDERS.has(value.provider)
    || value.destination !== destination
    || typeof value.operationId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(value.operationId)
    || !commitPattern.test(value.expectedCommit)
    || !/^[0-9a-f]{64}$/.test(value.newTreeDigest)
    || !(value.previousTreeDigest === null || /^[0-9a-f]{64}$/.test(value.previousTreeDigest))
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
  await rm(path, { recursive: true })
}

async function removeJournal(journalPath, parent) {
  await unlink(journalPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  await fsyncDirectory(parent)
}

async function recoverTransaction({ destination, journalPath, parent }) {
  let rawJournal
  try {
    rawJournal = await readBoundedJson(journalPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { recoveredPreviousRelease: false }
    throw error
  }
  const journal = requireJournal(rawJournal, destination)
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
  const release = await loadImmutableRelease(input)
  const parent = await ensureActivationParent(providerHome)
  if (dirname(destination) !== parent) fail('invalid_path', 'Provider destination does not match its canonical user-level root.')

  const lockPath = await acquireTransactionLock(parent)
  const commonPaths = transactionPaths(parent, 'pending')
  let recovery = { recoveredPreviousRelease: false }
  let currentOperationPaths
  let journal
  try {
    recovery = await recoverTransaction({ destination, journalPath: commonPaths.journal, parent })
    if (recovery.activatedTreeDigest === release.treeDigest) {
      const installed = await readFilesystemTree(destination)
      return {
        action: 'updated',
        commitSha: release.commitSha,
        fileCount: installed.fileCount,
        installedPath: destination,
        provider,
        recoveredPreviousRelease: false,
        repositoryUrl: input.expectedRepositoryUrl,
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
        installedPath: destination,
        provider,
        recoveredPreviousRelease: recovery.recoveredPreviousRelease,
        repositoryUrl: input.expectedRepositoryUrl,
        tag: release.tag,
        treeDigest: previous.treeDigest,
        type: 'porta-workflow-skill-activation-receipt',
      }
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
      expectedCommit: release.commitSha,
      newTreeDigest: release.treeDigest,
      operationId,
      phase: 'staged',
      previousTreeDigest: previous?.treeDigest ?? null,
      provider,
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
      action: previous ? 'updated' : 'installed',
      commitSha: release.commitSha,
      fileCount: active.fileCount,
      installedPath: destination,
      ...(previous ? { previousTreeDigest: previous.treeDigest } : {}),
      provider,
      recoveredPreviousRelease: recovery.recoveredPreviousRelease,
      repositoryUrl: input.expectedRepositoryUrl,
      tag: release.tag,
      treeDigest: active.treeDigest,
      type: 'porta-workflow-skill-activation-receipt',
    }
  } catch (error) {
    try {
      await recoverTransaction({ destination, journalPath: commonPaths.journal, parent })
      if (!journal && currentOperationPaths && await pathExists(currentOperationPaths.stage)) {
        await removeOwnedTree(currentOperationPaths.stage, release.treeDigest)
      }
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Skill activation failed and exact recovery is required.')
    }
    throw error
  } finally {
    await unlink(lockPath).catch(() => {})
    await fsyncDirectory(parent).catch(() => {})
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
  const expected = new Set([
    '--expected-commit',
    '--expected-repository-url',
    '--expected-tag',
    '--provider',
    '--source-repository',
  ])
  if (values.size !== expected.size || [...values.keys()].some((name) => !expected.has(name))) {
    fail('invalid_arguments', 'Activation requires the exact documented option set.')
  }
  return values
}

function help() {
  return `Porta Workflow Skill activation transaction\n\n` +
    `Usage:\n` +
    `  node porta-workflow-skill-activation.mjs activate --provider <codex|claude|gemini> --source-repository <canonical-path> --expected-repository-url <https-url> --expected-tag <tag> --expected-commit <full-sha>\n\n` +
    `The command reads the complete /porta-workflow subdirectory from the exact annotated Git tag and commit, stages it beside the provider's user-level Skill directory, and restores the previous exact tree after a recoverable failure. It never activates a WorkRun.\n`
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
    expectedCommit: values.get('--expected-commit'),
    expectedRepositoryUrl: values.get('--expected-repository-url'),
    expectedTag: values.get('--expected-tag'),
    provider,
    providerHome: resolveDefaultProviderHome(provider),
    sourceRepository: resolve(values.get('--source-repository') ?? ''),
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
