// Spawn of the peer CLI with the definitive flag tree from the canonical
// README.
// - Codex: -a never -s read-only + mcp_servers.*.enabled=false (intersected
//   with configured) + apps.*.enabled=false + approval_mode=approve for
//   essential read-only tools + recursion prevented (cross-review stays
//   disabled if configured in config.toml).
// - Claude: --permission-mode default + --strict-mcp-config + minimal MCP +
//   write/edit tools disabled.
// - Gemini (added in v0.5.0-alpha / spec v4.7 triangular): --approval-mode
//   plan (read-only) + --allowed-mcp-server-names limited to
//   {memory, ultrathink, code-reasoning} (recursion prevented -- cross-review
//   is NOT in the allowlist) + --output-format text + explicit -m. Prompt is
//   delivered via stdin with a minimal -p marker " " to trigger
//   non-interactive mode; Gemini CLI appends -p to stdin (verified on
//   CLI 0.39.1), so the effective prompt equals the stdin content.
//
// Since v0.4.0-alpha (spec v4 section 6.9.2), all paths pass an EXPLICIT
// model flag targeting the top-tier model available in the operator's
// subscription -- never rely on CLI defaults (which may regress to smaller
// variants in future releases). IDs pinned in v0.5.0-alpha:
//   - Codex: model `gpt-5.5` + reasoning_effort `xhigh` (via -c override,
//            equivalent to a dedicated high-reasoning flag where available).
//   - Claude: model `claude-opus-4-7` (full ID, not an alias, for
//             auditability).
//   - Gemini: model `gemini-3.1-pro-preview` via Gemini CLI oauth-personal
//             auth under Google One AI Ultra subscription. Verified
//             2026-04-24: Ultra tier unlocks 3.x previews through the
//             v1internal code-assist endpoint (`cloudcode-pa.googleapis.com`).
//             Empirical evidence: `-m gemini-3.1-pro-preview` and
//             `-m gemini-3-pro-preview` both produce coherent responses
//             under Ultra (previously silent-downgraded to 2.5-pro /
//             2.5-flash on the pre-Ultra tier); `-m gemini-9.9-nonexistent`
//             returns clean 404 (server validates IDs; accepted 3.x IDs
//             are NOT silent-downgraded under Ultra).
//             KNOWN LIMITATION: the oauth-personal response does NOT
//             expose an authoritative `modelVersion` field (unlike the
//             SDK path), so the runtime silent-downgrade defense from
//             v0.5.0-alpha will still false-positive-flag based on the
//             model's unreliable text self-report (e.g. `gemini-1.5-pro`).
//             The protocol_violation audit flag is noisy on Gemini
//             rounds; convergence still works (based on peer_status
//             only, not protocol_violation). Resolution for a cleaner
//             audit trail requires SDK path (separate billing) or a
//             Gemini-specific bypass in the model-check (v0.6.0-alpha).
// Model change requires explicit spec/config bump/edit; no silent fallback.
// `spawnPeer` returns `peer_model` for persistence in
// meta.json.rounds[i].peer_model, meeting the normative auditability
// requirement.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIGS_DIR = path.resolve(__dirname, '..', '..', 'reviewer-configs');
const EXCLUSIONS_PATH = path.join(CONFIGS_DIR, 'peer-exclusions.json');
const REVIEWER_MCP_JSON = path.join(CONFIGS_DIR, 'reviewer-minimal.mcp.json');

// Normative IDs for v0.5.0-alpha (spec v4 section 6.9.2, extended by v4.7
// triangular + v4.8 resilience).
const CODEX_MODEL = 'gpt-5.5';
const CODEX_REASONING_EFFORT = 'xhigh';
const CLAUDE_MODEL = 'claude-opus-4-7';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';

// Gemini peer containment: allowlist of MCP servers the peer may use while
// analyzing. Deliberately excludes cross-review-mcp to prevent recursion
// (spec v4 section 6.9.2). Includes the canonical reasoning stack so the
// peer can honor the tri-tool mandate (spec v4 section 6.2 per
// feedback_tri_tool_cross_review).
const GEMINI_ALLOWED_MCP_SERVERS = ['memory', 'ultrathink', 'code-reasoning'];

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
    for (;;) {
        const m = re.exec(content);
        if (m === null) break;
        names.add(m[1]);
    }
    return [...names];
}

function buildCodexArgs() {
    const ex = loadExclusions();
    const configured = listCodexConfiguredServers();

    // Intersection: only override mcp_servers.* if it exists in config.toml,
    // otherwise the CLI yields "invalid transport".
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
        '-m',
        CODEX_MODEL,
        '-c',
        `model_reasoning_effort=${CODEX_REASONING_EFFORT}`,
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
        '--model',
        CLAUDE_MODEL,
        '--permission-mode',
        'default',
        '--strict-mcp-config',
        '--mcp-config',
        REVIEWER_MCP_JSON,
        '--disallowed-tools',
        'Write,Edit,NotebookEdit',
    ];
}

function buildGeminiArgs() {
    const allowArgs = GEMINI_ALLOWED_MCP_SERVERS.flatMap((name) => [
        '--allowed-mcp-server-names',
        name,
    ]);
    return [
        '-m',
        GEMINI_MODEL,
        '-p',
        ' ',
        '--approval-mode',
        'plan',
        '--output-format',
        'text',
        ...allowArgs,
    ];
}

function modelForPeer(peerAgent) {
    if (peerAgent === 'codex') return CODEX_MODEL;
    if (peerAgent === 'claude') return CLAUDE_MODEL;
    if (peerAgent === 'gemini') return GEMINI_MODEL;
    throw new Error(`modelForPeer: unknown peer agent '${peerAgent}'`);
}

// Kill a spawned child and its process tree. On Windows the `shell: true`
// child is cmd.exe which launches the real CLI; `proc.kill()` terminates
// cmd.exe but leaves the CLI orphaned. `taskkill /T /F` reaps the tree.
// On Unix we negate the pid to target the process group.
// R11 (Codex peer review F2 round 2): Windows spawn trees must be reaped
// on timeout and on retry; leaving orphans breaks wallclock budgets.
function killProcessTree(proc) {
    if (!proc || proc.killed || proc.exitCode != null) return;
    if (process.platform === 'win32') {
        try {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        } catch {
            try { proc.kill('SIGKILL'); } catch {}
        }
        return;
    }
    try {
        process.kill(-proc.pid, 'SIGKILL');
    } catch {
        try { proc.kill('SIGKILL'); } catch {}
    }
}

// Probe stub: short-circuits probeAgent for smoke tests.
// CROSS_REVIEW_PROBE_STUB format: comma-separated "agent:tier[:model]"
// entries. Tier in {top, fallback, excluded}. Model defaults to
// modelForPeer(agent). Unlisted agents fall through to real probe.
// Example: "gemini:top:gemini-2.5-pro,codex:excluded,claude:fallback:claude-sonnet-4-6"
function probeStubFor(agent) {
    const raw = process.env.CROSS_REVIEW_PROBE_STUB;
    if (!raw) return null;
    const entries = raw
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => e.split(':'));
    for (const parts of entries) {
        const [a, tier, model] = parts;
        if (a !== agent) continue;
        if (!['top', 'fallback', 'excluded'].includes(tier)) {
            return null;
        }
        return {
            agent,
            tier,
            requested_model: modelForPeer(agent),
            model_reported: model || modelForPeer(agent),
            model_match: (model || modelForPeer(agent)) === modelForPeer(agent),
            probe_latency_ms: 0,
            probe_budget_ms: 30000,
            exit_code: tier === 'excluded' ? 1 : 0,
            failure_class: tier === 'excluded' ? 'probe_excluded_stub' : null,
            cli_version: null,
            timestamp: new Date().toISOString(),
            stderr_tail: '',
        };
    }
    return null;
}

// Probe a single agent with a minimal CLI call to determine tier and
// confirm the model identity. 30s default budget; configurable via
// options.budgetMs. Returns a rich capability_snapshot entry (spec v4.8
// section 6.9.3 + F2 Q6 field schema).
function probeAgent(agent, options = {}) {
    const stubbed = probeStubFor(agent);
    if (stubbed) return Promise.resolve(stubbed);

    const budgetMs = options.budgetMs ?? 30 * 1000;
    const started = Date.now();
    const requested = modelForPeer(agent);
    // Minimal probe prompt; the peer is expected to reply tersely.
    const prompt =
        'Identify your exact model id in one short line, then stop. ' +
        'No other output needed.';

    return new Promise((resolve) => {
        let resolved = false;
        const finish = (snapshot) => {
            if (resolved) return;
            resolved = true;
            resolve(snapshot);
        };

        let proc;
        try {
            let cmd;
            let args;
            if (agent === 'codex') {
                cmd = 'codex';
                args = buildCodexArgs();
            } else if (agent === 'claude') {
                cmd = 'claude';
                args = buildClaudeArgs();
            } else if (agent === 'gemini') {
                cmd = 'gemini';
                args = buildGeminiArgs();
            } else {
                return finish({
                    agent,
                    tier: 'excluded',
                    requested_model: null,
                    model_reported: null,
                    model_match: false,
                    probe_latency_ms: 0,
                    probe_budget_ms: budgetMs,
                    exit_code: -1,
                    failure_class: 'unknown_agent',
                    cli_version: null,
                    timestamp: new Date().toISOString(),
                    stderr_tail: '',
                });
            }
            const cmdLine = buildCommandLine(cmd, args);
            proc = spawn(cmdLine, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
                windowsHide: true,
            });
        } catch (err) {
            return finish({
                agent,
                tier: 'excluded',
                requested_model: requested,
                model_reported: null,
                model_match: false,
                probe_latency_ms: Date.now() - started,
                probe_budget_ms: budgetMs,
                exit_code: -1,
                failure_class: 'spawn_error',
                cli_version: null,
                timestamp: new Date().toISOString(),
                stderr_tail: String(err?.message || err).slice(-400),
            });
        }

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            killProcessTree(proc);
            finish({
                agent,
                tier: 'excluded',
                requested_model: requested,
                model_reported: null,
                model_match: false,
                probe_latency_ms: Date.now() - started,
                probe_budget_ms: budgetMs,
                exit_code: -1,
                failure_class: 'probe_timeout',
                cli_version: null,
                timestamp: new Date().toISOString(),
                stderr_tail: stderr.slice(-400),
            });
        }, budgetMs);

        proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
        proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
        proc.on('error', (err) => {
            clearTimeout(timer);
            finish({
                agent,
                tier: 'excluded',
                requested_model: requested,
                model_reported: null,
                model_match: false,
                probe_latency_ms: Date.now() - started,
                probe_budget_ms: budgetMs,
                exit_code: -1,
                failure_class: 'spawn_error',
                cli_version: null,
                timestamp: new Date().toISOString(),
                stderr_tail: String(err?.message || err).slice(-400),
            });
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            const latency = Date.now() - started;
            if (code !== 0) {
                return finish({
                    agent,
                    tier: 'excluded',
                    requested_model: requested,
                    model_reported: null,
                    model_match: false,
                    probe_latency_ms: latency,
                    probe_budget_ms: budgetMs,
                    exit_code: code,
                    failure_class: 'probe_nonzero_exit',
                    cli_version: null,
                    timestamp: new Date().toISOString(),
                    stderr_tail: stderr.slice(-400),
                });
            }
            // Extract model self-report from stdout tail. First non-empty
            // line that looks like a model id.
            const reported = extractReportedModel(stdout);
            const match = reported != null && reported === requested;
            finish({
                agent,
                tier: match ? 'top' : (reported ? 'fallback' : 'excluded'),
                requested_model: requested,
                model_reported: reported,
                model_match: match,
                probe_latency_ms: latency,
                probe_budget_ms: budgetMs,
                exit_code: code,
                failure_class: match ? null : (reported ? 'silent_model_downgrade' : 'probe_no_model_report'),
                cli_version: null,
                timestamp: new Date().toISOString(),
                stderr_tail: stderr.slice(-400),
            });
        });

        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

// Heuristic extractor for a model id from the probe response. The peer
// was asked for "your exact model id in one short line"; we pick the
// last non-empty line that matches a conservative id shape (letters,
// digits, dots, hyphens, underscores; length 3-80). Returns null if no
// candidate found.
function extractReportedModel(stdout) {
    if (!stdout) return null;
    const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const idShape = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const candidate = lines[i];
        if (idShape.test(candidate)) return candidate;
        // Allow a line like "I am gemini-2.5-pro." -> strip trailing
        // punctuation and extract last token.
        const tokens = candidate.split(/\s+/).map((t) => t.replace(/[.,;:!?]+$/, ''));
        for (let j = tokens.length - 1; j >= 0; j -= 1) {
            if (idShape.test(tokens[j])) return tokens[j];
        }
    }
    return null;
}

// Probe multiple agents in parallel. Promise.allSettled preserves
// per-agent partial results; never rejects. Returns an array of
// snapshots in the same order as `agents`.
function probeChain(agents, options = {}) {
    const tasks = agents.map((a) => probeAgent(a, options));
    return Promise.allSettled(tasks).then((results) =>
        results.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            return {
                agent: agents[i],
                tier: 'excluded',
                requested_model: null,
                model_reported: null,
                model_match: false,
                probe_latency_ms: 0,
                probe_budget_ms: options.budgetMs ?? 30 * 1000,
                exit_code: -1,
                failure_class: 'probe_rejected',
                cli_version: null,
                timestamp: new Date().toISOString(),
                stderr_tail: String(r.reason?.message || r.reason).slice(-400),
            };
        })
    );
}

// Test stub. Does NOT spawn a real CLI -- returns a synthetic response so
// functional-smoke can cover ask_peer without LLM cost. Must never be set
// outside tests.
//
// Supported forms for CROSS_REVIEW_PEER_STUB:
//   READY | NOT_READY | NEEDS_EVIDENCE
//     -> body + final line "STATUS: X" as last non-empty line (legacy).
//   MISSING
//     -> body without parseable STATUS; triggers protocol_violation.
//   ERROR
//     -> rejects the promise simulating a spawn failure.
//   STRUCTURED:READY | STRUCTURED:NOT_READY | STRUCTURED:NEEDS_EVIDENCE
//     -> body + structured block as TAIL.
//   STRUCTURED_EARLY_REGEX_LAST:<STRUCTURED_STATUS>:<REGEX_STATUS>
//     -> structured block mid-body and line "STATUS: <REGEX_STATUS>" as the
//        last non-empty line. Expected semantics: regex wins
//        (anchor = last-non-empty-line).
//   STRUCTURED_LAST_REGEX_EARLY:<REGEX_STATUS>:<STRUCTURED_STATUS>
//     -> line "STATUS: <REGEX_STATUS>" mid-body and structured block as
//        TAIL. Expected semantics: structured wins.
//   MALFORMED_STRUCTURED_TAIL
//     -> tail with </cross_review_status> whose inner JSON is invalid. Must
//        NOT fall through to regex (tail is the closing tag). Expected:
//        status=null.
//   INVALID_STATUS_STRUCTURED_TAIL
//     -> tail with well-formed structured block but status outside the enum
//        (e.g. {"status":"MAYBE"}). Expected: status=null, structured=null.
//   LOWERCASE_STATUS
//     -> last line "STATUS: ready" (lowercase). Case-sensitive regex
//        rejects. Expected: status=null.
//   PROSE_MENTION_STATUS
//     -> body with "STATUS: READY" cited in prose (e.g. inside backticks)
//        and a different last non-empty line. Expected: status=null
//        (false-positive protection).
//   PROSE_MENTION_BLOCK
//     -> body with "<cross_review_status>..." cited in prose and tail
//        ending in free text. Expected: status=null.
//   DOUBLE_STRUCTURED:<EARLY>:<LAST>
//     -> two structured blocks; the LAST (tail) wins. Expected: status=LAST.
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
    const peer_model = 'stub';

    if (stub === 'MISSING') {
        return { stdout: `${body}\n`, stderr, peer_model };
    }
    if (LEGACY_STATUSES.has(stub)) {
        return { stdout: `${body}\n\nSTATUS: ${stub}\n`, stderr, peer_model };
    }
    if (stub.startsWith('STRUCTURED:')) {
        const status = stub.slice('STRUCTURED:'.length);
        assertLegacy(status, 'STRUCTURED');
        const block = `<cross_review_status>${JSON.stringify({ status })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub.startsWith('STRUCTURED_EARLY_REGEX_LAST:')) {
        const rest = stub.slice('STRUCTURED_EARLY_REGEX_LAST:'.length);
        const [structured, regex] = rest.split(':');
        assertLegacy(structured, 'STRUCTURED_EARLY_REGEX_LAST structured');
        assertLegacy(regex, 'STRUCTURED_EARLY_REGEX_LAST regex');
        const block = `<cross_review_status>${JSON.stringify({ status: structured })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n\nmore prose here\n\nSTATUS: ${regex}\n`, stderr, peer_model };
    }
    if (stub.startsWith('STRUCTURED_LAST_REGEX_EARLY:')) {
        const rest = stub.slice('STRUCTURED_LAST_REGEX_EARLY:'.length);
        const [regex, structured] = rest.split(':');
        assertLegacy(regex, 'STRUCTURED_LAST_REGEX_EARLY regex');
        assertLegacy(structured, 'STRUCTURED_LAST_REGEX_EARLY structured');
        const block = `<cross_review_status>${JSON.stringify({ status: structured })}</cross_review_status>`;
        return { stdout: `${body}\n\nSTATUS: ${regex}\n\nmore prose here\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'MALFORMED_STRUCTURED_TAIL') {
        const malformedBlock = '<cross_review_status>{not valid json</cross_review_status>';
        return { stdout: `${body}\n\n${malformedBlock}\n`, stderr, peer_model };
    }
    if (stub === 'INVALID_STATUS_STRUCTURED_TAIL') {
        const block = `<cross_review_status>${JSON.stringify({ status: 'MAYBE' })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'LOWERCASE_STATUS') {
        return { stdout: `${body}\n\nSTATUS: ready\n`, stderr, peer_model };
    }
    if (stub === 'PROSE_MENTION_STATUS') {
        return { stdout: `${body}\n\nFor example, the peer could write \`STATUS: READY\` at the end.\n\nBut this response is not ended with the canonical marker.\n`, stderr, peer_model };
    }
    if (stub === 'PROSE_MENTION_BLOCK') {
        return { stdout: `${body}\n\nExample of the canonical tag: <cross_review_status>{"status":"READY"}</cross_review_status>\n\nThis response ends with prose and does not terminate with the canonical tag.\n`, stderr, peer_model };
    }
    if (stub.startsWith('DOUBLE_STRUCTURED:')) {
        const rest = stub.slice('DOUBLE_STRUCTURED:'.length);
        const [early, last] = rest.split(':');
        assertLegacy(early, 'DOUBLE_STRUCTURED early');
        assertLegacy(last, 'DOUBLE_STRUCTURED last');
        const b1 = `<cross_review_status>${JSON.stringify({ status: early })}</cross_review_status>`;
        const b2 = `<cross_review_status>${JSON.stringify({ status: last })}</cross_review_status>`;
        return { stdout: `${body}\n\n${b1}\n\nintermediate prose\n\n${b2}\n`, stderr, peer_model };
    }
    if (stub.startsWith('MULTILINE_STRUCTURED:')) {
        const status = stub.slice('MULTILINE_STRUCTURED:'.length);
        assertLegacy(status, 'MULTILINE_STRUCTURED');
        // Pretty-printed JSON payload between multi-line tags. Parser must
        // extract body via slice and JSON.parse must tolerate the whitespace.
        const prettyPayload = `{\n  "status": ${JSON.stringify(status)}\n}`;
        return {
            stdout: `${body}\n\n<cross_review_status>\n${prettyPayload}\n</cross_review_status>\n`,
            stderr,
            peer_model,
        };
    }
    // v0.4.0 stubs -- expanded schema and missing-close-tag gap.
    if (stub === 'STRUCTURED_V4_FULL') {
        const block = `<cross_review_status>${JSON.stringify({
            status: 'READY',
            uncertainty: 'low',
            caller_requests: ['verify X', 'confirm Y'],
            follow_ups: ['cleanup Z in future session'],
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_BAD_UNCERTAINTY') {
        const block = `<cross_review_status>${JSON.stringify({
            status: 'READY',
            uncertainty: 'super-high',
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_BAD_CALLER_REQUESTS_SHAPE') {
        const block = `<cross_review_status>${JSON.stringify({
            status: 'NEEDS_EVIDENCE',
            caller_requests: 'this should be an array',
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_NON_STRING_ITEM') {
        const block = `<cross_review_status>${JSON.stringify({
            status: 'READY',
            follow_ups: ['ok', 123, 'also ok'],
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_TOO_MANY_CALLER_REQUESTS') {
        const requests = Array.from({ length: 21 }, (_, i) => `req ${i + 1}`);
        const block = `<cross_review_status>${JSON.stringify({
            status: 'NEEDS_EVIDENCE',
            caller_requests: requests,
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_OVERSIZED_ITEM') {
        const bigString = 'x'.repeat(501);
        const block = `<cross_review_status>${JSON.stringify({
            status: 'NEEDS_EVIDENCE',
            caller_requests: ['ok', bigString],
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_UNKNOWN_FIELD') {
        const block = `<cross_review_status>${JSON.stringify({
            status: 'READY',
            extra: 'not in whitelist',
            another_unknown: 42,
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    if (stub === 'STRUCTURED_V4_EMPTY_ARRAYS') {
        const block = `<cross_review_status>${JSON.stringify({
            status: 'READY',
            caller_requests: [],
            follow_ups: [],
        })}</cross_review_status>`;
        return { stdout: `${body}\n\n${block}\n`, stderr, peer_model };
    }
    // v0.5.0-alpha stubs for server-level model-check (W8). Unlike the
    // other stubs that all return peer_model='stub' to bypass the
    // model-check entirely, these return a REAL-looking peer_model so
    // the server activates parseDeclaredModel + classifyModelMatch.
    // Used by smoke tests to exercise the silent-downgrade defense
    // end-to-end via the MCP surface.
    if (stub.startsWith('REAL_MATCH:')) {
        // REAL_MATCH:<model_id>:<status>
        const parts = stub.split(':');
        const modelId = parts[1];
        const status = parts[2];
        assertLegacy(status, 'REAL_MATCH');
        const modelBlock = `<cross_review_peer_model>${JSON.stringify({ model_id: modelId })}</cross_review_peer_model>`;
        const statusBlock = `<cross_review_status>${JSON.stringify({ status })}</cross_review_status>`;
        return {
            stdout: `${body}\n\n${modelBlock}\n${statusBlock}\n`,
            stderr,
            peer_model: modelId,
        };
    }
    if (stub.startsWith('REAL_DOWNGRADE:')) {
        // REAL_DOWNGRADE:<requested>:<reported>:<status>
        const parts = stub.split(':');
        const requested = parts[1];
        const reported = parts[2];
        const status = parts[3];
        assertLegacy(status, 'REAL_DOWNGRADE');
        const modelBlock = `<cross_review_peer_model>${JSON.stringify({ model_id: reported })}</cross_review_peer_model>`;
        const statusBlock = `<cross_review_status>${JSON.stringify({ status })}</cross_review_status>`;
        return {
            stdout: `${body}\n\n${modelBlock}\n${statusBlock}\n`,
            stderr,
            peer_model: requested,
        };
    }
    if (stub.startsWith('REAL_MISSING_MODEL:')) {
        // REAL_MISSING_MODEL:<requested>:<status>
        const parts = stub.split(':');
        const requested = parts[1];
        const status = parts[2];
        assertLegacy(status, 'REAL_MISSING_MODEL');
        const statusBlock = `<cross_review_status>${JSON.stringify({ status })}</cross_review_status>`;
        return {
            stdout: `${body}\n\n${statusBlock}\n`,
            stderr,
            peer_model: requested,
        };
    }
    if (stub === 'STRUCTURED_OPEN_NO_CLOSE') {
        // Open tag present but no close tag. Tail does not end with close,
        // falls through to tryLegacyLastLine; without a canonical
        // "STATUS: X" on the last line, returns null (protocol_violation
        // expected).
        const fakeOpen = '<cross_review_status>{"status":"READY"}';
        return { stdout: `${body}\n\n${fakeOpen}\n\nprose after the unclosed opening.\n`, stderr, peer_model };
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

// Build a quoted command line to pass to the shell. Avoids the pattern
// spawn(cmd, args, {shell: true}) that Node 20+ flags as unsafe for args
// with special chars. Our args are internal (not user input), but the safe
// pattern is still worth following.
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
    let cmd;
    let args;
    if (peerAgent === 'codex') {
        cmd = 'codex';
        args = buildCodexArgs();
    } else if (peerAgent === 'claude') {
        cmd = 'claude';
        args = buildClaudeArgs();
    } else if (peerAgent === 'gemini') {
        cmd = 'gemini';
        args = buildGeminiArgs();
    } else {
        return Promise.reject(
            new Error(`spawnPeer: unknown peer agent '${peerAgent}'`)
        );
    }
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
            killProcessTree(proc);
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
            // spec v4 section 6.9.2: peer_model must be persisted per
            // round for auditability. Stub path sets it via resolveStub;
            // real path must set it here using the pinned ID for the
            // actual peer agent. Missing peer_model in the real resolve
            // path was a bug flagged by peer review 2026-04-24.
            resolve({ stdout, stderr, peer_model: modelForPeer(peerAgent) });
        });

        proc.stdin.write(String(prompt));
        proc.stdin.end();
    });
}

// Spawn multiple peers in parallel preserving per-peer partial results
// and explicit agent identity (R12 from F2 round 2: never infer agent
// from array index). Never rejects; each item carries either
// {agent, status: 'fulfilled', value} or {agent, status: 'rejected',
// reason}. `value` is the raw spawnPeer resolution; callers layer the
// statusParser + silent-downgrade check on top.
function spawnPeers(agents, prompt, options = {}) {
    const tasks = agents.map((a) =>
        spawnPeer(a, prompt, options).then(
            (value) => ({ agent: a, status: 'fulfilled', value }),
            (reason) => ({ agent: a, status: 'rejected', reason })
        )
    );
    return Promise.all(tasks);
}

module.exports = {
    spawnPeer,
    spawnPeers,
    probeAgent,
    probeChain,
    killProcessTree,
    extractReportedModel,
    buildCodexArgs,
    buildClaudeArgs,
    buildGeminiArgs,
    listCodexConfiguredServers,
    loadExclusions,
    // Exported for audit/test use only. Exposes the pinned top-level
    // model IDs per spec section 6.9.2 + 6.9.2.1.
    modelForPeer,
    CODEX_MODEL,
    CODEX_REASONING_EFFORT,
    CLAUDE_MODEL,
    GEMINI_MODEL,
    GEMINI_ALLOWED_MCP_SERVERS,
};
