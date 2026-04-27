// Peer self-reported model parser (sibling to status-parser.js).
// Introduced in v0.5.0-alpha to defend against silent model downgrade
// (F2 round 2 discovery: Gemini CLI 0.39.1 accepts non-existent model
// IDs and silently responds with a smaller model). The spec formalization
// is deferred to v4.9 per F2 Q4 decision (b); the runtime defense ships
// now with a TODO-spec-v4.9 marker.
//
// Contract:
//
// The peer is prompted to emit two structured blocks at the tail of its
// response, in this exact order:
//
//     <cross_review_peer_model>{"model_id":"<canonical model id>"}</cross_review_peer_model>
//     <cross_review_status>{"status":"READY|NOT_READY|NEEDS_EVIDENCE", ...}</cross_review_status>
//
// The status block MUST be the last non-empty token (existing
// status-parser.js contract, unchanged). The peer-model block MUST be
// the penultimate structured block (i.e., appear immediately before the
// status block, after any intervening whitespace but before any
// non-whitespace content that would separate the two).
//
// parseDeclaredModel(text) returns:
//   { model_id: string, source: 'structured', parser_warnings: [] }
//     when a valid peer-model block is found in the correct position.
//   { model_id: null, source: null, parser_warnings: [warn...] }
//     otherwise (missing, malformed JSON, missing required field,
//     misplaced relative to status block).
//
// This parser NEVER consumes or modifies the status-block region. It
// reads the text leading up to (but not including) the status block's
// opening tag, then applies the same tail-anchoring discipline to that
// prefix.
//
// Sibling discipline (R20, F2 round 2): parseDeclaredModel does NOT
// share state with parsePeerResponse. Callers run both independently on
// the same response text. Neither parser sees the other's output.

"use strict";

const STATUS_OPEN_TAG = "<cross_review_status>";
const STATUS_CLOSE_TAG = "</cross_review_status>";
const MODEL_OPEN_TAG = "<cross_review_peer_model>";
const MODEL_CLOSE_TAG = "</cross_review_peer_model>";
const MAX_MODEL_ID_CHARS = 120;

function rightTrim(s) {
	return s.trimEnd();
}

// Return { prefix, stripped } where:
//   stripped = true iff the rtrimmed tail actually ends with a
//     structurally paired status block (open tag found before the
//     close tag). In that case prefix is the text BEFORE that pair.
//   stripped = false when the tail does not end with a paired status
//     block. In that case prefix is null -- the response violates the
//     tail-order discipline and the model-parser refuses to return a
//     model_id (without inspecting the VALIDITY of the status block
//     payload, preserving R20 sibling discipline).
function sliceBeforeStatusBlock(text) {
	const rtrimmed = rightTrim(text);
	if (!rtrimmed.endsWith(STATUS_CLOSE_TAG))
		return { prefix: null, stripped: false };
	const closeAt = rtrimmed.length - STATUS_CLOSE_TAG.length;
	const openAt = rtrimmed.lastIndexOf(STATUS_OPEN_TAG, closeAt - 1);
	if (openAt < 0) return { prefix: null, stripped: false };
	return { prefix: rtrimmed.slice(0, openAt), stripped: true };
}

function parseDeclaredModel(text) {
	const empty = (warnings = []) => ({
		model_id: null,
		source: null,
		parser_warnings: warnings,
	});

	if (typeof text !== "string" || !text.length) {
		return empty();
	}

	const { prefix: rawPrefix, stripped } = sliceBeforeStatusBlock(text);
	if (!stripped) {
		return empty([
			"status block not at tail; peer-model positioning cannot be validated without a trailing status block",
		]);
	}

	const prefix = rightTrim(rawPrefix);
	if (!prefix.length) {
		return empty([
			"peer-model block missing (response empty before status block)",
		]);
	}

	if (!prefix.endsWith(MODEL_CLOSE_TAG)) {
		return empty([
			"peer-model block missing or not positioned immediately before status block",
		]);
	}

	const closeAt = prefix.length - MODEL_CLOSE_TAG.length;
	const openAt = prefix.lastIndexOf(MODEL_OPEN_TAG, closeAt - 1);
	if (openAt < 0) {
		return empty(["peer-model close tag present without matching open tag"]);
	}

	const payload = prefix.slice(openAt + MODEL_OPEN_TAG.length, closeAt).trim();
	if (!payload) {
		return empty(["peer-model block payload is empty"]);
	}

	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return empty(["peer-model block payload is not valid JSON"]);
	}

	if (
		parsed == null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		typeof parsed.model_id !== "string"
	) {
		return empty([
			"peer-model block payload does not contain a string model_id field",
		]);
	}

	const id = parsed.model_id.trim();
	if (!id.length) {
		return empty(["peer-model block model_id is empty after trim"]);
	}
	if (id.length > MAX_MODEL_ID_CHARS) {
		return empty([
			`peer-model block model_id exceeds ${MAX_MODEL_ID_CHARS} chars`,
		]);
	}

	return {
		model_id: id,
		source: "structured",
		parser_warnings: [],
	};
}

// Classify the outcome of comparing reported vs requested model.
// - 'ok': model_id matched (or either side is null by design, e.g.
//         stub peer where model comparison is skipped at a higher layer).
// - 'silent_model_downgrade': both present and different.
// - 'missing_model_report': requested present but reported missing.
function classifyModelMatch(requested, reported) {
	if (!requested || !reported) {
		return reported ? "ok" : "missing_model_report";
	}
	return requested === reported ? "ok" : "silent_model_downgrade";
}

module.exports = {
	parseDeclaredModel,
	classifyModelMatch,
	MODEL_OPEN_TAG,
	MODEL_CLOSE_TAG,
	MAX_MODEL_ID_CHARS,
};
