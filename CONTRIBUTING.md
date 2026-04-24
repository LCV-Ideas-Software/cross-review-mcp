# Contributing to cross-review-mcp

Thanks for your interest. This project uses its own protocol as the contribution model: substantive changes are **cross-reviewed by three peers** before being merged. That discipline is the product; applying it to the project itself is non-negotiable.

The full normative protocol is at [`docs/workflow-spec.md`](./docs/workflow-spec.md). This document is the operational pointer.

---

## Before you start

1. **Read the spec** — at minimum `§2` (STATUS protocol), `§6.3` (N-ary convergence), `§6.9` (mandatory tri-tool), `§6.11`–`§6.14` (the v4.9 / v4.10 / v4.11 normative additions), and `§7` (quick-reference).
2. **Read `AGENTS.md`** — it defines the contract for AI agents operating inside this repo.
3. **Install the three peer CLIs** and confirm `npm test && npm run check-models` both GREEN on a fresh clone.
4. **Open an issue first** for anything larger than a bug fix. Issues are cheap; let's align before you write code.

---

## Contribution classes

Contributions fall into three classes. Each has a different review bar.

### Class 1 — Trivial fixes

- Typos in docs/comments.
- Test-only additions that exercise existing behavior.
- Dead-code removal verified by the smoke suite.
- `check-models` advisory bumps (updating `last_verified` timestamps).

**Bar:** single maintainer review. Standard PR. Gates green.

### Class 2 — Bug fixes + additive implementation

- Fixing a bug where existing behavior diverges from the spec.
- Implementing deferred scope that was already ratified in a prior approved cross-review session (spec `§8` tracks which items are pre-ratified).
- Adding new test coverage for existing code paths.
- Additive fields to existing JSON envelopes that preserve backward-compat.

**Bar:** single maintainer review + passing gates. PR description must:
- Cite the spec section being implemented (e.g. "executes v4.10 §6.14 Item D as scoped in session c9508617's deferred set").
- Include before/after smoke step counts.
- Confirm no regressions to existing pass-list.

### Class 3 — Normative changes

- New spec sections.
- Changes to the convergence predicate or denominator rule.
- Changes to the protocol contract visible to peers (new/renamed structured fields, new tool surfaces, new failure classes that peers are expected to produce).
- Changes to model pins (requires updating `docs/top-models.json` and passing `check-models`).
- Changes to peer transport (billing-bearing — see `feedback_subscription_over_api_billing.md` in workspace memory).

**Bar:** **trilateral cross-review session required before PR merge**. The process:

1. Open a cross-review session with `session_init(task: "<concise description>", artifacts: [<paths>])` as any one of the three peers.
2. Run `ask_peers` with a concrete proposal. Reviewers respond with READY / NOT_READY / NEEDS_EVIDENCE per `§2`.
3. Reconcile across rounds until caller + both peers declare READY in the same round.
4. Call `session_finalize(outcome: 'converged')`.
5. Record the session UUID, commit SHAs, and approval trail in `docs/workflow-spec.md §8` (the acceptance-criteria log).
6. PR description must cite the session UUID.
7. Implementation-ratified releases are acceptable when the scope was PRE-ratified in a prior approved session (`§8` v4.5 preamble rule). Do NOT use "implementation-ratified" for new design decisions.

The operator and maintainers MAY also require escalations via `escalate_to_operator` for questions that peer exchange cannot resolve (spec `§6.14` Item D).

---

## Quality gates

Every PR must pass both gates locally and in CI:

```bash
npm test              # 117+ smoke steps; add new assertions if you add public behavior
npm run check-models  # advisory drift + staleness + fallback_chain invariant audit
```

### When gates block you

- **Smoke regression.** Debug the specific step that failed. Do NOT disable assertions to unblock merge. `feedback_fix_dont_remove.md` (workspace memory) applies here: fix the root cause, never remove checks to silence warnings.
- **check-models drift.** If you bumped a pin in `src/lib/peer-spawn.js` without updating `docs/top-models.json`, fix the JSON in the same PR. If you intentionally changed the pin, the PR must also cite a ratifying session (see Class 3).
- **check-models staleness.** Bumping `last_verified` in `top-models.json` is allowed without a ratifying session IF the model id hasn't changed (you're just attesting that the pin is still valid).

---

## Operational non-negotiables

These are workspace-level rules codified in memory and enforced by convention:

- **Tri-tool stack is mandatory for substantive work.** Ultrathink + code-reasoning + cross-review. See spec `§6.9.1` and `feedback_tri_tool_internal_to_mcp.md`. One of the three alone is NOT sufficient for Class 3 changes.
- **Top-level models only, no silent fallback.** Spec `§6.9.2`. Peer spawn invokes the top-tier model explicitly via `-m`. Tier resilience (§6.9.3) is audited, not silent.
- **CLI transport, not SDK.** Peer transport stays on CLI (subscription-billed) per `feedback_subscription_over_api_billing.md`. Migrating to official SDKs switches billing to per-token API metering and is vetoed.
- **Strict-only convergence.** Spec `§6.12`. `status_missing` counts AGAINST. No loose-mode toggle.
- **No fabrication.** Spec `§6.14`. If you lack verified information, answer with `NEEDS_EVIDENCE` and concrete `caller_requests` — never fill gaps with plausible-sounding guesses.
- **ASCII-only on disk + en-US for peer-exchange + non-user-facing artifacts.** Spec `§6.4` + `§6.10`. User-facing prose (README.pt-BR.md, CHANGELOG, operator-directed chat) MAY stay in pt-BR; everything the peer consumes MUST be en-US ASCII.
- **No secrets in repo.** Full-history scan completed 2026-04-24 is clean. Before any large-visibility event (GitHub public, package publishing), re-run a secrets scan. If a finding is a test fixture, it lives in the R14 redaction corpus in `scripts/functional-smoke.js` — do NOT promote fixtures to real-shaped values.

---

## Commit style

- Follow the existing commit message format (see `git log --oneline -20` for examples).
- English (en-US) for the summary line; body may include pt-BR only when quoting operator directives verbatim.
- For Class 3 PRs, cite the ratifying session UUID + the spec delta in the body.
- Co-author attribution is encouraged:
  ```
  Co-Authored-By: <Peer Agent> <noreply@anthropic.com>
  ```

---

## Reporting bugs

Open a GitHub issue with:

- Expected behavior (citing the spec section).
- Observed behavior (with `meta.json` excerpt from `~/.cross-review/<session-id>/` when relevant; redact any secrets the R14 pass missed and report as a security issue separately).
- Minimal reproducer.
- `node --version`, `npm --version`, OS, and the three peer CLI versions.

For security issues, please follow **[SECURITY.md](./SECURITY.md)** (report privately to `alert@lcvmail.com`; do NOT open a public issue).

---

## Code of conduct

This project follows **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** (Contributor Covenant 2.1). Participation requires agreement.

---

## Questions

Open a GitHub issue tagged `question`. For design-level questions that warrant a cross-review session, open the session instead and reference the issue from the session prompt.
