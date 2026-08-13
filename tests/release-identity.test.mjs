import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(
  new URL('../porta-workflow/scripts/porta-workflow.mjs', import.meta.url),
)
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))
const releaseReferencePath = fileURLToPath(
  new URL('../porta-workflow/references/bridge-workflow-v2.md', import.meta.url),
)

test('public release tag stays bound to the client skill version', async () => {
  const [client, readme, releaseReference] = await Promise.all([
    readFile(clientPath, 'utf8'),
    readFile(readmePath, 'utf8'),
    readFile(releaseReferencePath, 'utf8'),
  ])
  const skillVersion = client.match(/^const SKILL_VERSION = '([^']+)'$/m)?.[1]
  assert.ok(skillVersion, 'client must declare SKILL_VERSION')
  const expectedTag = `porta-workflow-v${skillVersion}`
  const escapedTag = expectedTag.replaceAll('.', '\\.')
  const escapedVersion = skillVersion.replaceAll('.', '\\.')

  assert.match(readme, new RegExp(`git clone --branch ${escapedTag} `))
  assert.match(releaseReference, new RegExp(`"tag": "${escapedTag}"`))
  assert.match(releaseReference, new RegExp(`"version": "${escapedVersion}"`))
})
