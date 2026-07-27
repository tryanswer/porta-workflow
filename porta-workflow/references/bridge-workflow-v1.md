# Porta Workflow Bridge v1

## Contents

- Client setup
- Lifecycle
- Commands
- Manifest input
- Artifact evidence
- Failure and recovery
- Privacy and ownership

## Client setup

Resolve the absolute directory containing `SKILL.md`, then set `CLIENT` conceptually to its `scripts/porta-workflow.mjs`. Invoke it with Node 18 or newer from the project root.

```bash
node "/absolute/path/to/porta-workflow/scripts/porta-workflow.mjs" capabilities
node "/absolute/path/to/porta-workflow/scripts/porta-workflow.mjs" new-run-key
```

Record the returned `runKey` before beginning. Do not hide `new-run-key` inside command substitution: the key must remain available if a later command's output is interrupted.

Use the real current Agent provider: `codex`, `claude`, or `gemini`. Pass `--provider-session-id` only when the runtime exposes an exact stable session ID; omission is safer than invention.

```bash
node "$CLIENT" begin \
  --cwd "$(pwd -P)" \
  --provider codex \
  --run-key "run_00000000-0000-4000-8000-000000000000"
```

`begin` returns and persists Bridge-issued `workRunId`, `requestId`, `traceId`, `manifestPath`, and `logPath`. The state file lives under `.porta/workflow-client/`; do not commit it. Repeating `begin` with the same Run key and identical inputs returns the same local receipt.

## Lifecycle

1. Preflight capabilities before changing the project.
2. Begin one WorkRun for one explicit user invocation.
3. Inspect and implement using the repository's own architecture and commands.
4. Emit progress only at meaningful phase changes.
5. Start Preview monitoring when artifact preparation begins.
6. Produce and independently verify a Web or Android APK artifact. A Web process must use a project- or host-supported lifecycle that survives the transient Agent command/session.
7. Write an exact terminal manifest.
8. Send Ready, Failed, Unsupported, or Stop through the same WorkRun.

`begin` does not create a Product Preview. `preview-start` creates or restores the building Preview. `preview-ready` is only a wake-up: Bridge and Porta both re-read and validate the manifest before the App may show Ready.

## Commands

All commands return JSON. Use the same Run key from `begin` for the entire lifecycle.

| Intent | Command |
| --- | --- |
| Inspect identities and paths | `node "$CLIENT" show --run-key "$RUN_KEY"` |
| Planning/implementation/build/test update | `node "$CLIENT" progress --run-key "$RUN_KEY" --operation-key progress-1 --phase planning --summary "Inspecting project"` |
| Start Product Preview monitoring | `node "$CLIENT" preview-start --run-key "$RUN_KEY"` |
| Request user attention | `node "$CLIENT" attention --run-key "$RUN_KEY" --operation-key attention-1 --reason-code user_input_required` |
| Write schema v2 manifest | `node "$CLIENT" manifest --run-key "$RUN_KEY" --spec /path/to/spec.json` |
| Announce verified Ready manifest | `node "$CLIENT" ready --run-key "$RUN_KEY"` |
| Announce failed/unsupported manifest | `node "$CLIENT" fail --run-key "$RUN_KEY" --outcome failed --reason-code build_failed` |
| Stop exact WorkRun | `node "$CLIENT" stop --run-key "$RUN_KEY"` |

Allowed progress phases are `planning`, `implementing`, `building`, `testing`, and `waiting`. Percent is optional and must be an integer from 0 through 100. Summary is optional, bounded, and privacy-safe.

For every new progress or attention update, choose a new bounded `--operation-key`. For a retry after timeout, interruption, or unknown output, repeat the identical command with the identical operation key. The client refuses reuse with different input.

Use stable semantic reason codes such as `user_input_required`, `build_failed`, `verification_failed`, `preview_process_failed`, or `artifact_unsupported`. Put diagnostic detail in the exact log file and terminal response, not in the reason code.

## Manifest input

The client accepts a small spec and injects the Bridge-issued schema version, request, trace, cwd, and log identities. It writes atomically to the exact `manifestPath`. It does not claim the manifest is accepted; the subsequent Bridge terminal command performs authoritative validation.

Web Ready example:

```json
{
  "status": "ready",
  "project": {
    "name": "Current project",
    "gitBranch": "feature/example",
    "gitCommit": "0123456789abcdef"
  },
  "logs": {
    "summary": "Build and endpoint probe passed"
  },
  "artifacts": [
    {
      "id": "web-primary",
      "name": "Web preview",
      "type": "web",
      "scheme": "http",
      "remoteHost": "127.0.0.1",
      "remotePort": 4173,
      "path": "/",
      "framework": "vite"
    }
  ]
}
```

Web requires `id`, `name`, `type`, `scheme`, `remoteHost`, `remotePort`, and `path`; `framework` is optional. Bind a development or preview server to `127.0.0.1` when the project supports it. Choose the repository's or host's existing durable process-lifecycle mechanism, retain exact ownership evidence locally, let the launch command return, then verify the owning process and probe the actual endpoint before Ready. A server still owned by a transient Agent tool session is not durable evidence even when it currently returns HTTP 200.

Android APK requires these artifact fields:

| Field | Requirement |
| --- | --- |
| `id`, `name` | Stable bounded labels for this manifest |
| `type` | Exactly `android-apk` |
| `remotePath` | Exact freshly built APK path |
| `sha256` | SHA-256 of that exact file |
| `packageName` | Verified package identity |
| `versionName`, `versionCode`, `buildVariant` | Optional only when not reliably available |

For `failed` or `unsupported`, use an empty `artifacts` array and a bounded non-empty `error`. Do not include `error` on `building` or `ready`. Example shape:

```json
{
  "status": "failed",
  "project": { "name": "Current project" },
  "logs": { "summary": "See the request-scoped log" },
  "artifacts": [],
  "error": "Gradle build failed"
}
```

The optional `runner` object may contain `type`, `hostId`, `startedAt`, and `finishedAt`. Omit fields you cannot establish truthfully.

## Artifact evidence

Choose build and verification commands from the repository, not from this skill.

- Web: prove the owning process is still alive independently of the launch command and current Agent session, use its actual bound host/port, and probe the exact path. Prefer an existing project process manager or host session mechanism; use a generic detached process only when its ownership and stop path are exact. A printed URL, temporary tool session, or immediate probe alone is insufficient.
- Android APK: require a successful project-native build, a fresh non-empty APK, a computed SHA-256, and verified package identity. Never reuse an older APK merely because it exists.
- Unsupported: if the project cannot produce Web or Android APK output, write `unsupported` and call `fail --outcome unsupported`; do not relabel source files or another artifact type as Ready.

Write complete command output to the Bridge-issued `logPath` using the project's safe logging approach. Keep event summaries short; never copy logs into events.

## Failure and recovery

- Bridge missing, incompatible, or unsupported before `begin`: stop and direct the user to Porta's Agent Bridge management. Do not download or replace Bridge.
- Unknown `begin` result: reuse the same Run key. Do not generate a second key.
- Unknown mutation result: reuse the same operation key with identical input.
- `preview_busy`: keep the current WorkRun and operation key. Ask the user to stop the existing Preview in Porta, then retry; never replace it by cwd or recency.
- `manifest_missing` or `manifest_invalid`: fix the exact manifest, then retry the same Ready/Fail command.
- `work_run_not_found`: the retained WorkRun has expired or disappeared. Report that fact; create a new Run key only if the user still explicitly requests a new Workflow.
- Preview process cannot survive Agent exit: write a failed manifest and call `fail --outcome failed --reason-code preview_process_failed`. Do not emit Ready for a listener that will be reclaimed with the current tool session.
- User stop: call `stop` for the exact Run key. Interrupt a process only when this invocation recorded its exact ownership; otherwise report that monitoring stopped without claiming the process exited.
- Failed/unsupported terminal: write the matching terminal manifest first. If the manifest cannot be written or validated, report that the terminal event was not accepted.

## Privacy and ownership

Bridge events accept semantic state, not arbitrary telemetry. Never place prompts, transcripts, secrets, tokens, environment values, raw commands, log text, manifest data, artifact content, project paths, or Provider Session IDs into progress summaries or reason codes.

The skill and client do not install Skills, manage Scene Packs, inspect Porta accounts, or invoke Cloud APIs. They do not create Bridge IDs, edit Bridge journals, replace other Previews, or interpret App notifications as authority.
