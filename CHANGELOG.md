# CHANGELOG — cross-review-mcp

Histórico de mudanças do servidor MCP de cross-review bilateral entre Claude Code e ChatGPT Codex.

**Convenção de versão:** SemVer para código (`package.json` `version` + `src/server.js` MCP identity). O versionamento da spec (`docs/workflow-spec.md`) tem seu próprio ciclo (v2/v3/v4/v4.1/.../v4.6) documentado internamente; releases spec-only NÃO bumpam o código.

**Convenção de seções:** Adicionado / Alterado / Corrigido / Removido por release, em ordem cronológica reversa (mais recente primeiro).

---

## [Unreleased]

### Adicionado
- (em aberto)

### Alterado
- (em aberto)

### Corrigido
- (em aberto)

### Removido
- (em aberto)

---

## Infra e operacional (2026-04-24)

**Sistema de versionamento, CHANGELOG e memórias de agentes AI** adicionados seguindo o padrão dos demais repositórios do workspace lcv.

### Adicionado
- `CHANGELOG.md` (este arquivo) — histórico de mudanças.
- `.ai/memory.md`, `.ai/GEMINI.md` — memórias de contexto para agentes AI (formato paralelo aos outros repos do workspace).
- `.github/copilot-instructions.md` — diretivas do Copilot.
- `AGENTS.md` — pointer global às memórias AI do projeto.

### Alterado
- Discipline de versionamento formalizada: releases spec-only tracam no CHANGELOG por versão de spec (v4.1/v4.2/v4.3/v4.4/v4.5/v4.6); releases de código tracam via SemVer de `package.json`.

---

## GitHub activation (commits `23fb1b1`, `3acccc2`, `e5ec531` — 2026-04-24)

### Adicionado
- GitHub remote em `https://github.com/lcv-leo/cross-review-mcp` (privado).
- `.github/workflows/ci.yml` — Actions workflow que roda `npm run smoke` + `npm run check-models` em push/PR para `main`.
- `.github/dependabot.yml` — Dependabot configurado para `npm` + `github-actions` weekly (segunda 06:00 America/Sao_Paulo), 5 PRs/ecosystem cap.
- `LICENSE` (AGPL-3.0) importado do remote template.
- `SECURITY.md` importado do remote template (política de report privado).

### Alterado
- Actions atualizadas para `actions/checkout@v5` + `actions/setup-node@v5` (compatível com Node.js 24); workflow usa Node 22 LTS (antes Node 20, deprecated).
- History reescrita via `git filter-branch` substituindo `leonardocardozovargas@gmail.com` por `268063598+lcv-leo@users.noreply.github.com` em 15 commits, após GitHub rejeitar push inicial com `GH007: Your push would publish a private email address`.

### Corrigido
- Primeira CI run (`24875620870`) passou com warning Node 20 deprecation — corrigido imediatamente em `e5ec531` (bump actions + Node 22).

---

## Relocação do repositório (commit `983472f` — 2026-04-24)

Repositório movido de `C:/Scripts/cross-review-mcp/` para `C:/Users/leona/lcv-workspace/cross-review-mcp/` por diretiva do usuário.

### Alterado
- `README.md` — 5 referências de path atualizadas (Codex TOML, VS Code JSON, `claude mcp add`, `npm install cd`, `reviewer-minimal mcp-config` arg).
- Companion changes operacionais (fora do repo):
  - 4 MCP configs atualizadas: Claude Code workspace (`lcv-workspace/.mcp.json`), VS Code (`lcv-workspace/.vscode/mcp.json`), Antigravity (`~/.gemini/antigravity/mcp_config.json`), ChatGPT Codex (`~/.codex/config.toml`).
  - 7 memory files do Claude Code user com novo path.

---

## v4.6 — Language policy + bulk en-US migration (commits `6f7c607`, `d0998b5`, `f9ddf93`, `9904fd9` — 2026-04-24)

Spec-only. Zero toque em runtime (`src/server.js`, `src/lib/*.js`, `scripts/functional-smoke.js` imutáveis). Sessão cross-review `b1700438`, 5 rodadas, `outcome=converged`.

### Adicionado
- **§6.10 "Language policy for peer exchange and internal artifacts"** em `docs/workflow-spec.md`. Clausula normativa: todo peer exchange (prompts `ask_peer`, respostas do peer, transcripts em `~/.cross-review/`) + artefatos não-user-facing do cross-review-mcp (corpo da spec, scripts tooling + comments, campos `description`/`notes` de JSON, memórias do projeto, reports) DEVEM ser en-US. Autoriza bulk translation de conteúdo pt-BR pré-existente sem cross-review per-artifact.
- Exceções escopadas em §6.10: (a) chat assistant-user; (b) entradas historicamente seladas em §8 v4-v4.6 (não-retroativas); (c) documentos explicitamente user-facing (PR descriptions, CHANGELOG entries).

### Alterado
- Título da spec `v4.2` → `v4.6`; novas delta sections `0f` (v4.5→v4.6), `0e` (v4.4→v4.5), `0d` (v4.3→v4.4), `0c` (v4.2→v4.3).
- Corpo da spec (§§0-7) traduzido pt-BR → en-US mantendo fidelidade semântica.
- Comments/JSDoc de `src/server.js`, `src/lib/peer-spawn.js`, `src/lib/status-parser.js`, `src/lib/session-store.js`, `scripts/functional-smoke.js`, `scripts/audit-model-drift.js`, `scripts/probe-reviewer-isolation.js` traduzidos.
- `docs/top-models.json` campos `description` + `notes` traduzidos.
- `docs/reports/post-reload-cycle-2026-04-24.md` traduzido.
- `audit-model-drift.js`: variável `cravadas` renomeada para `pinned` (consistência EN).
- §7 table header + row labels traduzidos; §8 narrative "Uma vez aceita..." → "Once accepted..." traduzido; §8 follow-ups list traduzida + pruned (items fechados em v4.3/v4.4/v4.5 removidos).

### Corrigido
- Follow-up "Normalize historical non-ASCII drift (U+00A7)" marcado RESOLVED no §8 pós-v4.6 (commit `9904fd9`). Pré-v4.6: 24 ocorrências. Pós-v4.6: 1 (dentro de §8 sealed entry v4.2, preservada por §6.10 exception (b)).

---

## v4.5 — Em-revalidacao → aprovada pattern (commit `c6fc376` — 2026-04-24)

Spec-only. Sessão cross-review `843d57eb`, 3 rodadas, `outcome=converged`.

### Adicionado
- Preâmbulo editorial normativo em §8 `docs/workflow-spec.md`. Regra: entradas usando linguagem de aprovação bilateral SÓ PODEM ser gravadas em disco APÓS bilateral READY confirmado via `session_check_convergence`. Durante sessão (pre-sealing), usar "em revalidacao bilateral (sessao XXX, iniciada DATA)". Promoção para "aprovada bilateralmente" exige edit separado pos-sealing. Não-retroativa.

### Alterado
- Entrada §8 v4.5 autofollow o próprio padrão: edit inicial com "em revalidacao bilateral", promoção separada pós-sealing, ambos compostos em um commit.

---

## v4.4 — Schema v5 YAGNI-suspend (commit `47ffab9` — 2026-04-24)

Spec-only. Sessão cross-review `bd8c3cfb`, 2 rodadas, `outcome=converged`. Convergência mais rápida do ciclo.

### Alterado
- Follow-up original "caller_requests/follow_ups como arrays de objetos" substituído em §8 por YAGNI-suspension + critério de reabertura objetivo: "um peer v4-era nomeando UM caller_request concreto que tenha FALHADO por limitação de string". "Poderia ser melhor como objeto" NÃO conta.

---

## v4.3 — Drift audit advisory + tooling (commit `1553e65` — 2026-04-24)

Spec-only + tooling (zero toque em runtime). Sessão cross-review `9c56005b`, 4 rodadas, `outcome=converged`.

### Adicionado
- Nova subseção §6.9.2.1 "Model drift audit" em `docs/workflow-spec.md`. Advisory-only; não autoriza fallback silencioso, override, auto-selection, ou troca de ID sem bump + spec edit per §6.9.2.
- `docs/top-models.json` — fonte documental curada pelo usuário com entries por provider (`id`, `reasoning_effort?`, `validated_at`, `ref_url`, `notes`) + `staleness_threshold_days` global (default 30).
- `scripts/audit-model-drift.js` — script Node zero-deps. Lê `peer-spawn.js` via `fs.readFileSync` + regex fixos, compara contra `top-models.json`, emite exit codes 0 (OK) / 1 (drift ID ERROR) / 2 (staleness WARN) / 3 (erro estrutural).
- `package.json` — npm script `check-models`: `node scripts/audit-model-drift.js`.

---

## Alinhamento de versão (commit `382b7a8` — 2026-04-24)

Item 3 do ciclo pós-reload. Sessão cross-review `42130c72`, 2 rodadas, `outcome=converged`.

### Corrigido
- `package.json` version alinhada de `0.3.0-alpha` → `0.4.0-alpha` para bater com `src/server.js:48` (identidade MCP autoritativa).
- `package-lock.json` version alinhada de `0.2.0-alpha` → `0.4.0-alpha` (top-level + `packages[""]`).
- Técnica: `npm version 0.4.0-alpha --no-git-tag-version`. Side-effect cosmético em `bin` field revertido manualmente (diff final: exatamente 3 campos de version).

---

## v4.2 — Evidence matrix normativa (commit `9fdfef3`)

Spec-only. Sessão cross-review `f1fdbee4`, 5 rodadas, `outcome=converged`.

### Alterado
- §6.7 "Minimal evidence matrix per artifact class" promovida de FOLLOW-UP para normativa. Matriz tabular cobrindo JS, TS, JSON, Markdown, e o próprio cross-review-mcp.

---

## v4.1 — Overflow policy normativa (commit `1716c57`)

Spec-only. Sessão cross-review `a847f897`, 7 rodadas, `outcome=converged`.

### Alterado
- §6.6 "Overflow / truncamento" promovida de FOLLOW-UP para normativa. 4 subseções: 6.6.1 Transcript, 6.6.2 Ledger, 6.6.3 meta.json, 6.6.4 Non-destructive compression.
- §6.5 Ledger "suavizada" de linguagem obrigatória para opcional (evidência empírica: nenhum ledger produzido em uso real até 2026-04-24).

---

## [0.4.0-alpha] (commit `d5bc04e` — 2026-04-24)

Spec v4 normativa. Sessão cross-review `08cd61e6`, 2 rodadas, `outcome=converged`.

### Adicionado
- Schema JSON expandido do bloco estruturado (§2.3.1): campos opcionais `uncertainty`, `caller_requests`, `follow_ups` validados per-field com omit-unless-signal.
- `parser_warnings` + `peer_model` no contrato de retorno do parser (§5).
- §6.9 "Ferramentas complementares obrigatórias": 6.9.1 Tri-tool (cross-review + ultrathink + code-reasoning mandatórios pre-session_init) e 6.9.2 Modelo top-level (Codex=`gpt-5.5 xhigh`, Claude=`claude-opus-4-7`; sem fallback silencioso).

### Alterado
- `src/lib/status-parser.js` — validação per-field com whitelist de campos; unknown fields dropped com warning.
- `src/lib/peer-spawn.js` — flags de modelo explícitas em `buildCodexArgs` / `buildClaudeArgs`.

---

## v3 (commit `12cbcdd`)

Spec-only. Sessão cross-review `806a1c4f`, 3 rodadas.

### Adicionado
- §2.1 reescrita: contrato de STATUS ancorado no tail da resposta (ultima linha não-vazia). `NEEDS_EVIDENCE` adicionado ao enum.
- §2.2 Anchor posicional ("o que estiver no final vence").
- §2.3 bloco estruturado `<cross_review_status>{...}</cross_review_status>` como forma preferida (implementado em v0.3.0-alpha).
- §2.4 falha silenciosa do bloco estruturado.
- §6.3 `NEEDS_EVIDENCE` como estado peer-only canônico.
- §3.5 limitação operacional de sandbox do peer.

---

## [0.3.0-alpha] (commit `1d106f0`)

### Adicionado
- Initial commit do cross-review-mcp. Implementação MVP: 5 tools MCP (`session_init`, `session_read`, `session_check_convergence`, `session_finalize`, `ask_peer`), parser STATUS via regex legacy `STATUS: X`, spawn contido de peers (Codex `-a never -s read-only`, Claude `--permission-mode default --strict-mcp-config`), session state em `~/.cross-review/<uuid>/`, smoke tests E2E.

---

## Referências cruzadas

- Spec normativa vigente: `docs/workflow-spec.md` v4.6.
- Relatórios consolidados: `docs/reports/post-reload-cycle-2026-04-24.md` (ciclo de 5 items), `docs/reports/full-project-report-2026-04-24.md` (relatório abrangente).
- Testes: `scripts/functional-smoke.js` (60 steps, `npm run smoke`).
- Auditoria advisory: `scripts/audit-model-drift.js` (`npm run check-models`).
