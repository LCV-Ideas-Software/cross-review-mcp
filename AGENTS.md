# AGENTS.md — cross-review-mcp

Pointer global para agentes AI (Claude Code, Copilot, Gemini, Codex) trabalhando neste repositório.

---

## Fontes autoritativas

1. **`docs/workflow-spec.md`** — spec normativa (atualmente v4.6). Fonte única de verdade para protocolo, diretivas operacionais, schema do bloco estruturado, e regras de versionamento.
2. **`.ai/memory.md`** — contexto completo do projeto, arquivos-chave, diretivas, histórico resumido.
3. **`CHANGELOG.md`** — histórico de mudanças por versão.

## Espelhos simplificados

- `.ai/GEMINI.md` — memória contextual do Gemini Code Assist.
- `.github/copilot-instructions.md` — diretivas do GitHub Copilot.

## Diretivas mandatórias resumidas

- **ASCII-only** em arquivos em disco (spec §6.4).
- **en-US** em peer exchange + artefatos internos do cross-review-mcp (spec §6.10). Exceções: chat assistant-user em pt-BR; §8 historical entries preservadas pt-BR (não-retroativas).
- **Tri-tool obrigatório** pre-session_init: cross-review + ultrathink + code-reasoning (spec §6.9.1).
- **Modelo top-level** sempre, sem fallback silencioso (spec §6.9.2). IDs cravados em `peer-spawn.js`; troca exige bump + spec edit.
- **Em-revalidacao → aprovada**: entradas §8 com "aprovada bilateralmente" só pós-`session_check_convergence`=true (spec §8 preâmbulo v4.5).
- **Runtime imutável** em bumps coordenados: `src/server.js`, `src/lib/*.js`, `scripts/functional-smoke.js`.

## Gates obrigatórios

```
npm run smoke            # 60 steps all GREEN
npm run check-models     # OK: no drift, no staleness
```

## Commit messages

Conventional Commits, em English. Exemplos: `docs(v4.7): ...`, `chore: ...`, `fix(parser): ...`, `ci: ...`. Incluir `Co-Authored-By:` quando assistido por AI.

## Versionamento

- Código: SemVer em `package.json` alinhado com `src/server.js:48` (MCP identity via init handshake).
- Spec: ciclo próprio (v4.1, v4.2, ..., v4.6) documentado em §8.
- Releases spec-only NÃO bumpam código.
- CHANGELOG.md atualizado a cada release.

## Repositório

- Local: `C:/Users/leona/lcv-workspace/cross-review-mcp/`.
- Remote: `github.com/lcv-leo/cross-review-mcp` (privado).
- Branch principal: `main`.
- CI: GitHub Actions (`npm run smoke` + `npm run check-models`).
- Dependabot: npm + github-actions weekly.

## Idiomas dos arquivos (§6.10)

| Arquivo | Idioma |
|---------|--------|
| `docs/workflow-spec.md` (corpo §§0-7 + §6.10 + §7 + §8 narrative/follow-ups) | en-US |
| `docs/workflow-spec.md` §8 sealed entries v4-v4.6 + §8 preâmbulo v4.5 rule + user directive quote | pt-BR (não-retroativo) |
| `src/`, `scripts/` (comments, JSDoc, stderr) | en-US |
| `docs/top-models.json` (description, notes) | en-US |
| `docs/reports/*.md` | en-US |
| `CHANGELOG.md` | pt-BR (user-facing per §6.10 exception (c)) |
| `.ai/memory.md`, `.ai/GEMINI.md`, `.github/copilot-instructions.md`, `AGENTS.md` (este) | pt-BR (user-facing per §6.10 exception (c)) |
| `README.md`, `SECURITY.md`, `LICENSE` | preservar idioma original (remote-authored ou setup doc) |
| Chat assistant-user | pt-BR |
