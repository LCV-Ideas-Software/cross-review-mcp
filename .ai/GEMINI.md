# .ai/GEMINI.md — cross-review-mcp (Gemini contextual memory)

Este arquivo é a memória contextual do Gemini Code Assist para o repositório cross-review-mcp. Espelho simplificado da `.ai/memory.md` + diretivas básicas.

**Ao assumir trabalho neste repo, leia PRIMEIRO:**
1. `.ai/memory.md` (contexto completo).
2. `docs/workflow-spec.md` §§6.4, 6.9.1, 6.9.2, 6.9.2.1, 6.10, 8 (diretivas operacionais mandatórias).
3. `CHANGELOG.md` (histórico recente).

---

## O que é

Servidor MCP stdio de cross-review bilateral Claude Code ↔ ChatGPT Codex. Cada peer revisa o trabalho do outro até convergência bilateral. Estado em `~/.cross-review/<uuid>/`. Versão atual: código `v0.4.0-alpha`, spec `v4.6`.

## Diretivas críticas

- **ASCII-only** em arquivos em disco (§6.4).
- **en-US** em peer exchange + artefatos internos (§6.10); chat assistant-user permanece pt-BR; §8 historical entries preservadas pt-BR (não-retroativas).
- **Tri-tool obrigatório** pre-session_init: cross-review + ultrathink + code-reasoning (§6.9.1).
- **Modelo top-level** sempre (§6.9.2); sem fallback silencioso.
- **Em-revalidacao → aprovada**: entradas §8 com "aprovada bilateralmente" só pós-sealing bilateral real (§8 preâmbulo v4.5).
- **Runtime imutável** em bumps coordenados: `src/server.js`, `src/lib/*.js`, `scripts/functional-smoke.js`.

## Gates antes de commit

```
npm run smoke            # 60 steps all GREEN
npm run check-models     # OK: no drift, no staleness
```

## Spec edits

Qualquer mudança em `docs/workflow-spec.md` com impacto normativo passa por sessão cross-review (session_init → rodadas → session_check_convergence → session_finalize). Bulk translation pt-BR → en-US é exceção autorizada em §6.10.
