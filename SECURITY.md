# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this repository, please do **not** open a public issue. Instead, please report it privately to the repository maintainer.

**Contact:** alert@lcvmail.com

Please include:
- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if you have one)

We will acknowledge your report within 24 hours and work to resolve the issue promptly.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅ |
| Previous releases | ⚠️ Security updates only |

## Security Measures

This repository employs:
- **Code Scanning (CodeQL)**: Automated static analysis on all commits
- **Dependency Scanning (Dependabot)**: Automated dependency vulnerability detection
- **Secret Scanning**: Detection and remediation of exposed secrets
- **Branch Protection**: Required status checks before merge to main

## Threat Model

`cross-review-v1` is designed for a **single-user trusted host** (workflow-spec §6.21). Inputs from operator/peer are not adversarial; the orchestrator runs CLIs that the operator already trusts (Claude Code, Codex CLI, Gemini CLI) and an embedded DeepSeek wrapper authenticated by `DEEPSEEK_API_KEY`. Outside this model the following caveats apply:

- **Multi-host concurrency.** Running two MCP host instances of `cross-review-v1` against the same `~/.cross-review/` directory is **not supported**. Each instance acquires `<session-id>/.lock` via atomic `mkdir`, which is correct on a single host, but the lock TTL + PID-liveness fallback can leave a narrow TOCTOU window when two hosts contend for the same session. If you need multi-host operation, point each instance at a distinct state directory via `CROSS_REVIEW_STATE_DIR` (introduced in v1.6.7) or share one host across all clients.
- **Untrusted callers.** The MCP `tools/list` schema enforces per-field caps (`maxLength`, `maxItems`, `pattern`) since v1.6.7 to defend against memory-exhaustion attempts via oversized `prompt`/`task`/`content`. Server-side store also rejects oversized payloads independently. The trust boundary, however, still assumes a cooperative caller — do not expose the stdio transport over a network socket without an authenticating proxy.
- **Untrusted peers.** Peer responses are parsed with strict tail-anchored grammars and a 64 KiB cap on the structured `<cross_review_status>` payload (v1.6.7). A misbehaving peer cannot OOM the orchestrator through that channel, but it can still emit unbounded stdout up to `PEER_STREAM_MAX_BYTES` (4 MiB) before the spawn is killed.
- **Filesystem.** The state root is symlink-resistant (`fs.realpathSync` + lexical containment). Custom `CROSS_REVIEW_STATE_DIR` paths must be writable only by the operator; the orchestrator does not enforce ACLs on the override target.
- **Codex sandbox bypass.** `CROSS_REVIEW_CODEX_BYPASS=1` is an opt-in workaround for a Codex CLI Windows bug; using it removes Codex's sandbox. Do not enable on shared hosts.

## Best Practices

- Keep dependencies up-to-date
- Use strong authentication (SSH keys, personal access tokens)
- Review pull requests carefully before merge
- Report any suspicious activity immediately
