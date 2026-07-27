---
name: porta-workflow
description: Use only when the user explicitly invokes Porta Workflow to build, run, repair, or stop a Porta Product Preview for the current project; do not use for ordinary development or implicit preview requests.
---

# Porta Workflow

## Overview

Complete the user's project task and publish its verified Web or Android APK result through Porta. Let repository evidence determine how to implement, build, test, and run the project; use the bundled client only for the fixed Agent Bridge protocol.

## Activation gate

- Continue only when the current user message explicitly invokes or names Porta Workflow. Installation, a Scene Pack, an App reminder, or an ordinary preview request is not activation.
- Never create a WorkRun merely because this skill is installed or discovered.
- Do not check Porta login, PRO status, Cloud Relay, or account credentials. Those are App-owned concerns.

## Workflow

1. Resolve this skill directory and read [references/bridge-workflow-v1.md](references/bridge-workflow-v1.md) completely before the first Bridge call.
2. Run the bundled client's `capabilities` command. If Bridge is missing, incompatible, or unsupported, stop the Workflow and tell the user to repair Agent Bridge from Porta. Do not install or upgrade Bridge yourself.
3. Generate one Run key, record it, and call `begin` once. Reuse that key after uncertain output; never invent or infer a WorkRun, request, trace, manifest, or log identity.
4. Inspect the repository and choose the smallest project-native implementation, verification, build, and process-lifecycle approach. Do not impose a framework, package manager, port, or build command.
5. Emit bounded progress at meaningful phase changes. Use `attention` only when user input is genuinely required; keep the full question in the terminal conversation.
6. Call `preview-start` only when artifact preparation actually begins. Write build output to the exact returned log path and create manifests only through the bundled client.
7. Publish `preview-ready` only after a Web endpoint is live and probed or an APK is freshly built, hashed, and identified. On failure or unsupported output, write the matching terminal manifest before calling `fail`.
8. On an explicit stop, stop only the exact WorkRun and only processes proven to belong to this invocation. Never target a recent or same-project Preview by guesswork.

## Hard boundaries

- Treat `workRunId` as the sole Workflow aggregate identity. Keep the same identity for the whole run.
- Reuse an operation key only for an exact retry. Use a new operation key for a new progress or attention update.
- Never send secrets, prompts, transcripts, command output, environment values, project paths, manifest content, or artifact content as event fields.
- Never send Ready for a stale file, dead server, failed build, unsupported artifact, or merely generated source.
- Never commit `.porta/` runtime files unless the user's repository explicitly owns them.
- If Bridge rejects a transition, preserve the exact Run key and receipt, fix the underlying condition, and retry only when the command remains semantically valid.

## Client

Run `node <skill-directory>/scripts/porta-workflow.mjs --help` for the command surface. Treat its JSON output as the only client-side identity source; the Bridge receipt and App-side manifest validation remain authoritative.
