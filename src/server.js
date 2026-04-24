#!/usr/bin/env node

/**
 * cross-review-mcp / server.js
 *
 * MCP server (stdio) exposing the cross-review orchestration surface.
 * Identity is determined by CROSS_REVIEW_CALLER (claude | codex |
 * gemini); ask_peer (legacy bilateral, claude<->codex only) and
 * ask_peers (N-ary, all complements) spawn the peers under the
 * definitive contained-spawn configuration.
 *
 * Exposed tools:
 *   - session_init(task, artifacts[])
 *   - session_read(session_id)
 *   - session_check_convergence(session_id)
 *   - session_finalize(session_id, outcome)
 *   - ask_peer(session_id, prompt, caller_status)       [legacy bilateral]
 *   - ask_peers(session_id, prompt, caller_status)      [N-ary, v0.5.0-alpha]
 *
 * v0.5.0-alpha (F2) additions per spec v4.7 triangular + v4.8 resilience:
 *   - VALID_AGENTS = {claude, codex, gemini}
 *   - session_init runs probeChain in parallel (20-25s target, 30s hard
 *     ceiling) and persists capability_snapshot.
 *   - ask_peers runs spawnPeers (Promise.all over Promise.allSettled-
 *     wrapped spawnPeer) with explicit agent identity; failed peers are
 *     recorded via saveFailedAttempt, successful peers enter the round.
 *   - Every real-spawn peer response is re-parsed with the sibling
 *     modelParser to detect silent_model_downgrade
 *     (TODO-spec-v4.9 -- defensive code ships now per F2 Q4 decision).
 *   - Legacy ask_peer remains bilateral (claude<->codex only); gemini
 *     callers are directed to ask_peers (R23).
 */

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const store = require('./lib/session-store.js');
const {
    spawnPeer,
    spawnPeers,
    probeChain,
} = require('./lib/peer-spawn.js');
const { parsePeerResponse } = require('./lib/status-parser.js');
const {
    parseDeclaredModel,
    classifyModelMatch,
    MODEL_OPEN_TAG,
    MODEL_CLOSE_TAG,
} = require('./lib/model-parser.js');

const VERSION = '0.5.0-alpha';
const VALID_AGENTS = ['claude', 'codex', 'gemini'];
const LEGACY_BILATERAL_PEER = Object.freeze({
    claude: 'codex',
    codex: 'claude',
    // gemini intentionally absent -- R23 (F2 round 2): ask_peer
    // is a bilateral-only legacy surface; gemini callers must use
    // ask_peers.
});

const CALLER = (process.env.CROSS_REVIEW_CALLER || '').toLowerCase();
if (!VALID_AGENTS.includes(CALLER)) {
    process.stderr.write(
        `[cross-review-mcp] fatal: CROSS_REVIEW_CALLER must be one of ${VALID_AGENTS.join('|')} (got '${CALLER || '(unset)'}')\n`
    );
    process.exit(1);
}

const PEERS = VALID_AGENTS.filter((a) => a !== CALLER);
const LEGACY_PEER = LEGACY_BILATERAL_PEER[CALLER] || null;

// Probe behavior controls. In smoke tests the env-gated
// CROSS_REVIEW_PROBE_STUB short-circuits per-agent probes inside
// peer-spawn.js; CROSS_REVIEW_SKIP_PROBE bypasses probeChain entirely
// (records an empty snapshot). Operators do not set either variable.
const SKIP_PROBE = process.env.CROSS_REVIEW_SKIP_PROBE === '1';
const PROBE_BUDGET_MS = Number(process.env.CROSS_REVIEW_PROBE_BUDGET_MS) || 25000;

function log(msg, meta) {
    const base = `[cross-review-mcp ${new Date().toISOString()} caller=${CALLER}] ${msg}`;
    process.stderr.write(meta ? `${base} ${JSON.stringify(meta)}\n` : `${base}\n`);
}

// Append the tail directives the peer must honor: both structured
// blocks, peer-model then status, with status as the last non-empty
// token. Idempotent-ish: if the caller already embedded the directive,
// the duplicate just re-asserts the contract. Kept concise; the real
// authority lives in `docs/workflow-spec.md`.
function attachPromptTailDirective(prompt) {
    return `${prompt}

---

**cross-review-mcp tail directive (v${VERSION}):** Close your response with BOTH structured blocks in this exact order. The status block MUST be the last non-empty token of your response; the peer-model block MUST appear immediately before the status block.

1. \`${MODEL_OPEN_TAG}{"model_id":"<your exact canonical model id>"}${MODEL_CLOSE_TAG}\`
2. \`<cross_review_status>{"status":"READY|NOT_READY|NEEDS_EVIDENCE", ...}</cross_review_status>\`

The peer-model block enables the caller to detect silent CLI downgrade (spec v4.8 section 6.9.2 + TODO-spec-v4.9). Your reported model_id is compared against the canonical id the caller passed via \`-m\` / equivalent. Mismatch terminates the round as protocol_violation (class: silent_model_downgrade) -- it is NOT retried.`;
}

// Run the full parser stack against a peer's stdout: status parser for
// READY/NOT_READY/NEEDS_EVIDENCE + sibling model parser for silent-
// downgrade detection. Returns an aggregated round-ready record.
// peerModel is the canonical id we PASSED to the CLI (modelForPeer);
// when peerModel === 'stub' the synthetic peer bypasses the model
// check because no real CLI ran.
function parsePeerOutputs(stdout, peerModel) {
    const statusParsed = parsePeerResponse(stdout);
    const isStub = peerModel === 'stub';

    // The sibling model-parser only runs when model-check is applicable
    // (real spawn). For synthetic stub peers we skip both the parse and
    // its warnings, since no CLI actually ran and the peer-model block
    // is by design not emitted. This preserves the v4 stub corpus.
    let modelRequested = null;
    let modelReported = null;
    let modelMatch = null;
    let modelFailureClass = null;
    let modelCheckApplicable = false;
    let modelWarnings = [];

    if (!isStub) {
        const modelParsed = parseDeclaredModel(stdout);
        modelCheckApplicable = true;
        modelRequested = peerModel;
        modelReported = modelParsed.model_id;
        modelWarnings = modelParsed.parser_warnings || [];
        const clazz = classifyModelMatch(modelRequested, modelReported);
        modelMatch = clazz === 'ok';
        modelFailureClass = modelMatch ? null : clazz;
    }

    const parserWarnings = [
        ...(statusParsed.parser_warnings || []),
        ...modelWarnings,
    ];

    const statusMissing = statusParsed.status == null;
    const modelViolation = modelCheckApplicable && !modelMatch;
    const protocolViolation = statusMissing || modelViolation;

    return {
        peer_status: statusParsed.status,
        peer_structured: statusParsed.structured,
        status_source: statusParsed.source,
        parser_warnings: parserWarnings,
        model_check_applicable: modelCheckApplicable,
        model_requested: modelRequested,
        model_reported: modelReported,
        model_match: modelMatch,
        model_failure_class: modelFailureClass,
        protocol_violation: protocolViolation,
    };
}

const server = new Server(
    { name: 'cross-review-mcp', version: VERSION },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'session_init',
            description:
                'Create a new cross-review session directory under ~/.cross-review/<uuid>/. Returns the session_id. In v0.5.0-alpha this also runs a parallel capability probe (probeChain) against all peers (target 20-25s, hard ceiling 30s) and persists the result as meta.capability_snapshot -- spec v4.8 section 6.9.3.',
            inputSchema: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'Short description of the task under review.',
                    },
                    artifacts: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Optional list of artifact paths relevant to the review (read by peer at its discretion).',
                    },
                },
                required: ['task'],
            },
        },
        {
            name: 'session_read',
            description:
                'Return the full session metadata (meta.json) including all rounds recorded so far, capability_snapshot, and any failed_attempts (spec v4.8 section 6.9.3.6 audit trail, secrets redacted).',
            inputSchema: {
                type: 'object',
                properties: { session_id: { type: 'string' } },
                required: ['session_id'],
            },
        },
        {
            name: 'session_check_convergence',
            description:
                "Return whether convergence holds in the last round. Bilateral (ask_peer round): converged iff BOTH caller_status and peer_status are READY. N-ary (ask_peers round, v0.5.0-alpha): converged iff caller_status is READY AND every responded peer declared READY (unanimity; spec v4.7 section 2.8). Peers excluded at probe time live in capability_snapshot and are NOT in the round's peer list. Peers that failed at spawn time are in failed_attempts and are also excluded from the denominator. peer_status values: READY | NOT_READY | NEEDS_EVIDENCE.",
            inputSchema: {
                type: 'object',
                properties: { session_id: { type: 'string' } },
                required: ['session_id'],
            },
        },
        {
            name: 'session_finalize',
            description:
                'Mark the session as concluded with an outcome: converged | aborted | max-rounds.',
            inputSchema: {
                type: 'object',
                properties: {
                    session_id: { type: 'string' },
                    outcome: {
                        type: 'string',
                        enum: ['converged', 'aborted', 'max-rounds'],
                    },
                },
                required: ['session_id', 'outcome'],
            },
        },
        {
            name: 'ask_peer',
            description: `Send a prompt to the single bilateral peer (${LEGACY_PEER || `(legacy bilateral not available for caller=${CALLER}; use ask_peers)`}) and return its response with parsed STATUS. Caller MUST declare its own caller_status (READY means "I have no further changes or objections this round"; NOT_READY means "I applied changes and want peer to re-review, or I disagree with peer's previous response"). caller_status is restricted to READY|NOT_READY -- if the caller is missing evidence, emit NOT_READY and attach a CALLER_REQUEST block for peer. Peer status may be READY|NOT_READY|NEEDS_EVIDENCE. Convergence requires both READY in the same round. Peer runs under contained spawn with destructive MCPs/apps disabled; peer is invoked with the top-level model explicitly set (spec v4 section 6.9.2: codex=gpt-5.5 xhigh, claude=claude-opus-4-7, gemini=gemini-2.5-pro; no silent fallback).

Legacy bilateral surface: ask_peer is claude<->codex only (R23). Gemini callers MUST use ask_peers instead.

Peer response contract (v0.5.0-alpha; v0.4.0 schema preserved + peer-model block added):
  - <cross_review_peer_model>{"model_id":"<canonical id>"}</cross_review_peer_model>  (NEW in v0.5.0)
  - <cross_review_status>{"status":"READY", ...}</cross_review_status>

The peer-model block MUST appear immediately before the status block; the status block MUST be the last non-empty token. A mismatch between the declared model_id and the pinned CODEX_MODEL/CLAUDE_MODEL/GEMINI_MODEL constant fails the round as protocol_violation with failure_class='silent_model_downgrade'. This defense is not retried (spec v4.8 + F2 R15).

The v3 legacy line-form (STATUS: READY | STATUS: NOT_READY | STATUS: NEEDS_EVIDENCE) remains supported for status but does NOT substitute for the peer-model block.

Response payload includes peer_structured (clean JSON when the structured block validated), status_source ('structured' | 'regex' | null), parser_warnings (from both parsers), peer_model (requested pinned id), model_reported (declared by peer), model_match (boolean or null when peer is synthetic), and protocol_violation (boolean).`,
            inputSchema: {
                type: 'object',
                properties: {
                    session_id: { type: 'string' },
                    prompt: {
                        type: 'string',
                        description:
                            'Full prompt for the peer. The server automatically appends the v0.5.0-alpha tail directive so the peer emits both the peer-model and status blocks in the correct order.',
                    },
                    caller_status: {
                        type: 'string',
                        enum: ['READY', 'NOT_READY'],
                        description:
                            "Caller's own STATUS for this round. READY = caller has nothing to add and concurs with peer's previous position (if any). NOT_READY = caller has applied changes, has objections, needs evidence from peer, or wants another round regardless.",
                    },
                },
                required: ['session_id', 'prompt', 'caller_status'],
            },
        },
        {
            name: 'ask_peers',
            description: `N-ary peer spawn (v0.5.0-alpha, spec v4.7): send the same prompt to all complements (caller=${CALLER}, peers=${PEERS.join(',')}) in parallel and return the aggregated per-peer responses. Promise.allSettled preserves per-peer partial results; failed spawns enter meta.failed_attempts (R14 redaction applied) and are excluded from the round's unanimity denominator. Successful peers enter the round with their parsed status and model-check outcome. caller_status semantics identical to ask_peer. Convergence (N-ary): caller READY AND every responded peer READY. This is the canonical tool for triangular sessions.`,
            inputSchema: {
                type: 'object',
                properties: {
                    session_id: { type: 'string' },
                    prompt: {
                        type: 'string',
                        description:
                            'Full prompt for all peers. Same tail-directive injection as ask_peer.',
                    },
                    caller_status: {
                        type: 'string',
                        enum: ['READY', 'NOT_READY'],
                    },
                },
                required: ['session_id', 'prompt', 'caller_status'],
            },
        },
    ],
}));

async function runSessionInitProbe() {
    if (SKIP_PROBE) {
        return { skipped: true, reason: 'CROSS_REVIEW_SKIP_PROBE=1', peers: [] };
    }
    try {
        const snapshot = await probeChain(PEERS, { budgetMs: PROBE_BUDGET_MS });
        return {
            skipped: false,
            started_at: new Date().toISOString(),
            budget_ms: PROBE_BUDGET_MS,
            peers: snapshot,
        };
    } catch (err) {
        // probeChain never rejects (allSettled wrapper), but belt + braces.
        return {
            skipped: false,
            error: String(err?.message || err),
            peers: [],
        };
    }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    log(`tool call: ${name}`);
    try {
        switch (name) {
            case 'session_init': {
                const t0 = Date.now();
                const capabilitySnapshot = await runSessionInitProbe();
                const id = store.initSession({
                    task: args.task,
                    artifacts: args.artifacts || [],
                    callerAgent: CALLER,
                    peers: PEERS,
                    capabilitySnapshot,
                });
                log('session_init created', {
                    session_id: id,
                    probe_duration_ms: Date.now() - t0,
                    probe_skipped: capabilitySnapshot.skipped === true,
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    session_id: id,
                                    caller: CALLER,
                                    peers: PEERS,
                                    capability_snapshot: capabilitySnapshot,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }
            case 'session_read': {
                const meta = store.readMeta(args.session_id);
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(meta, null, 2) },
                    ],
                };
            }
            case 'session_check_convergence': {
                const result = store.checkConvergence(args.session_id);
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(result, null, 2) },
                    ],
                };
            }
            case 'session_finalize': {
                store.finalize(args.session_id, args.outcome);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ ok: true, outcome: args.outcome }, null, 2),
                        },
                    ],
                };
            }
            case 'ask_peer': {
                if (LEGACY_PEER == null) {
                    throw new Error(
                        `ask_peer is a bilateral-only surface (claude<->codex). Caller=${CALLER} MUST use ask_peers instead (R23, spec v4.7).`
                    );
                }
                const sessionId = args.session_id;
                const rawPrompt = args.prompt;
                const callerStatus = args.caller_status;
                if (!['READY', 'NOT_READY'].includes(callerStatus)) {
                    throw new Error(
                        `ask_peer requires caller_status = 'READY' or 'NOT_READY' (got '${callerStatus}')`
                    );
                }
                if (!store.acquireLock(sessionId)) {
                    throw new Error(
                        `session ${sessionId} is currently locked by another process (TTL 1h); retry shortly or clear ~/.cross-review/${sessionId}/.lock if stale`
                    );
                }
                try {
                    const meta = store.readMeta(sessionId);
                    const roundNum = (meta.rounds?.length || 0) + 1;
                    const promptWithTail = attachPromptTailDirective(rawPrompt);
                    store.savePromptForRound(sessionId, roundNum, promptWithTail);
                    log(`ask_peer: spawning ${LEGACY_PEER}`, {
                        session: sessionId,
                        round: roundNum,
                        caller_status: callerStatus,
                        prompt_bytes: Buffer.byteLength(promptWithTail, 'utf8'),
                    });
                    const t0 = Date.now();
                    const { stdout, stderr, peer_model: peerModel } = await spawnPeer(
                        LEGACY_PEER,
                        promptWithTail
                    );
                    const durationMs = Date.now() - t0;
                    const parsed = parsePeerOutputs(stdout, peerModel);
                    const fname = store.savePeerResponse(
                        sessionId,
                        roundNum,
                        LEGACY_PEER,
                        stdout,
                        parsed.peer_status
                    );
                    store.appendRound(sessionId, {
                        round: roundNum,
                        caller: CALLER,
                        caller_status: callerStatus,
                        peer: LEGACY_PEER,
                        peer_status: parsed.peer_status,
                        peer_structured: parsed.peer_structured,
                        status_source: parsed.status_source,
                        parser_warnings: parsed.parser_warnings,
                        peer_model: peerModel,
                        model_requested: parsed.model_requested,
                        model_reported: parsed.model_reported,
                        model_match: parsed.model_match,
                        model_failure_class: parsed.model_failure_class,
                        peer_file: fname,
                        protocol_violation: parsed.protocol_violation,
                        duration_ms: durationMs,
                        completed_at: new Date().toISOString(),
                    });
                    log('ask_peer: done', {
                        round: roundNum,
                        caller_status: callerStatus,
                        peer_status: parsed.peer_status,
                        status_source: parsed.status_source,
                        peer_model: peerModel,
                        model_reported: parsed.model_reported,
                        model_match: parsed.model_match,
                        protocol_violation: parsed.protocol_violation,
                        parser_warnings_count: parsed.parser_warnings.length,
                        converged_this_round:
                            callerStatus === 'READY' && parsed.peer_status === 'READY',
                        duration_ms: durationMs,
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(
                                    {
                                        round: roundNum,
                                        caller_status: callerStatus,
                                        peer_status: parsed.peer_status,
                                        peer_structured: parsed.peer_structured,
                                        status_source: parsed.status_source,
                                        parser_warnings: parsed.parser_warnings,
                                        peer_model: peerModel,
                                        model_requested: parsed.model_requested,
                                        model_reported: parsed.model_reported,
                                        model_match: parsed.model_match,
                                        model_failure_class: parsed.model_failure_class,
                                        protocol_violation: parsed.protocol_violation,
                                        duration_ms: durationMs,
                                        content: stdout,
                                        stderr_tail: (stderr || '').slice(-600),
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                } finally {
                    store.releaseLock(sessionId);
                }
            }
            case 'ask_peers': {
                const sessionId = args.session_id;
                const rawPrompt = args.prompt;
                const callerStatus = args.caller_status;
                if (!['READY', 'NOT_READY'].includes(callerStatus)) {
                    throw new Error(
                        `ask_peers requires caller_status = 'READY' or 'NOT_READY' (got '${callerStatus}')`
                    );
                }
                if (PEERS.length === 0) {
                    throw new Error(
                        `ask_peers has no peers to spawn (caller=${CALLER} is the only agent in VALID_AGENTS).`
                    );
                }
                if (!store.acquireLock(sessionId)) {
                    throw new Error(
                        `session ${sessionId} is currently locked by another process (TTL 1h); retry shortly or clear ~/.cross-review/${sessionId}/.lock if stale`
                    );
                }
                try {
                    const meta = store.readMeta(sessionId);
                    const roundNum = (meta.rounds?.length || 0) + 1;
                    const promptWithTail = attachPromptTailDirective(rawPrompt);
                    store.savePromptForRound(sessionId, roundNum, promptWithTail);
                    log(`ask_peers: spawning ${PEERS.join(',')}`, {
                        session: sessionId,
                        round: roundNum,
                        caller_status: callerStatus,
                        prompt_bytes: Buffer.byteLength(promptWithTail, 'utf8'),
                    });
                    const t0 = Date.now();
                    const peerResults = await spawnPeers(PEERS, promptWithTail);
                    const durationMs = Date.now() - t0;

                    const roundPeers = [];
                    const responsePeers = [];
                    let anyProtocolViolation = false;

                    for (const entry of peerResults) {
                        if (entry.status === 'rejected') {
                            const reason = entry.reason;
                            const reasonMsg = String(reason?.message || reason || 'spawn rejected');
                            store.saveFailedAttempt(sessionId, entry.agent, 'spawn_rejected', {
                                stderr_tail: reasonMsg,
                                failure_class: 'spawn_rejected',
                                round: roundNum,
                                retry_attempt: 0,
                            });
                            log('ask_peers: peer rejected', {
                                round: roundNum,
                                agent: entry.agent,
                                reason: reasonMsg.slice(-200),
                            });
                            responsePeers.push({
                                agent: entry.agent,
                                status: 'rejected',
                                reason: reasonMsg.slice(-400),
                            });
                            anyProtocolViolation = true;
                            continue;
                        }
                        const { stdout, stderr, peer_model: peerModel } = entry.value;
                        const parsed = parsePeerOutputs(stdout, peerModel);
                        const fname = store.savePeerResponse(
                            sessionId,
                            roundNum,
                            entry.agent,
                            stdout,
                            parsed.peer_status
                        );
                        if (parsed.protocol_violation) anyProtocolViolation = true;
                        roundPeers.push({
                            agent: entry.agent,
                            peer_status: parsed.peer_status,
                            peer_structured: parsed.peer_structured,
                            status_source: parsed.status_source,
                            parser_warnings: parsed.parser_warnings,
                            peer_model: peerModel,
                            model_requested: parsed.model_requested,
                            model_reported: parsed.model_reported,
                            model_match: parsed.model_match,
                            model_failure_class: parsed.model_failure_class,
                            peer_file: fname,
                            protocol_violation: parsed.protocol_violation,
                        });
                        responsePeers.push({
                            agent: entry.agent,
                            status: 'fulfilled',
                            peer_status: parsed.peer_status,
                            peer_structured: parsed.peer_structured,
                            status_source: parsed.status_source,
                            parser_warnings: parsed.parser_warnings,
                            peer_model: peerModel,
                            model_requested: parsed.model_requested,
                            model_reported: parsed.model_reported,
                            model_match: parsed.model_match,
                            model_failure_class: parsed.model_failure_class,
                            protocol_violation: parsed.protocol_violation,
                            content: stdout,
                            stderr_tail: (stderr || '').slice(-400),
                        });
                    }

                    store.appendRound(sessionId, {
                        round: roundNum,
                        caller: CALLER,
                        caller_status: callerStatus,
                        peers: roundPeers,
                        quorum: {
                            requested: PEERS.length,
                            responded: roundPeers.length,
                            rejected: PEERS.length - roundPeers.length,
                        },
                        protocol_violation: anyProtocolViolation,
                        duration_ms: durationMs,
                        completed_at: new Date().toISOString(),
                    });

                    const allPeersReady =
                        roundPeers.length === PEERS.length &&
                        roundPeers.every((p) => p.peer_status === 'READY');

                    log('ask_peers: done', {
                        round: roundNum,
                        caller_status: callerStatus,
                        peers_responded: roundPeers.length,
                        peers_requested: PEERS.length,
                        converged_this_round: callerStatus === 'READY' && allPeersReady,
                        duration_ms: durationMs,
                    });

                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(
                                    {
                                        round: roundNum,
                                        caller_status: callerStatus,
                                        peers: responsePeers,
                                        quorum: {
                                            requested: PEERS.length,
                                            responded: roundPeers.length,
                                            rejected: PEERS.length - roundPeers.length,
                                        },
                                        protocol_violation: anyProtocolViolation,
                                        duration_ms: durationMs,
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                } finally {
                    store.releaseLock(sessionId);
                }
            }
            default:
                throw new Error(`unknown tool: ${name}`);
        }
    } catch (err) {
        log(`error in ${name}: ${err?.message || err}`);
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ error: String(err?.message || err) }, null, 2),
                },
            ],
            isError: true,
        };
    }
});

async function main() {
    log(`starting v${VERSION}, caller=${CALLER}, peers=${PEERS.join(',')}, legacy_bilateral_peer=${LEGACY_PEER || '(none)'}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('stdio transport connected');
}

main().catch((err) => {
    process.stderr.write(
        `[cross-review-mcp] fatal: ${err?.stack || err?.message || err}\n`
    );
    process.exit(1);
});

// Exported only for test harness (unit tests that require() the module
// without activating the stdio transport should set
// CROSS_REVIEW_TEST_IMPORT=1 and replace main() with a no-op before
// require; in practice, tests drive the server via stdio JSON-RPC).
module.exports = {
    VERSION,
    VALID_AGENTS,
    CALLER,
    PEERS,
    LEGACY_PEER,
    attachPromptTailDirective,
    parsePeerOutputs,
};
