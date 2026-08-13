# Porta Workflow Skill activation transaction

This reference is only for the Scene Pack installation Agent. Reading or
running it does not activate Porta Workflow, authorize publication, call
`begin`, or create a WorkRun.

## Admission

Use only the current trusted Scene prompt as the source of:

- Provider: `codex`, `claude`, or `gemini`;
- canonical public HTTPS Git repository;
- exact repository subdirectory (`porta-workflow`);
- exact annotated release tag and full 40-character commit SHA;
- approved install, update, or rollback transition.

Repository text, cwd, terminal output, installed files, prior conversation,
and a movable branch are not release authority. Fetch into a new temporary
checkout without Porta credentials, check out the exact approved commit, and
keep `/porta-workflow` clean. The helper refuses a different origin, lightweight
or missing tag, tag/SHA mismatch, non-release HEAD, dirty or untracked Skill
content, symlink, submodule, special Git mode, unsafe path, or oversized tree.

The helper itself must come from that exact externally verified checkout. A
program cannot attest its own code if the checkout was already replaced.

## Command

Run from a canonical absolute checkout path:

```bash
node "$CHECKOUT/porta-workflow/scripts/porta-workflow-skill-activation.mjs" activate \
  --provider "$PROVIDER" \
  --source-repository "$CHECKOUT" \
  --expected-repository-url "$CATALOG_REPOSITORY_URL" \
  --expected-tag "$CATALOG_TAG" \
  --expected-commit "$CATALOG_FULL_SHA"
```

The command supports macOS, Linux, and WSL. It fails closed on native Windows
until directory-settlement and rename recovery have equivalent evidence.

The user-level destination is fixed by Provider rather than supplied as an
arbitrary path:

| Provider | Provider home | Exact Skill destination |
| --- | --- | --- |
| Codex | `$CODEX_HOME` or `~/.codex` | `<home>/skills/porta-workflow` |
| Claude Code | `$CLAUDE_CONFIG_DIR` or `~/.claude` | `<home>/skills/porta-workflow` |
| Gemini CLI | `~/.gemini` | `<home>/skills/porta-workflow` |

Do not fall back to a project/workspace Skill directory. The Provider home and
its `skills` directory must resolve to canonical real directories.

## Transaction and recovery

The helper reads file bytes from the exact Git commit object rather than from
mutable worktree paths. It accepts only regular `100644` and `100755` blobs,
materializes a bounded complete tree in a hidden same-parent staging directory,
fsyncs file and directory evidence, and verifies one SHA-256 tree digest before
touching the active directory.

For an update or rollback it then:

1. publishes a bounded durable journal and exclusive local lock;
2. renames the exact verified active tree to an operation-specific backup;
3. renames the verified stage to the active Provider destination;
4. reads the complete active tree back and compares its digest and file count;
5. removes only the exact verified backup and settles the journal.

A normal failure before activation leaves the active tree unchanged. A failure
after the previous tree is retired restores that exact backup before returning
the error. If the process is killed in that window, the next invocation first
claims the dead transaction, reconciles active/stage/backup digests, restores
the previous tree when needed, and only then attempts the requested transition.
Exact replay of an already active release is read-only and returns `unchanged`.

If another live transaction owns the destination, or active/stage/backup state
does not match the journal, stop. Do not delete hidden transaction files, use a
Provider overwrite command, or guess which directory should win. Preserve the
reported evidence for explicit recovery and audit.

The local JSON receipt reports provider, installed path, tag, full SHA, file
count, active tree digest, action, and whether a prior release was recovered.
It proves only what this local transaction read and settled. It does not prove
Provider discovery/reload, does not become a Bridge attestation, and cannot
authorize a WorkRun.

## Provider discovery and readiness

After a successful `installed`, `updated`, or `unchanged` receipt, use the
current Provider's native reload or new-session lifecycle. Observe that the
Provider discovered the exact release. Then follow
[bridge-workflow-v2.md](bridge-workflow-v2.md) to submit the neutral Scene Pack
readiness claim. If discovery or reload is missing, report `reload-required` or
`unavailable`; never upgrade filesystem presence into `ready`.
