#!/usr/bin/env node

/**
 * functional-smoke.js
 *
 * Drive o server MCP via stdio JSON-RPC e exercita os tools de estado
 * (session_init, session_read, session_check_convergence, session_finalize).
 * PULA deliberadamente ask_peer por envolver spawn real do peer CLI e gasto
 * de LLM; aquele caminho e validado em E2E manual.
 *
 * Sucesso: todos os tools respondem com o shape esperado + arquivos corretos
 * sao criados em ~/.cross-review/<id>/.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER = path.resolve(__dirname, '..', 'src', 'server.js');
const STATE_DIR = path.join(os.homedir(), '.cross-review');

function requestLine(id, method, params) {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function notifLine(method, params) {
    return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}

async function driveServer(extraEnv = {}) {
    const proc = spawn('node', [SERVER], {
        env: { ...process.env, CROSS_REVIEW_CALLER: 'claude', ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });

    const stderrChunks = [];
    proc.stderr.on('data', (d) => stderrChunks.push(d.toString('utf8')));

    const responses = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null) responses.set(msg.id, msg);
            } catch {
                // ignora linhas nao-JSON
            }
        }
    });

    function call(id, method, params) {
        return new Promise((resolve, reject) => {
            proc.stdin.write(requestLine(id, method, params));
            const timer = setTimeout(() => {
                reject(new Error(`timeout waiting for response id=${id} method=${method}`));
            }, 10000);
            const poll = setInterval(() => {
                if (responses.has(id)) {
                    clearInterval(poll);
                    clearTimeout(timer);
                    resolve(responses.get(id));
                }
            }, 25);
        });
    }

    function notify(method, params) {
        proc.stdin.write(notifLine(method, params));
    }

    const results = [];

    try {
        // 1) initialize
        const init = await call(1, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smoke', version: '0.1' },
        });
        assert(init.result?.serverInfo?.name === 'cross-review-mcp', 'initialize: serverInfo.name');
        results.push({ step: 'initialize', ok: true });
        notify('notifications/initialized');

        // 2) tools/list
        const tools = await call(2, 'tools/list', {});
        const names = tools.result.tools.map((t) => t.name).sort();
        const expected = [
            'ask_peer',
            'session_check_convergence',
            'session_finalize',
            'session_init',
            'session_read',
        ];
        assert(
            JSON.stringify(names) === JSON.stringify(expected),
            `tools/list: got ${names.join(',')} expected ${expected.join(',')}`
        );
        results.push({ step: 'tools/list', ok: true, tools: names });

        // 3) session_init
        const init2 = await call(3, 'tools/call', {
            name: 'session_init',
            arguments: { task: 'smoke test', artifacts: ['C:/dummy.js'] },
        });
        const initPayload = JSON.parse(init2.result.content[0].text);
        assert(typeof initPayload.session_id === 'string' && initPayload.session_id.length > 0, 'session_init: session_id');
        assert(initPayload.caller === 'claude' && initPayload.peer === 'codex', 'session_init: caller/peer');
        const sessionId = initPayload.session_id;
        const sessDir = path.join(STATE_DIR, sessionId);
        assert(fs.existsSync(path.join(sessDir, 'meta.json')), 'session_init: meta.json exists');
        results.push({ step: 'session_init', ok: true, session_id: sessionId });

        // 4) session_read
        const read = await call(4, 'tools/call', {
            name: 'session_read',
            arguments: { session_id: sessionId },
        });
        const meta = JSON.parse(read.result.content[0].text);
        assert(meta.task === 'smoke test', 'session_read: task');
        assert(meta.artifacts.length === 1 && meta.artifacts[0] === 'C:/dummy.js', 'session_read: artifacts');
        assert(Array.isArray(meta.rounds) && meta.rounds.length === 0, 'session_read: rounds empty');
        results.push({ step: 'session_read', ok: true });

        // 5) session_check_convergence (sem rodadas)
        const conv = await call(5, 'tools/call', {
            name: 'session_check_convergence',
            arguments: { session_id: sessionId },
        });
        const convPayload = JSON.parse(conv.result.content[0].text);
        assert(convPayload.converged === false, 'check_convergence: not converged yet');
        assert(convPayload.reason === 'no rounds yet', 'check_convergence: reason');
        results.push({ step: 'session_check_convergence', ok: true });

        // 6) session_finalize
        const fin = await call(6, 'tools/call', {
            name: 'session_finalize',
            arguments: { session_id: sessionId, outcome: 'aborted' },
        });
        const finPayload = JSON.parse(fin.result.content[0].text);
        assert(finPayload.ok === true && finPayload.outcome === 'aborted', 'finalize: ok');
        // Verify persisted
        const meta2 = JSON.parse(
            fs.readFileSync(path.join(sessDir, 'meta.json'), 'utf8')
        );
        assert(meta2.outcome === 'aborted' && typeof meta2.finalized_at === 'string', 'finalize: persisted');
        results.push({ step: 'session_finalize', ok: true });

        // 7) session_read after finalize
        const read2 = await call(7, 'tools/call', {
            name: 'session_read',
            arguments: { session_id: sessionId },
        });
        const meta3 = JSON.parse(read2.result.content[0].text);
        assert(meta3.outcome === 'aborted', 'read-after-finalize: outcome persisted');
        results.push({ step: 'session_read (after finalize)', ok: true });

        // 8) error path: session_read with bad id
        const bad = await call(8, 'tools/call', {
            name: 'session_read',
            arguments: { session_id: 'nonexistent-uuid-xxx' },
        });
        assert(bad.result.isError === true, 'read bad id: isError flag');
        results.push({ step: 'session_read (bad id -> isError)', ok: true });

        // Limpeza
        if (fs.existsSync(sessDir)) {
            fs.rmSync(sessDir, { recursive: true, force: true });
        }
        results.push({ step: 'cleanup', ok: true });
    } finally {
        proc.stdin.end();
        proc.kill();
    }

    return { results, stderr: stderrChunks.join('') };
}

function assert(cond, msg) {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// === ask_peer tests via CROSS_REVIEW_PEER_STUB ===
// Spawn separate server instance with stub env set, exercise ask_peer +
// bilateral convergence matrix. Stub retorna resposta sintetica sem custo LLM.
async function driveAskPeerMatrix() {
    const results = [];
    const proc = spawn('node', [SERVER], {
        env: { ...process.env, CROSS_REVIEW_CALLER: 'claude', CROSS_REVIEW_PEER_STUB: 'READY' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });
    const stderrChunks = [];
    proc.stderr.on('data', (d) => stderrChunks.push(d.toString('utf8')));
    const responses = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null) responses.set(msg.id, msg);
            } catch {}
        }
    });
    const call = (id, method, params) =>
        new Promise((resolve, reject) => {
            proc.stdin.write(requestLine(id, method, params));
            const t = setTimeout(() => reject(new Error(`timeout id=${id}`)), 15000);
            const poll = setInterval(() => {
                if (responses.has(id)) {
                    clearInterval(poll);
                    clearTimeout(t);
                    resolve(responses.get(id));
                }
            }, 25);
        });
    const notify = (method, params) => proc.stdin.write(notifLine(method, params));

    try {
        await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-askpeer', version: '0.1' } });
        notify('notifications/initialized');

        const init = await call(2, 'tools/call', { name: 'session_init', arguments: { task: 'askpeer smoke', artifacts: [] } });
        const sid = JSON.parse(init.result.content[0].text).session_id;

        // Round 1: caller=NOT_READY, peer stub=READY -> not converged
        const r1 = await call(3, 'tools/call', { name: 'ask_peer', arguments: { session_id: sid, prompt: 'test', caller_status: 'NOT_READY' } });
        const r1Payload = JSON.parse(r1.result.content[0].text);
        assert(r1Payload.caller_status === 'NOT_READY', 'ask_peer r1: caller_status');
        assert(r1Payload.peer_status === 'READY', 'ask_peer r1: peer_status=READY from stub');
        assert(r1Payload.protocol_violation === false, 'ask_peer r1: no protocol violation');
        results.push({ step: 'ask_peer r1 (caller=NOT_READY, peer=READY)', ok: true });

        const c1 = await call(4, 'tools/call', { name: 'session_check_convergence', arguments: { session_id: sid } });
        const c1Payload = JSON.parse(c1.result.content[0].text);
        assert(c1Payload.converged === false, 'convergence r1: not converged');
        assert(/caller.*NOT_READY.*peer.*READY|peer READY.*caller.*NOT_READY/i.test(c1Payload.reason), 'convergence r1: reason coherent');
        results.push({ step: 'convergence r1 (caller NOT_READY blocks)', ok: true });

        // Round 2: caller=READY, peer stub=READY -> CONVERGED
        const r2 = await call(5, 'tools/call', { name: 'ask_peer', arguments: { session_id: sid, prompt: 'test', caller_status: 'READY' } });
        const r2Payload = JSON.parse(r2.result.content[0].text);
        assert(r2Payload.caller_status === 'READY', 'ask_peer r2: caller_status');
        assert(r2Payload.peer_status === 'READY', 'ask_peer r2: peer READY');
        results.push({ step: 'ask_peer r2 (caller=READY, peer=READY)', ok: true });

        const c2 = await call(6, 'tools/call', { name: 'session_check_convergence', arguments: { session_id: sid } });
        const c2Payload = JSON.parse(c2.result.content[0].text);
        assert(c2Payload.converged === true, 'convergence r2: BILATERAL READY converged');
        results.push({ step: 'convergence r2 (bilateral READY -> converged)', ok: true });

        // Finalize + cleanup
        await call(7, 'tools/call', { name: 'session_finalize', arguments: { session_id: sid, outcome: 'converged' } });
        const sessPath = path.join(os.homedir(), '.cross-review', sid);
        if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
        results.push({ step: 'askpeer cleanup', ok: true });
    } finally {
        proc.stdin.end();
        proc.kill();
    }

    return { results, stderr: stderrChunks.join('') };
}

// Test PROTOCOL_VIOLATION path: peer stub returns content without STATUS
async function driveProtocolViolation() {
    const results = [];
    const proc = spawn('node', [SERVER], {
        env: { ...process.env, CROSS_REVIEW_CALLER: 'claude', CROSS_REVIEW_PEER_STUB: 'MISSING' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });
    const responses = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null) responses.set(msg.id, msg);
            } catch {}
        }
    });
    const call = (id, method, params) =>
        new Promise((resolve, reject) => {
            proc.stdin.write(requestLine(id, method, params));
            const t = setTimeout(() => reject(new Error(`timeout id=${id}`)), 15000);
            const poll = setInterval(() => {
                if (responses.has(id)) {
                    clearInterval(poll);
                    clearTimeout(t);
                    resolve(responses.get(id));
                }
            }, 25);
        });

    try {
        await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-violation', version: '0.1' } });
        proc.stdin.write(notifLine('notifications/initialized'));

        const init = await call(2, 'tools/call', { name: 'session_init', arguments: { task: 'violation test', artifacts: [] } });
        const sid = JSON.parse(init.result.content[0].text).session_id;

        const r = await call(3, 'tools/call', { name: 'ask_peer', arguments: { session_id: sid, prompt: 't', caller_status: 'READY' } });
        const payload = JSON.parse(r.result.content[0].text);
        assert(payload.peer_status === null, 'protocol violation: peer_status null');
        assert(payload.protocol_violation === true, 'protocol violation: flag true');
        assert(payload.peer_structured === null, 'protocol violation: peer_structured null');
        assert(payload.status_source === null, 'protocol violation: status_source null');
        results.push({ step: 'ask_peer with stub=MISSING -> protocol_violation', ok: true });

        const sessPath = path.join(os.homedir(), '.cross-review', sid);
        if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
        results.push({ step: 'violation cleanup', ok: true });
    } finally {
        proc.stdin.end();
        proc.kill();
    }

    return { results };
}

// Helper: spawn server, do one ask_peer, return payload+session_id for assertions
async function oneShotAskPeer(stubValue, callerStatus = 'NOT_READY') {
    const proc = spawn('node', [SERVER], {
        env: { ...process.env, CROSS_REVIEW_CALLER: 'claude', CROSS_REVIEW_PEER_STUB: stubValue },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });
    const responses = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null) responses.set(msg.id, msg);
            } catch {}
        }
    });
    const call = (id, method, params) =>
        new Promise((resolve, reject) => {
            proc.stdin.write(requestLine(id, method, params));
            const t = setTimeout(() => reject(new Error(`timeout id=${id}`)), 15000);
            const poll = setInterval(() => {
                if (responses.has(id)) {
                    clearInterval(poll);
                    clearTimeout(t);
                    resolve(responses.get(id));
                }
            }, 25);
        });
    try {
        await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: `smoke-${stubValue}`, version: '0.1' } });
        proc.stdin.write(notifLine('notifications/initialized'));
        const init = await call(2, 'tools/call', { name: 'session_init', arguments: { task: `stub=${stubValue}`, artifacts: [] } });
        const sid = JSON.parse(init.result.content[0].text).session_id;
        const r = await call(3, 'tools/call', { name: 'ask_peer', arguments: { session_id: sid, prompt: 'test', caller_status: callerStatus } });
        const payload = JSON.parse(r.result.content[0].text);
        const conv = await call(4, 'tools/call', { name: 'session_check_convergence', arguments: { session_id: sid } });
        const convPayload = JSON.parse(conv.result.content[0].text);
        return { sessionId: sid, payload, convPayload };
    } finally {
        proc.stdin.end();
        proc.kill();
    }
}

function cleanupSession(sid) {
    const sessPath = path.join(os.homedir(), '.cross-review', sid);
    if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
}

// Test NEEDS_EVIDENCE (legacy line form): status parseado, nao converge, reason string menciona evidence.
async function driveNeedsEvidenceLegacy() {
    const results = [];
    const { sessionId, payload, convPayload } = await oneShotAskPeer('NEEDS_EVIDENCE', 'NOT_READY');
    assert(payload.peer_status === 'NEEDS_EVIDENCE', 'legacy NEEDS_EVIDENCE: peer_status');
    assert(payload.status_source === 'regex', 'legacy NEEDS_EVIDENCE: status_source=regex');
    assert(payload.peer_structured === null, 'legacy NEEDS_EVIDENCE: no structured');
    assert(payload.protocol_violation === false, 'legacy NEEDS_EVIDENCE: no violation');
    assert(convPayload.converged === false, 'legacy NEEDS_EVIDENCE: not converged');
    assert(/NEEDS_EVIDENCE/.test(convPayload.reason), 'legacy NEEDS_EVIDENCE: reason mentions status');
    assert(/evidence/i.test(convPayload.reason), 'legacy NEEDS_EVIDENCE: reason mentions evidence');
    results.push({ step: 'ask_peer legacy NEEDS_EVIDENCE -> not converged + reason mentions evidence', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'needs-evidence-legacy cleanup', ok: true });
    return { results };
}

// Test structured block happy path: READY from block, no regex fallback needed
async function driveStructuredReady() {
    const results = [];
    const { sessionId, payload, convPayload } = await oneShotAskPeer('STRUCTURED:READY', 'READY');
    assert(payload.peer_status === 'READY', 'structured READY: peer_status');
    assert(payload.status_source === 'structured', 'structured READY: source');
    assert(payload.peer_structured && payload.peer_structured.status === 'READY', 'structured READY: structured payload');
    assert(convPayload.converged === true, 'structured READY: bilateral converged');
    results.push({ step: 'ask_peer STRUCTURED:READY -> source=structured + converged', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'structured-ready cleanup', ok: true });
    return { results };
}

// Test structured NEEDS_EVIDENCE: status from block, not converged
async function driveStructuredNeedsEvidence() {
    const results = [];
    const { sessionId, payload, convPayload } = await oneShotAskPeer('STRUCTURED:NEEDS_EVIDENCE', 'NOT_READY');
    assert(payload.peer_status === 'NEEDS_EVIDENCE', 'structured NEEDS_EVIDENCE: status');
    assert(payload.status_source === 'structured', 'structured NEEDS_EVIDENCE: source');
    assert(payload.peer_structured.status === 'NEEDS_EVIDENCE', 'structured NEEDS_EVIDENCE: payload');
    assert(convPayload.converged === false, 'structured NEEDS_EVIDENCE: not converged');
    assert(/NEEDS_EVIDENCE/.test(convPayload.reason) && /evidence/i.test(convPayload.reason), 'structured NEEDS_EVIDENCE: reason coherent');
    results.push({ step: 'ask_peer STRUCTURED:NEEDS_EVIDENCE -> not converged + evidence guidance', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'structured-needs-evidence cleanup', ok: true });
    return { results };
}

// Semantic: last-non-empty-content wins. Structured block early + regex STATUS late -> regex wins.
async function driveRegexLastWins() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('STRUCTURED_EARLY_REGEX_LAST:READY:NOT_READY', 'NOT_READY');
    assert(payload.peer_status === 'NOT_READY', 'last-line anchor: regex NOT_READY wins when STATUS line is last non-empty');
    assert(payload.status_source === 'regex', 'last-line anchor: source=regex');
    assert(payload.peer_structured === null, 'last-line anchor: structured null because regex path taken');
    results.push({ step: 'ask_peer STRUCTURED_EARLY_REGEX_LAST -> regex (last line) wins', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'regex-last-wins cleanup', ok: true });
    return { results };
}

// Semantic: structured block as TAIL wins even if STATUS line appears earlier.
async function driveStructuredTailWins() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('STRUCTURED_LAST_REGEX_EARLY:NOT_READY:READY', 'READY');
    assert(payload.peer_status === 'READY', 'tail anchor: structured READY tail wins over earlier STATUS NOT_READY');
    assert(payload.status_source === 'structured', 'tail anchor: source=structured');
    assert(payload.peer_structured && payload.peer_structured.status === 'READY', 'tail anchor: payload READY');
    results.push({ step: 'ask_peer STRUCTURED_LAST_REGEX_EARLY -> structured (tail) wins', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'structured-tail-wins cleanup', ok: true });
    return { results };
}

// Malformed structured tail: closing tag ends text but JSON is invalid -> status null (no regex fallback because tail is closing tag).
async function driveMalformedStructuredTail() {
    const results = [];
    const { sessionId, payload, convPayload } = await oneShotAskPeer('MALFORMED_STRUCTURED_TAIL', 'NOT_READY');
    assert(payload.peer_status === null, 'malformed tail: status null');
    assert(payload.status_source === null, 'malformed tail: source null');
    assert(payload.peer_structured === null, 'malformed tail: structured null');
    assert(payload.protocol_violation === true, 'malformed tail: protocol_violation flag');
    assert(convPayload.converged === false, 'malformed tail: not converged');
    results.push({ step: 'ask_peer MALFORMED_STRUCTURED_TAIL -> protocol_violation, no regex fallback', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'malformed-tail cleanup', ok: true });
    return { results };
}

// Invalid status inside structured tail: JSON parses but status not in enum -> null.
async function driveInvalidStatusStructuredTail() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('INVALID_STATUS_STRUCTURED_TAIL', 'NOT_READY');
    assert(payload.peer_status === null, 'invalid status: null');
    assert(payload.status_source === null, 'invalid status: source null');
    assert(payload.peer_structured === null, 'invalid status: structured nullified (not persisting garbage)');
    assert(payload.protocol_violation === true, 'invalid status: protocol_violation');
    results.push({ step: 'ask_peer INVALID_STATUS_STRUCTURED_TAIL -> status null, structured nullified', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'invalid-status-cleanup', ok: true });
    return { results };
}

// Lowercase STATUS line: regex is case-sensitive -> reject.
async function driveLowercaseRejected() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('LOWERCASE_STATUS', 'NOT_READY');
    assert(payload.peer_status === null, 'lowercase: rejected');
    assert(payload.protocol_violation === true, 'lowercase: protocol_violation');
    results.push({ step: 'ask_peer LOWERCASE_STATUS -> rejected (case-sensitive)', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'lowercase-cleanup', ok: true });
    return { results };
}

// Prose mention of STATUS line: should not trigger false positive (tail must be the STATUS line).
async function driveProseStatusNoFalsePositive() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('PROSE_MENTION_STATUS', 'NOT_READY');
    assert(payload.peer_status === null, 'prose mention STATUS: no false positive');
    assert(payload.protocol_violation === true, 'prose mention STATUS: protocol_violation');
    results.push({ step: 'ask_peer PROSE_MENTION_STATUS -> no false positive', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'prose-status-cleanup', ok: true });
    return { results };
}

// Prose mention of structured block: tail is prose, not closing tag -> no match.
async function driveProseBlockNoFalsePositive() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('PROSE_MENTION_BLOCK', 'NOT_READY');
    assert(payload.peer_status === null, 'prose mention block: no false positive');
    assert(payload.protocol_violation === true, 'prose mention block: protocol_violation');
    results.push({ step: 'ask_peer PROSE_MENTION_BLOCK -> no false positive (tail is prose, not closing tag)', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'prose-block-cleanup', ok: true });
    return { results };
}

// Two structured blocks: the later (tail) wins.
async function driveDoubleStructured() {
    const results = [];
    const { sessionId, payload } = await oneShotAskPeer('DOUBLE_STRUCTURED:NOT_READY:READY', 'READY');
    assert(payload.peer_status === 'READY', 'double structured: last (tail) wins');
    assert(payload.status_source === 'structured', 'double structured: source=structured');
    assert(payload.peer_structured.status === 'READY', 'double structured: payload matches last block');
    results.push({ step: 'ask_peer DOUBLE_STRUCTURED -> tail wins', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'double-structured-cleanup', ok: true });
    return { results };
}

// Multi-line pretty-printed JSON inside the structured block.
async function driveMultilineStructured() {
    const results = [];
    const { sessionId, payload, convPayload } = await oneShotAskPeer('MULTILINE_STRUCTURED:READY', 'READY');
    assert(payload.peer_status === 'READY', 'multiline structured: status parsed');
    assert(payload.status_source === 'structured', 'multiline structured: source=structured');
    assert(payload.peer_structured && payload.peer_structured.status === 'READY', 'multiline structured: payload');
    assert(convPayload.converged === true, 'multiline structured: bilateral converged');
    results.push({ step: 'ask_peer MULTILINE_STRUCTURED -> parser tolerates pretty-printed JSON between tags', ok: true });
    cleanupSession(sessionId);
    results.push({ step: 'multiline-structured-cleanup', ok: true });
    return { results };
}

async function runAll() {
    const all = [];
    const s1 = await driveServer();
    all.push(...s1.results);
    const s2 = await driveAskPeerMatrix();
    all.push(...s2.results);
    const s3 = await driveProtocolViolation();
    all.push(...s3.results);
    const s4 = await driveNeedsEvidenceLegacy();
    all.push(...s4.results);
    const s5 = await driveStructuredReady();
    all.push(...s5.results);
    const s6 = await driveStructuredNeedsEvidence();
    all.push(...s6.results);
    const s7 = await driveRegexLastWins();
    all.push(...s7.results);
    const s8 = await driveStructuredTailWins();
    all.push(...s8.results);
    const s9 = await driveMalformedStructuredTail();
    all.push(...s9.results);
    const s10 = await driveInvalidStatusStructuredTail();
    all.push(...s10.results);
    const s11 = await driveLowercaseRejected();
    all.push(...s11.results);
    const s12 = await driveProseStatusNoFalsePositive();
    all.push(...s12.results);
    const s13 = await driveProseBlockNoFalsePositive();
    all.push(...s13.results);
    const s14 = await driveDoubleStructured();
    all.push(...s14.results);
    const s15 = await driveMultilineStructured();
    all.push(...s15.results);
    return all;
}

runAll()
    .then((results) => {
        const allOk = results.every((r) => r.ok);
        for (const r of results) {
            console.log(`  [${r.ok ? 'ok' : 'FAIL'}] ${r.step}${r.tools ? ` (${r.tools.length} tools)` : ''}${r.session_id ? ` session=${r.session_id.slice(0, 8)}...` : ''}`);
        }
        console.log(`\n[functional-smoke] ${results.length} steps, all ${allOk ? 'GREEN' : 'HAD FAILURES'}`);
        process.exit(allOk ? 0 : 1);
    })
    .catch((err) => {
        console.error(`[functional-smoke] FATAL: ${err?.stack || err?.message || err}`);
        process.exit(1);
    });
