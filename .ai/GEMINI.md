<!-- AI-SYNC: managed by C:\Scripts\ai-sync.js -->

## DIRETIVAS DO PROJETO E REGRAS DE CODIGO
# Regras
- Use princípios de Clean Code.
- Comente lógicas complexas.

## MEMORIA DE CONTEXTO (CROSS-REVIEW-MCP)

# .ai/memory.md — cross-review-mcp

Memória contextual detalhada do projeto cross-review-mcp para agentes AI (Claude Code, Copilot, Gemini, Codex) que venham a trabalhar no repo.

**Formato paralelo aos demais `.ai/memory.md` do workspace lcv.**

---

## Papel e escopo

cross-review-mcp é um servidor MCP stdio que orquestra sessões de cross-review bilateral entre dois agentes AI — normalmente Claude Code e ChatGPT Codex — cada um revisando o trabalho do outro até convergência bilateral (ambos `READY`) ou impasse explícito (`aborted`).

- Caller: agente em foreground (quem abriu a sessão).
- Peer: agente complementar spawned pelo caller via `ask_peer` com sandbox contido.
- Identidade de caller/peer é determinada por env var `CROSS_REVIEW_CALLER` (`claude` | `codex`).

---

## Estado atual (2026-04-24)

- **Versão do código:** `v0.4.0-alpha` (semver, exposto via `new Server({ version: '0.4.0-alpha' })` em `src/server.js:48`). Pinado em `package.json` + `package-lock.json`.
- **Versão da spec:** `v4.6` (`docs/workflow-spec.md`). Sealed bilateral na sessão `b1700438` (2026-04-24, 5 rodadas).
- **Repo:** branch `main`, HEAD posterior aos commits desta atualização. Remote: `github.com/lcv-leo/cross-review-mcp` (privado).
- **CI:** GitHub Actions ativo, rodando `npm run smoke` + `npm run check-models` em push/PR.
- **Dependabot:** npm + github-actions, schedule weekly segunda 06:00 America/Sao_Paulo.
- **Location:** `C:/Users/leona/lcv-workspace/cross-review-mcp/` (movido de `C:/Scripts/` em 2026-04-24).

---

## Arquivos-chave

| Path | Propósito |
|------|-----------|
| `src/server.js` | MCP server entry. 5 tools: session_init, session_read, session_check_convergence, session_finalize, ask_peer. |
| `src/lib/peer-spawn.js` | Spawn contido do peer CLI com flags de modelo top-level explícitas (Codex=`gpt-5.5 xhigh`, Claude=`claude-opus-4-7`). |
| `src/lib/status-parser.js` | Parser do bloco `<cross_review_status>{...}</cross_review_status>` tail-anchored + fallback legacy `STATUS: X`. Validação per-field do schema v4. |
| `src/lib/session-store.js` | State atômico em `~/.cross-review/<uuid>/` (meta.json + round-NN files). Lock via mkdir + TTL. |
| `scripts/functional-smoke.js` | 60 steps E2E. `npm run smoke`. |
| `scripts/audit-model-drift.js` | Advisory drift-audit (§6.9.2.1). `npm run check-models`. |
| `docs/workflow-spec.md` | Spec normativa atualmente em v4.6. Fonte única de verdade para protocolo + diretivas operacionais. |
| `docs/top-models.json` | Fonte documental curada de IDs top-level (v4.3, advisory). |
| `docs/reports/full-project-report-2026-04-24.md` | Relatório consolidado da trajetória 2026-04-24. |
| `reviewer-configs/` | peer-exclusions.json (MCPs/apps desabilitados no spawn do peer) + reviewer-minimal.mcp.json (MCP mínimo para peer). |

---

## Diretivas normativas mandatórias (aplicáveis a qualquer trabalho neste repo)

### Encoding e linguagem (§6.4 + §6.10)
- ASCII-only em arquivos em disco. Transliteração de acentos quando a fonte textual original tiver.
- **Peer exchange + artefatos internos em en-US** (`workflow-spec.md` body, scripts, comments, memórias do projeto, reports). Chat assistant-user permanece pt-BR. Entradas §8 historically-sealed (v4-v4.6) preservadas em pt-BR (não-retroativas).

### Tri-tool mandatório (§6.9.1)
- Antes de qualquer `session_init` de cross-review, caller DEVE ter trace visível em ultrathink + code-reasoning justificando escopo/plano/critérios de sucesso. Sessão "fria" é violação operacional.
- Durante `ask_peer`, prompts DEVEM pedir o mesmo rigor ao peer.
- Entre rodadas, rodar ultrathink/code-reasoning sobre a resposta do peer antes do próximo prompt.
- Custo/latência NÃO são alvos de otimização — `feedback_cross_review_priorities.md` aplica.

### Modelo top-level (§6.9.2)
- Peer spawned com flag de modelo explícita: Codex=`gpt-5.5` + `model_reasoning_effort=xhigh`; Claude=`claude-opus-4-7` (ID completo, não alias).
- SEM fallback silencioso: se top-level falhar, abortar sessão explicitamente.
- Troca de modelo exige bump de release + edição explícita de §6.9.2 na spec.
- Auditoria: cada round persistido em `meta.json.rounds[i].peer_model`.

### Em-revalidacao → aprovada (§8 preâmbulo v4.5)
- Entradas §8 com linguagem "Spec vX.Y foi aprovada bilateralmente..." SÓ PODEM ser gravadas em disco APÓS `session_check_convergence` retornar `converged=true`.
- Durante sessão, usar "em revalidacao bilateral (sessao XXX, iniciada DATA)".
- Promoção para "aprovada bilateralmente" via edit separado pós-sealing.
- Regra não-retroativa — entradas historically sealed preservadas.

### Immutabilidade do runtime
- `src/server.js`, `src/lib/*.js`, `scripts/functional-smoke.js` só mudam em bumps coordenados de release.
- Comments/JSDoc podem ser editados (sem semantic change).
- `peer-spawn.js` IDs de modelo hard-coded por design (§6.9.2) — troca exige bump + spec edit.

### Spec edits exigem sessão cross-review
- Qualquer mudança em `docs/workflow-spec.md` que toque diretiva normativa passa por `session_init` → rodadas → `session_check_convergence` → `session_finalize`.
- Exceção autorizada em §6.10: bulk translation de conteúdo pt-BR → en-US em commits de housekeeping referenciando §6.10.

---

## Gates obrigatórios (antes de commit)

- `npm run smoke` → deve retornar `[functional-smoke] 60 steps, all GREEN`.
- `npm run check-models` → deve retornar `OK: no drift, no staleness` (exit 0).
- Se GitHub remote atualizado, CI em Actions também precisa passar.

---

## Follow-ups abertos (pós-v4.6)

1. **Defensive pre-spawn existence check**: abort-only se ID cravado for descontinuado pelo provider. Fora de escopo de §6.9.2.1 advisory. Registrado em sessão `9c56005b`.
2. **Schema v5 com objetos para `caller_requests`/`follow_ups`**: SUSPENDED por YAGNI (sessão `bd8c3cfb`, v4.4). Critério de reabertura objetivo: peer v4-era nomeando UM caller_request concreto que tenha FALHADO por limitação de string.

---

## Histórico resumido (para contexto)

Trajetória da spec: v2 (sessão `7d745f38`) → v3 (sessão `806a1c4f`) → v4 (sessão `08cd61e6`, junto com código v0.4.0-alpha) → v4.1 (sessão `a847f897`) → v4.2 (sessão `f1fdbee4`) → v4.3 (sessão `9c56005b`) → v4.4 (sessão `bd8c3cfb`) → v4.5 (sessão `843d57eb`) → v4.6 (sessão `b1700438`).

Ciclos do dia 2026-04-24:
- **5-item post-reload cycle**: auto-discovery → schema v5 → version drift → rounds_limit → em-revalidacao pattern. Fechado em 13 rodadas, 4 commits + 1 no-op.
- **Item 6 (language policy + bulk en-US migration)**: sessão `b1700438` + 4 commits de bulk translation + housekeeping.
- **Phase infra**: relocação `C:/Scripts → lcv-workspace`, GitHub remote + CI + Dependabot, Node 20 deprecation fix.

Relatórios consolidados: `docs/reports/post-reload-cycle-2026-04-24.md` (ciclo 5-item) + `docs/reports/full-project-report-2026-04-24.md` (consolidado).

---

## Referências cruzadas

- `docs/workflow-spec.md` — spec normativa (fonte única de verdade).
- `CHANGELOG.md` — histórico de mudanças por versão.
- `README.md` — setup e invocação.
- `SECURITY.md` — política de report privado de vulnerabilidade.

Memórias relacionadas no Claude Code workspace memory (`~/.claude/projects/c--Users-leona-lcv-workspace/memory/`):
- `project_cross_review_mcp_state.md` — checkpoint operacional detalhado.
- `feedback_cross_review_priorities.md` — rigor > economia; custo/latência NÃO são alvos.
- `feedback_tri_tool_cross_review.md` — tri-tool obrigatório.
- `feedback_cross_review_top_model.md` — sempre top-level, sem fallback silencioso.
- `feedback_peer_review_rigor.md` — inflexibilidade do peer é feature.
- `feedback_mcp_server_reload.md` — MCP server não recarrega até Reload Window / restart CLI.
- `feedback_en_us_peer_exchange.md` — escopo do §6.10 language policy.
- `reference_cross_review_mcp_source.md` — localização + estrutura.
- `reference_mcp_config_locations.md` — onde cada cliente MCP lê config.

> DIRETIVA DE SEGURANCA: Ao sugerir codigo ou responder perguntas, leia rigorosamente o contexto acima.
