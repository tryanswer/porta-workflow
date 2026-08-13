# Porta Workflow

Porta Workflow is an Agent Skill for Codex, Claude Code, and Gemini CLI. It publishes one verified Static HTML Product through Porta Workflow v2, and retains Workflow v1 only for an explicitly requested legacy Web or Android APK Product Preview.

The installable package is [`porta-workflow/`](porta-workflow/). Installation, discovery, reload, or a Scene readiness receipt never starts a Workflow. A v2 WorkRun requires an unambiguous current user request to publish a concrete result to Porta; ordinary development, build, preview, installation, and ambiguous ship/deploy language do not authorize publication.

## Install

The normal path is to send Porta's built-in Porta Workflow installation scene to the exact active Agent terminal. The scene pins a release tag and full commit SHA, asks the Agent to verify both, and installs only the `porta-workflow/` subdirectory at user scope.

For manual inspection, clone the fixed release before using the Agent's native user-level mechanism:

```bash
git clone --branch porta-workflow-v2.4.1 --single-branch https://github.com/tryanswer/porta-workflow.git
cd porta-workflow
git rev-parse HEAD
```

Compare the resolved commit with the full SHA shown by Porta. Do not install from a moving branch.

For an existing user-level installation, the Scene Agent must not use a Provider's overwrite behavior as the update transaction. From the clean exact helper-release checkout it runs the bundled `porta-workflow/scripts/porta-workflow-skill-activation.mjs` helper with the catalog repository, exact install/update/rollback intent, annotated helper/source/target tags, full SHAs, and current Provider. Fresh install requires an absent destination; update or rollback first proves the active tree is the exact approved source release. The helper stages the complete target Git subdirectory beside the Provider Skill directory and restores that source tree if activation fails before settlement. A newer helper checkout can therefore perform an approved rollback to an older target without trusting an updater bundled in that target. See [`skill-activation.md`](porta-workflow/references/skill-activation.md).

- Codex: fresh install at user scope, then use a new Agent session for discovery.
- Claude Code: install at user scope, then use its native Skill reload.
- Gemini CLI: fresh install at user scope, then use `/skills reload`.

The recoverable helper currently supports macOS, Linux, and WSL. Native Windows updates fail closed until equivalent directory settlement and recovery evidence is implemented. Installation success is not discovery evidence; the Agent reports `ready` only after the separate Provider reload/new-session lifecycle observes the exact release.

Explicit `$porta-workflow`, `/porta-workflow`, or equivalent Provider activation remains supported. Natural-language selection is allowed only when the current message itself contains unambiguous publication intent and trusted current Porta/Bridge context identifies Porta as the release target.

## Verify

Run the public release identity contract together with the installable Skill tests:

```bash
node --test tests/*.test.mjs porta-workflow/tests/*.test.mjs
```

## Boundaries

- The Skill uses the Agent Bridge already installed and managed by Porta; it never installs or upgrades Bridge itself.
- Workflow v2 requires Agent Bridge Runtime 1.14.0 or newer plus the
  `static-html-release` and `porta.workflow.event-loop.v2` capabilities.
- Neutral Scene readiness additionally requires Runtime 1.16.1 or newer and the
  `scene-pack-readiness-observe` command.
- The Skill does not read Porta login, subscription, Cloud, or account credentials.
- A v2 release becomes Ready only after frozen candidate validation, durable transfer, activation, and the Web Release public probe succeed.
- Scene readiness is an Agent-observed UX claim, not installation attestation, integrity proof, entitlement, Product binding, or publication authority.
- WorkRun identity, event privacy, idempotency, and failure handling are defined in the bundled reference and enforced by the bundled client.

## License

MIT. See [LICENSE](LICENSE).
