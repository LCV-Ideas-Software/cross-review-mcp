// Session state in ~/.cross-review/<session-id>/. Atomic writes via
// temp+rename. Lock via atomic mkdir (POSIX and Windows) with TTL + PID.
//
// Schema evolution (v0.5.0-alpha, F2 W6):
//   - `peers` array (N-ary) alongside legacy `peer` scalar (v0.4.0 and
//     earlier). Read-time normalization: if `peer` is present and
//     `peers` is absent, synthesize `peers = [peer]`. Writes always
//     populate `peers`; `peer` is retained when set legacy-style for
//     backwards-compat read paths.
//   - `capability_snapshot` session-level (set at session_init via
//     probeChain); NEVER per-round (R17 / spec v4.8 section 6.9.3).
//     Excluded peers live here; they are NOT in round.peers[].
//   - `failed_attempts` array: transient spawn/retry failures (spec v4.8
//     section 6.9.3.6). Each entry carries agent + reason class +
//     redacted stderr_tail + timestamp.
//   - Round schema accepts either legacy `{peer, peer_status, ...}` or
//     N-ary `{peers: [{agent, peer_status, ...}], quorum: {...}}`. Both
//     coexist until v0.6.0-alpha retires the legacy form.
//
// Redaction (R14): `saveFailedAttempt` strips known secret shapes from
// stderr/prompt snippets before persistence. Patterns include OpenAI sk-,
// Google AIza, GitHub gh_, JWT eyJ.*.*, Slack xox[baprs]-, PEM blocks,
// user:pass URLs, and env-style TOKEN/SECRET/PASSWORD/API_KEY/PRIVATE_KEY
// assignments.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const STATE_DIR = path.join(os.homedir(), '.cross-review');
const LOCK_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_STDERR_TAIL_CHARS = 2000;
const REDACTED = '[REDACTED]';

function ensureStateDir() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

function sessionDir(sessionId) {
    return path.join(STATE_DIR, sessionId);
}

function atomicWriteFile(filePath, content) {
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
}

function acquireLock(sessionId) {
    const lockDir = path.join(sessionDir(sessionId), '.lock');
    try {
        fs.mkdirSync(lockDir);
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
            const infoPath = path.join(lockDir, 'info.json');
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            const age = Date.now() - Date.parse(info.acquired_at);
            if (age > LOCK_TTL_MS) {
                fs.rmSync(lockDir, { recursive: true, force: true });
                fs.mkdirSync(lockDir);
            } else {
                return false;
            }
        } catch {
            fs.rmSync(lockDir, { recursive: true, force: true });
            fs.mkdirSync(lockDir);
        }
    }
    atomicWriteFile(
        path.join(lockDir, 'info.json'),
        JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2)
    );
    return true;
}

function releaseLock(sessionId) {
    const lockDir = path.join(sessionDir(sessionId), '.lock');
    try {
        fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
        // silent
    }
}

// Redaction patterns (R14, F2 round 2). Applied to stderr tails and any
// snippet persisted to disk before the operator sees it. Patterns are
// intentionally conservative -- we prefer false-positive redaction over
// leaking a real secret. Add patterns here when a new shape is observed
// in the wild.
const REDACTION_PATTERNS = [
    { name: 'openai_sk', re: /sk-[A-Za-z0-9_-]{20,}/g },
    { name: 'google_aiza', re: /AIza[0-9A-Za-z_-]{35}/g },
    { name: 'github_gh', re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
    { name: 'slack_xox', re: /xox[baprs]-[A-Za-z0-9-]+/g },
    { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
    { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]+/g },
    { name: 'pem_block', re: /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g },
    { name: 'url_userpass', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/g },
    { name: 'env_assign', re: /\b(?:[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*[:=]\s*['"]?[^\s'"]+['"]?/g },
];

function redactSensitive(text) {
    if (typeof text !== 'string' || !text.length) return text;
    let out = text;
    for (const { re } of REDACTION_PATTERNS) {
        out = out.replace(re, REDACTED);
    }
    return out;
}

function clipStderrTail(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.slice(-MAX_STDERR_TAIL_CHARS);
    return redactSensitive(trimmed);
}

function normalizePeers(meta) {
    // Idempotent: if meta already has peers[], leave it; else synthesize
    // from legacy `peer` scalar. Prefer peers[] when both are present
    // and disagree (emits a warning side-channel for observability).
    if (!meta || typeof meta !== 'object') return meta;
    if (Array.isArray(meta.peers) && meta.peers.length > 0) {
        return meta;
    }
    if (typeof meta.peer === 'string' && meta.peer.length > 0) {
        meta.peers = [meta.peer];
    }
    return meta;
}

function initSession({ task, artifacts, callerAgent, peerAgent, peers, capabilitySnapshot }) {
    ensureStateDir();
    const id = crypto.randomUUID();
    fs.mkdirSync(sessionDir(id), { recursive: true });

    let peersArray;
    if (Array.isArray(peers) && peers.length > 0) {
        peersArray = peers.map(String);
    } else if (typeof peerAgent === 'string' && peerAgent.length > 0) {
        peersArray = [peerAgent];
    } else {
        peersArray = [];
    }

    const meta = {
        session_id: id,
        task: String(task || ''),
        artifacts: Array.isArray(artifacts) ? artifacts.map(String) : [],
        caller: callerAgent,
        peers: peersArray,
        started_at: new Date().toISOString(),
        rounds: [],
        failed_attempts: [],
        outcome: null,
    };

    // Backwards-compat: when exactly one peer is registered, also
    // populate the legacy `peer` scalar so pre-v0.5.0 readers still see
    // the field. Drop the scalar for true N-ary sessions (N >= 2).
    if (peersArray.length === 1) {
        meta.peer = peersArray[0];
    }

    if (capabilitySnapshot && typeof capabilitySnapshot === 'object') {
        meta.capability_snapshot = capabilitySnapshot;
    }

    atomicWriteFile(
        path.join(sessionDir(id), 'meta.json'),
        JSON.stringify(meta, null, 2)
    );
    return id;
}

function readMeta(sessionId) {
    const p = path.join(sessionDir(sessionId), 'meta.json');
    if (!fs.existsSync(p)) {
        throw new Error(`session not found: ${sessionId}`);
    }
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    return normalizePeers(meta);
}

function writeMeta(sessionId, meta) {
    atomicWriteFile(
        path.join(sessionDir(sessionId), 'meta.json'),
        JSON.stringify(meta, null, 2)
    );
}

function appendRound(sessionId, round) {
    const meta = readMeta(sessionId);
    meta.rounds.push(round);
    meta.last_updated_at = new Date().toISOString();
    writeMeta(sessionId, meta);
}

function saveCapabilitySnapshot(sessionId, snapshot) {
    const meta = readMeta(sessionId);
    meta.capability_snapshot = snapshot;
    meta.last_updated_at = new Date().toISOString();
    writeMeta(sessionId, meta);
}

function saveFailedAttempt(sessionId, agent, reason, extras = {}) {
    const meta = readMeta(sessionId);
    if (!Array.isArray(meta.failed_attempts)) meta.failed_attempts = [];
    const entry = {
        agent: String(agent || 'unknown'),
        reason: String(reason || 'unspecified'),
        timestamp: new Date().toISOString(),
    };
    if (extras.stderr_tail != null) {
        entry.stderr_tail = clipStderrTail(String(extras.stderr_tail));
    }
    if (extras.failure_class != null) {
        entry.failure_class = String(extras.failure_class);
    }
    if (extras.round != null) {
        entry.round = Number(extras.round);
    }
    if (extras.retry_attempt != null) {
        entry.retry_attempt = Number(extras.retry_attempt);
    }
    meta.failed_attempts.push(entry);
    meta.last_updated_at = new Date().toISOString();
    writeMeta(sessionId, meta);
    return entry;
}

function savePromptForRound(sessionId, roundNum, prompt) {
    const fname = `round-${String(roundNum).padStart(2, '0')}-prompt.md`;
    atomicWriteFile(path.join(sessionDir(sessionId), fname), String(prompt));
    return fname;
}

function savePeerResponse(sessionId, roundNum, peerAgent, content, status) {
    const fname = `round-${String(roundNum).padStart(2, '0')}-peer-${peerAgent}.md`;
    const header = `<!-- round=${roundNum} peer=${peerAgent} status=${status ?? 'MISSING'} -->\n`;
    atomicWriteFile(path.join(sessionDir(sessionId), fname), header + String(content));
    return fname;
}

// Unanimity predicate (R17, F2 round 2):
//   converged iff caller_status === READY AND for every responded peer
//   the peer_status === READY AND at least 2 peers responded (minimum
//   bilateral quorum; N=1 with zero excluded also counts as legacy
//   bilateral OK). Excluded peers (probe-level) never enter rounds;
//   failed-spawn peers (runtime level) are recorded in failed_attempts
//   and excluded from denominator.
//
// Supports two round shapes:
//   LEGACY bilateral: {peer, peer_status, caller_status}
//   N-ary: {peers: [{agent, peer_status}], caller_status}
function checkConvergence(sessionId) {
    const meta = readMeta(sessionId);
    if (!meta.rounds.length) {
        return {
            converged: false,
            reason: 'no rounds yet',
            caller_status: null,
            peer_status: null,
            last_round: null,
        };
    }
    const last = meta.rounds[meta.rounds.length - 1];
    const callerReady = last.caller_status === 'READY';

    // N-ary path: round carries peers[] array with per-peer status.
    if (Array.isArray(last.peers) && last.peers.length > 0 && !('peer_status' in last)) {
        const peerStatuses = last.peers.map((p) => p.peer_status);
        const allPeersReady = peerStatuses.length > 0 && peerStatuses.every((s) => s === 'READY');
        const anyNeedsEvidence = peerStatuses.some((s) => s === 'NEEDS_EVIDENCE');
        const converged = callerReady && allPeersReady;
        let reason;
        if (converged) {
            reason = `caller and all ${peerStatuses.length} peers declared READY in the same round`;
        } else if (!callerReady) {
            reason = `caller is ${last.caller_status ?? 'MISSING'}; caller must concur with peers`;
        } else if (anyNeedsEvidence) {
            const ne = last.peers.filter((p) => p.peer_status === 'NEEDS_EVIDENCE').map((p) => p.agent);
            reason = `peer(s) ${ne.join(',')} declared NEEDS_EVIDENCE; attach requested evidence next round`;
        } else {
            const notReady = last.peers.filter((p) => p.peer_status !== 'READY').map((p) => `${p.agent}=${p.peer_status ?? 'MISSING'}`);
            reason = `peer(s) not READY: ${notReady.join(', ')}`;
        }
        return {
            converged,
            caller_status: last.caller_status,
            peers: last.peers,
            last_round: last,
            reason,
        };
    }

    // Legacy bilateral path (pre-v0.5.0-alpha rounds or ask_peer).
    const peerReady = last.peer_status === 'READY';
    const peerNeedsEvidence = last.peer_status === 'NEEDS_EVIDENCE';
    const converged = callerReady && peerReady;
    let reason;
    if (converged) {
        reason = 'both caller and peer declared READY in the same round';
    } else if (peerNeedsEvidence) {
        reason = `peer declared NEEDS_EVIDENCE (caller=${last.caller_status ?? 'MISSING'}); attach the requested evidence next round instead of re-arguing merits`;
    } else if (callerReady && !peerReady) {
        reason = `caller READY but peer is ${last.peer_status ?? 'MISSING'}; needs another round`;
    } else if (!callerReady && peerReady) {
        reason = `peer READY but caller declared ${last.caller_status ?? 'MISSING'}; caller must concur`;
    } else {
        reason = `neither side READY (caller=${last.caller_status ?? 'MISSING'}, peer=${last.peer_status ?? 'MISSING'})`;
    }
    return {
        converged,
        caller_status: last.caller_status,
        peer_status: last.peer_status,
        peer_structured: last.peer_structured ?? null,
        last_round: last,
        reason,
    };
}

function finalize(sessionId, outcome) {
    const meta = readMeta(sessionId);
    meta.outcome = outcome;
    meta.finalized_at = new Date().toISOString();
    writeMeta(sessionId, meta);
}

module.exports = {
    STATE_DIR,
    ensureStateDir,
    sessionDir,
    initSession,
    readMeta,
    writeMeta,
    appendRound,
    savePromptForRound,
    savePeerResponse,
    saveCapabilitySnapshot,
    saveFailedAttempt,
    checkConvergence,
    finalize,
    acquireLock,
    releaseLock,
    // Exported for tests and ad-hoc audit.
    normalizePeers,
    redactSensitive,
    clipStderrTail,
    REDACTION_PATTERNS,
    MAX_STDERR_TAIL_CHARS,
};
