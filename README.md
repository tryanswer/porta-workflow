# Porta Workflow

Porta Workflow is an explicit-invocation Agent Skill that lets Codex, Claude Code, or Gemini CLI publish a verified Web or Android APK product preview through Porta's Agent Bridge.

The installable package is [`porta-workflow/`](porta-workflow/). Installation alone never starts a Workflow; the user must explicitly activate the Skill in the current Agent.

## Install

The normal path is to send Porta's built-in Porta Workflow installation scene to the exact active Agent terminal. The scene pins a release tag and full commit SHA, asks the Agent to verify both, and installs only the `porta-workflow/` subdirectory at user scope.

For manual inspection, clone the fixed release before using the Agent's native user-level mechanism:

```bash
git clone --branch porta-workflow-v0.1.0 --single-branch https://github.com/tryanswer/porta-workflow.git
cd porta-workflow
git rev-parse HEAD
```

Compare the resolved commit with the full SHA shown by Porta. Do not install from a moving branch.

- Codex: install `porta-workflow/` as the user skill `porta-workflow`, then invoke `$porta-workflow`.
- Claude Code: install `porta-workflow/` as the user skill `porta-workflow`, then invoke `/porta-workflow`.
- Gemini CLI: install the checked-out local directory with `gemini skills install ./porta-workflow --scope user`, then explicitly ask Gemini to use Porta Workflow and confirm activation.

## Boundaries

- The Skill uses the Agent Bridge already installed and managed by Porta; it never installs or upgrades Bridge itself.
- The Skill does not read Porta login, subscription, Cloud, or account credentials.
- A Preview becomes Ready only after the artifact and request-scoped manifest pass Bridge and App validation.
- WorkRun identity, event privacy, idempotency, and failure handling are defined in the bundled reference and enforced by the bundled client.

## License

MIT. See [LICENSE](LICENSE).
