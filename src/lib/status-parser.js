// Parse STATUS marker emitido pelo peer. Ancorado na spec 2.1 ("ultima linha
// nao-vazia", trim, regex exata) estendida com NEEDS_EVIDENCE e com a forma
// preferida "bloco estruturado" desde 0.3.0-alpha.
//
// Contrato (em ordem de tentativa; apenas o TAIL nao-branco do texto eh
// inspecionado, garantindo que menciones de STATUS: X no corpo nao disparem):
//
//   1) PREFERIDO: se o tail termina com </cross_review_status>, localiza o
//      <cross_review_status> imediatamente a esquerda; extrai o conteudo,
//      faz trim(), JSON.parse(), valida que o objeto tem { status: string }
//      com status em { READY, NOT_READY, NEEDS_EVIDENCE }. Se tudo OK,
//      retorna { status, structured: <objeto>, source: 'structured' }.
//      Caso contrario (open tag ausente, JSON invalido, status fora do enum,
//      ou o payload nao eh um object JSON), retorna { status: null,
//      structured: null, source: null }. Bloco com status invalido NAO cai
//      no fallback regex, porque a ultima linha nao-vazia ja eh o closing
//      tag, e a regex legacy nao casa com ela.
//
//   2) FALLBACK legacy: examina SOMENTE a ultima linha nao-vazia (apos trim).
//      Aceita regex EXATA e case-sensitive: ^STATUS: (READY|NOT_READY|
//      NEEDS_EVIDENCE)$. Retorna { status, structured: null, source: 'regex' }.
//
//   3) Nada casou: { status: null, structured: null, source: null }.
//
// Motivacao: a spec 2.1 exige extracao da ultima linha nao-vazia com trim e
// regex exata; usar /gim ou scanning global reabre falso positivo por prosa
// contendo STATUS: ... em trechos citados. O requisito analogo para o bloco
// estruturado eh que o TAIL do texto termine com o closing tag canonico.

const VALID_STATUSES = new Set(['READY', 'NOT_READY', 'NEEDS_EVIDENCE']);
const OPEN_TAG = '<cross_review_status>';
const CLOSE_TAG = '</cross_review_status>';
const LEGACY_LINE_RE = /^STATUS: (READY|NOT_READY|NEEDS_EVIDENCE)$/;

function tryStructuredTail(rtrimmed) {
    if (!rtrimmed.endsWith(CLOSE_TAG)) return null;
    const closeAt = rtrimmed.length - CLOSE_TAG.length;
    const openAt = rtrimmed.lastIndexOf(OPEN_TAG, closeAt - 1);
    if (openAt < 0) return null;
    const payload = rtrimmed.slice(openAt + OPEN_TAG.length, closeAt).trim();
    if (!payload) return null;
    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return null;
    }
    if (
        parsed == null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof parsed.status !== 'string' ||
        !VALID_STATUSES.has(parsed.status)
    ) {
        return null;
    }
    return { status: parsed.status, structured: parsed, source: 'structured' };
}

function tryLegacyLastLine(rtrimmed) {
    const lastNewline = rtrimmed.lastIndexOf('\n');
    const lastLine = (lastNewline >= 0 ? rtrimmed.slice(lastNewline + 1) : rtrimmed).trim();
    const m = LEGACY_LINE_RE.exec(lastLine);
    if (!m) return null;
    return { status: m[1], structured: null, source: 'regex' };
}

function parsePeerResponse(text) {
    if (typeof text !== 'string' || !text.length) {
        return { status: null, structured: null, source: null };
    }
    const rtrimmed = text.replace(/\s+$/, '');
    if (!rtrimmed.length) {
        return { status: null, structured: null, source: null };
    }
    const structuredHit = tryStructuredTail(rtrimmed);
    if (structuredHit) return structuredHit;
    const legacyHit = tryLegacyLastLine(rtrimmed);
    if (legacyHit) return legacyHit;
    return { status: null, structured: null, source: null };
}

// Backwards-compat: parseStatus continua retornando string|null para call
// sites antigos. Preferir parsePeerResponse em codigo novo.
function parseStatus(text) {
    return parsePeerResponse(text).status;
}

module.exports = {
    parseStatus,
    parsePeerResponse,
    VALID_STATUSES,
};
