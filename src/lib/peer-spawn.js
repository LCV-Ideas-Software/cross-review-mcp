// Spawn do peer CLI com a arvore de flags definitiva da README canonica.
// - Codex: -a never -s read-only + mcp_servers.*.enabled=false (intersecao com
//   configured) + apps.*.enabled=false + approval_mode=approve para tools
//   read-only essenciais + recursao prevenida (cross-review fica desabilitado
//   se configurado em config.toml).
// - Claude: --permission-mode default + --strict-mcp-config + MCP minimo +
//   tools de escrita/edit desabilitados.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIGS_DIR = path.resolve(__dirname, '..', '..', 'reviewer-configs');
const EXCLUSIONS_PATH = path.join(CONFIGS_DIR, 'peer-exclusions.json');
const REVIEWER_MCP_JSON = path.join(CONFIGS_DIR, 'reviewer-minimal.mcp.json');

function loadExclusions() {
    return JSON.parse(fs.readFileSync(EXCLUSIONS_PATH, 'utf8'));
}

function listCodexConfiguredServers() {
    const configPath = path.join(
        process.env.USERPROFILE || process.env.HOME || '',
        '.codex',
        'config.toml'
    );
    if (!fs.existsSync(configPath)) return [];
    const content = fs.readFileSync(configPath, 'utf8');
    const names = new Set();
    const re = /^\[mcp_servers\.([^\].]+)\]/gm;
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1]);
    return [...names];
}

function buildCodexArgs() {
    const ex = loadExclusions();
    const configured = listCodexConfiguredServers();

    // Intersecao: override de mcp_servers.* so se existir em config.toml,
    // senao gera "invalid transport".
    const effectiveDisable = (ex.codex_disable || []).filter((n) =>
        configured.includes(n)
    );
    const disableArgs = effectiveDisable.flatMap((n) => [
        '-c',
        `mcp_servers.${n}.enabled=false`,
    ]);

    const appsDisableArgs = (ex.codex_apps_disable || []).flatMap((id) => [
        '-c',
        `apps.${id}.enabled=false`,
    ]);

    const approveArgs = (ex.codex_approve_tools || []).flatMap(
        ({ server, tool }) => [
            '-c',
            `mcp_servers.${server}.tools.${tool}.approval_mode=approve`,
        ]
    );

    return [
        '-a',
        'never',
        '-s',
        'read-only',
        'exec',
        '--skip-git-repo-check',
        ...disableArgs,
        ...appsDisableArgs,
        ...approveArgs,
        '-',
    ];
}

function buildClaudeArgs() {
    return [
        '-p',
        '--output-format',
        'text',
        '--permission-mode',
        'default',
        '--strict-mcp-config',
        '--mcp-config',
        REVIEWER_MCP_JSON,
        '--disallowed-tools',
        'Write,Edit,NotebookEdit',
    ];
}

// Stub de teste. Nao spawna CLI real -- retorna resposta sintetica para
// functional-smoke cobrir ask_peer sem custo de LLM. Fora de teste, nunca
// deve ser setado.
//
// Formas suportadas de CROSS_REVIEW_PEER_STUB:
//   READY | NOT_READY | NEEDS_EVIDENCE
//     -> corpo + linha final "STATUS: X" como ultima linha nao-vazia (legacy).
//   MISSING
//     -> corpo sem STATUS parseavel; dispara protocol_violation.
//   ERROR
//     -> rejeita a promise simulando falha de spawn.
//   STRUCTURED:READY | STRUCTURED:NOT_READY | STRUCTURED:NEEDS_EVIDENCE
//     -> corpo + bloco estruturado como TAIL.
//   STRUCTURED_EARLY_REGEX_LAST:<STRUCTURED_STATUS>:<REGEX_STATUS>
//     -> bloco estruturado no meio do corpo e linha "STATUS: <REGEX_STATUS>"
//        como ultima linha nao-vazia. Semantica esperada: regex vence
//        (anchor = last-non-empty-line).
//   STRUCTURED_LAST_REGEX_EARLY:<REGEX_STATUS>:<STRUCTURED_STATUS>
//     -> linha "STATUS: <REGEX_STATUS>" no meio do corpo e bloco estruturado
//        como TAIL. Semantica esperada: structured vence.
//   MALFORMED_STRUCTURED_TAIL
//     -> tail com </cross_review_status> cujo JSON interno e invalido. Nao
//        deve cair no regex (tail eh o closing tag). Esperado: status=null.
//   INVALID_STATUS_STRUCTURED_TAIL
//     -> tail com bloco estruturado bem-formado mas status fora do enum
//        (ex: {"status":"MAYBE"}). Esperado: status=null, structured=null.
//   LOWERCASE_STATUS
//     -> ultima linha "STATUS: ready" (minusculo). Regex case-sensitive
//        rejeita. Esperado: status=null.
//   PROSE_MENTION_STATUS
//     -> corpo com "STATUS: READY" citado em prosa (ex: dentro de crases), e
//        ultima linha nao-vazia diferente. Esperado: status=null (protecao
//        contra false positive).
//   PROSE_MENTION_BLOCK
//     -> corpo com bloco "<cross_review_status>..." citado em prosa, e tail
//        terminando em texto livre. Esperado: status=null.
//   DOUBLE_STRUCTURED:<EARLY>:<LAST>
//     -> dois blocos estruturados; o ULTIMO (tail) vence. Esperado: status=LAST.
const LEGACY_STATUSES = new Set(['READY', 'NOT_READY', 'NEEDS_EVIDENCE']);

function assertLegacy(status, label) {
    if (!LEGACY_STATUSES.has(status)) {
        throw new Error(
            `stub: invalid status '${status}' for ${label} (need one of {READY,NOT_READY,NEEDS_EVIDENCE})`
        );
    }
}

function resolveStub(stub) {
    const body = `[stub peer response; CROSS_REVIEW_PEER_STUB=${stub}]`;
    const stderr = '[stub] peer spawn skipped\n';

    if (stub === 'MISSING') {
        return { stdout: body + '\n', stderr };
    }
    if (LEGACY_STATUSES.has(stub)) {
        return { stdout: `${body}\n\nSTATUS: ${stub}\n`, stderr };
    }
    if (stub.startsWith('STRUCTURED:')) {
        const status = stub.slice('STRUCTURED:'.length);
        assertLegacy(status, 'STRUCTURED');
        const block = `<cross_review_status>${JSON.stringify({ status })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr };
    }
    if (stub.startsWith('STRUCTURED_EARLY_REGEX_LAST:')) {
        const rest = stub.slice('STRUCTURED_EARLY_REGEX_LAST:'.length);
        const [structured, regex] = rest.split(':');
        assertLegacy(structured, 'STRUCTURED_EARLY_REGEX_LAST structured');
        assertLegacy(regex, 'STRUCTURED_EARLY_REGEX_LAST regex');
        const block = `<cross_review_status>${JSON.stringify({ status: structured })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n\nmore prose here\n\nSTATUS: ${regex}\n`, stderr };
    }
    if (stub.startsWith('STRUCTURED_LAST_REGEX_EARLY:')) {
        const rest = stub.slice('STRUCTURED_LAST_REGEX_EARLY:'.length);
        const [regex, structured] = rest.split(':');
        assertLegacy(regex, 'STRUCTURED_LAST_REGEX_EARLY regex');
        assertLegacy(structured, 'STRUCTURED_LAST_REGEX_EARLY structured');
        const block = `<cross_review_status>${JSON.stringify({ status: structured })}</cross_review_status>`;
        return { stdout: `${body}\n\nSTATUS: ${regex}\n\nmore prose here\n\n${block}\n`, stderr };
    }
    if (stub === 'MALFORMED_STRUCTURED_TAIL') {
        const malformedBlock = '<cross_review_status>{not valid json</cross_review_status>';
        return { stdout: `${body}\n\n${malformedBlock}\n`, stderr };
    }
    if (stub === 'INVALID_STATUS_STRUCTURED_TAIL') {
        const block = `<cross_review_status>${JSON.stringify({ status: 'MAYBE' })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr };
    }
    if (stub === 'LOWERCASE_STATUS') {
        return { stdout: `${body}\n\nSTATUS: ready\n`, stderr };
    }
    if (stub === 'PROSE_MENTION_STATUS') {
        return { stdout: `${body}\n\nFor example, the peer could write \`STATUS: READY\` at the end.\n\nBut this response is not ended with the canonical marker.\n`, stderr };
    }
    if (stub === 'PROSE_MENTION_BLOCK') {
        return { stdout: `${body}\n\nExample of the canonical tag: <cross_review_status>{"status":"READY"}</cross_review_status>\n\nThis response ends with prose and does not terminate with the canonical tag.\n`, stderr };
    }
    if (stub.startsWith('DOUBLE_STRUCTURED:')) {
        const rest = stub.slice('DOUBLE_STRUCTURED:'.length);
        const [early, last] = rest.split(':');
        assertLegacy(early, 'DOUBLE_STRUCTURED early');
        assertLegacy(last, 'DOUBLE_STRUCTURED last');
        const b1 = `<cross_review_status>${JSON.stringify({ status: early })}</cross_review_status>`;
        const b2 = `<cross_review_status>${JSON.stringify({ status: last })}</cross_review_status>`;
        return { stdout: `${body}\n\n${b1}\n\nintermediate prose\n\n${b2}\n`, stderr };
    }
    if (stub.startsWith('MULTILINE_STRUCTURED:')) {
        const status = stub.slice('MULTILINE_STRUCTURED:'.length);
        assertLegacy(status, 'MULTILINE_STRUCTURED');
        // Payload JSON pretty-printed entre tags multi-linha. Parser deve
        // extrair corpo via slice e JSON.parse tolerar o whitespace.
        const prettyPayload = `{\n  "status": ${JSON.stringify(status)}\n}`;
        return {
            stdout: `${body}\n\n<cross_review_status>\n${prettyPayload}\n</cross_review_status>\n`,
            stderr,
        };
    }
    throw new Error(`stub: unknown CROSS_REVIEW_PEER_STUB form '${stub}'`);
}

function peerStub() {
    const stub = process.env.CROSS_REVIEW_PEER_STUB;
    if (!stub) return null;
    if (stub === 'ERROR') {
        return Promise.reject(new Error('stub: simulated peer failure'));
    }
    try {
        return Promise.resolve(resolveStub(stub));
    } catch (err) {
        return Promise.reject(err);
    }
}

// Monta uma command line quotada para passar ao shell. Evita o pattern
// spawn(cmd, args, {shell: true}) que Node 20+ sinaliza como inseguro para
// args com chars especiais. Nossos args sao internos (nao user input), mas
// vale seguir o pattern seguro.
function buildCommandLine(cmd, args) {
    const quote = (s) => {
        const str = String(s);
        if (str.length && !/[\s"'$`\\]/.test(str)) return str;
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    };
    return [quote(cmd), ...args.map(quote)].join(' ');
}

function spawnPeer(peerAgent, prompt, options = {}) {
    const stubbed = peerStub();
    if (stubbed) return stubbed;

    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000; // 30 min
    const cmd = peerAgent === 'codex' ? 'codex' : 'claude';
    const args = peerAgent === 'codex' ? buildCodexArgs() : buildClaudeArgs();
    const cmdLine = buildCommandLine(cmd, args);

    return new Promise((resolve, reject) => {
        const proc = spawn(cmdLine, {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
        });
        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (finished) return;
            try {
                proc.kill('SIGKILL');
            } catch {}
            reject(new Error(`peer ${peerAgent} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
        proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
        proc.on('error', (err) => {
            finished = true;
            clearTimeout(timer);
            reject(new Error(`spawn ${cmd} failed: ${err.message}`));
        });
        proc.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            if (code !== 0) {
                return reject(
                    new Error(
                        `peer ${peerAgent} exit ${code}: ${stderr.slice(-400)}`
                    )
                );
            }
            resolve({ stdout, stderr });
        });

        proc.stdin.write(String(prompt));
        proc.stdin.end();
    });
}

module.exports = {
    spawnPeer,
    buildCodexArgs,
    buildClaudeArgs,
    listCodexConfiguredServers,
    loadExclusions,
};
