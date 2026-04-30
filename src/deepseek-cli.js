#!/usr/bin/env node

/**
 * cross-review-v1 embedded DeepSeek CLI.
 *
 * This binary is intentionally small and project-owned. It is NOT a fork of
 * any other provider CLI and it never reads or writes another tool's profile
 * directory. Its only persistent state is the operator-provided
 * DEEPSEEK_API_KEY environment variable.
 *
 * The cross-review-v1 orchestrator still treats DeepSeek as a CLI peer: prompt
 * content is delivered through stdin and the peer response is read from stdout.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
	StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MCP_CONFIG_PATH = path.resolve(
	__dirname,
	"..",
	"reviewer-configs",
	"deepseek-cli.mcp.json",
);
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_TOOL_TURNS = 8;
const DEFAULT_ALLOWED_MCP_SERVERS = ["memory", "ultrathink", "code-reasoning"];

function usage() {
	return `cross-review-v1-deepseek-cli

Usage:
  cross-review-v1-deepseek-cli [options]

Options:
  -m, --model <id>              DeepSeek model id (default: ${DEFAULT_MODEL})
  -p, --prompt <text>           Prompt fragment appended after stdin
  --system <text>               System prompt
  --base-url <url>              DeepSeek API base URL (default: env DEEPSEEK_BASE_URL or ${DEFAULT_BASE_URL})
  --max-tokens <n>              max_tokens (default: env DEEPSEEK_MAX_TOKENS or ${DEFAULT_MAX_TOKENS})
  --reasoning-effort <value>    high|max (default: env DEEPSEEK_REASONING_EFFORT or max)
  --thinking <enabled|disabled> Thinking mode toggle (default: enabled)
  --timeout-ms <n>              Request timeout in ms (default: env DEEPSEEK_TIMEOUT_MS or ${DEFAULT_TIMEOUT_MS})
  --output-format <text|json>   Output format (default: text)
  --mcp-config <path>           MCP config JSON with mcpServers (default: env DEEPSEEK_MCP_CONFIG or ${DEFAULT_MCP_CONFIG_PATH})
  --allowed-mcp-server-names <n> Allow one MCP server name (repeatable)
  --allow-all-mcp-servers       Expose every stdio server from --mcp-config
  --max-tool-turns <n>          Max internal tool-call turns (default: env DEEPSEEK_MAX_TOOL_TURNS or ${DEFAULT_MAX_TOOL_TURNS})
  -h, --help                    Show this help
  -V, --version                 Show package version

Environment:
  DEEPSEEK_API_KEY              Required API key
`;
}

function parseArgs(argv) {
	const opts = {
		model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
		prompt: "",
		system:
			process.env.DEEPSEEK_SYSTEM_PROMPT ||
			"You are a rigorous cross-review peer. Follow the user's protocol exactly.",
		baseUrl: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
		maxTokens: readPositiveInt(
			process.env.DEEPSEEK_MAX_TOKENS,
			DEFAULT_MAX_TOKENS,
		),
		reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "max",
		thinking: process.env.DEEPSEEK_THINKING || "enabled",
		timeoutMs: readPositiveInt(process.env.DEEPSEEK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		outputFormat: "text",
		mcpConfig: process.env.DEEPSEEK_MCP_CONFIG || DEFAULT_MCP_CONFIG_PATH,
		allowedMcpServerNames:
			process.env.DEEPSEEK_ALLOWED_MCP_SERVERS === undefined
				? [...DEFAULT_ALLOWED_MCP_SERVERS]
				: parseList(process.env.DEEPSEEK_ALLOWED_MCP_SERVERS),
		allowAllMcpServers: false,
		maxToolTurns: readPositiveInt(
			process.env.DEEPSEEK_MAX_TOOL_TURNS,
			DEFAULT_MAX_TOOL_TURNS,
		),
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			opts.help = true;
			continue;
		}
		if (arg === "-V" || arg === "--version") {
			opts.version = true;
			continue;
		}
		if (arg === "-m" || arg === "--model") {
			opts.model = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "-p" || arg === "--prompt") {
			opts.prompt = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--system") {
			opts.system = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--base-url") {
			opts.baseUrl = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--max-tokens") {
			opts.maxTokens = readPositiveInt(requireValue(argv, ++i, arg), null);
			if (!opts.maxTokens) throw new Error("--max-tokens must be a positive integer");
			continue;
		}
		if (arg === "--reasoning-effort") {
			opts.reasoningEffort = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--thinking") {
			opts.thinking = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--timeout-ms") {
			opts.timeoutMs = readPositiveInt(requireValue(argv, ++i, arg), null);
			if (!opts.timeoutMs) throw new Error("--timeout-ms must be a positive integer");
			continue;
		}
		if (arg === "--output-format" || arg === "-o") {
			opts.outputFormat = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--mcp-config") {
			opts.mcpConfig = requireValue(argv, ++i, arg);
			continue;
		}
		if (arg === "--allowed-mcp-server-names") {
			opts.allowedMcpServerNames.push(requireValue(argv, ++i, arg));
			continue;
		}
		if (arg === "--allow-all-mcp-servers") {
			opts.allowAllMcpServers = true;
			continue;
		}
		if (arg === "--max-tool-turns") {
			opts.maxToolTurns = readPositiveInt(requireValue(argv, ++i, arg), null);
			if (!opts.maxToolTurns) {
				throw new Error("--max-tool-turns must be a positive integer");
			}
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}

	if (!["high", "max"].includes(opts.reasoningEffort)) {
		throw new Error("--reasoning-effort must be high or max");
	}
	if (!["enabled", "disabled"].includes(opts.thinking)) {
		throw new Error("--thinking must be enabled or disabled");
	}
	if (!["text", "json"].includes(opts.outputFormat)) {
		throw new Error("--output-format must be text or json");
	}
	if (opts.allowAllMcpServers) {
		opts.allowedMcpServerNames = [];
	}

	return opts;
}

function parseList(raw) {
	return String(raw || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function readPositiveInt(raw, fallback) {
	const n = Number.parseInt(String(raw || ""), 10);
	if (Number.isInteger(n) && n > 0) return n;
	return fallback;
}

function requireValue(argv, index, flag) {
	if (index >= argv.length || argv[index].startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return argv[index];
}

function expandEnvPlaceholders(value) {
	if (typeof value === "string") {
		return value
			.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
				process.env[name] || "",
			)
			.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
				process.env[name] || "",
			)
			.replace(
				/(^|[^$\\])\$([A-Za-z_][A-Za-z0-9_]*)/g,
				(_, prefix, name) => `${prefix}${process.env[name] || ""}`,
			)
			.replace(/\\\$([A-Za-z_][A-Za-z0-9_]*)/g, "$$$1");
	}
	if (Array.isArray(value)) return value.map((item) => expandEnvPlaceholders(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				expandEnvPlaceholders(item),
			]),
		);
	}
	return value;
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let input = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			input += chunk;
		});
		process.stdin.on("error", reject);
		process.stdin.on("end", () => resolve(input));
	});
}

function endpoint(baseUrl) {
	return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
}

async function postChat(opts, messages, tools) {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) {
		throw new Error("DEEPSEEK_API_KEY is required");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	if (typeof timer.unref === "function") timer.unref();

	const payload = {
		model: opts.model,
		messages,
		thinking: { type: opts.thinking },
		reasoning_effort: opts.reasoningEffort,
		max_tokens: opts.maxTokens,
		stream: false,
	};
	if (tools.length > 0) {
		payload.tools = tools;
		payload.tool_choice = "auto";
	}

	try {
		const res = await fetch(endpoint(opts.baseUrl), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		const text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			// Keep raw body in error below.
		}
		if (!res.ok) {
			const providerMessage =
				json?.error?.message || json?.message || text.slice(0, 1000);
			const err = new Error(
				`DeepSeek API ${res.status} ${res.statusText}: ${providerMessage}`,
			);
			err.status = res.status;
			err.response = json || text;
			throw err;
		}
		return json;
	} finally {
		clearTimeout(timer);
	}
}

function toolResultToText(result) {
	if (!result) return "";
	if (Array.isArray(result.content)) {
		return result.content
			.map((item) => {
				if (typeof item?.text === "string") return item.text;
				if (item?.type === "image") return "[image omitted]";
				return JSON.stringify(item);
			})
			.join("\n");
	}
	return JSON.stringify(result);
}

function sanitizeToolName(serverName, toolName, usedNames) {
	const raw = `${serverName}__${toolName}`;
	let safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	if (!/^[A-Za-z0-9_-]+$/.test(safe) || !safe) safe = "mcp_tool";
	let candidate = safe;
	let suffix = 2;
	while (usedNames.has(candidate)) {
		const tail = `_${suffix}`;
		candidate = `${safe.slice(0, 64 - tail.length)}${tail}`;
		suffix += 1;
	}
	usedNames.add(candidate);
	return candidate;
}

async function loadMcpTools(opts) {
	if (!opts.mcpConfig) return { tools: [], toolMap: new Map(), clients: [] };
	const configPath = path.resolve(expandEnvPlaceholders(opts.mcpConfig));
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const servers = config.mcpServers || config.servers || {};
	const allow = new Set(opts.allowedMcpServerNames);
	const tools = [];
	const toolMap = new Map();
	const clients = [];
	const usedNames = new Set();

	for (const [serverName, serverConfig] of Object.entries(servers)) {
		if (!opts.allowAllMcpServers && allow.size > 0 && !allow.has(serverName)) {
			continue;
		}
		if (!serverConfig || serverConfig.type === "http" || serverConfig.url) {
			process.stderr.write(
				`mcp: skipping ${serverName}; only stdio MCP servers are supported by cross-review-v1-deepseek-cli\n`,
			);
			continue;
		}
		const command = expandEnvPlaceholders(serverConfig.command);
		if (!command) {
			process.stderr.write(`mcp: skipping ${serverName}; command missing\n`);
			continue;
		}
		const serverEnv = expandEnvPlaceholders(serverConfig.env || {});
		const transport = new StdioClientTransport({
			command,
			args: Array.isArray(serverConfig.args)
				? expandEnvPlaceholders(serverConfig.args)
				: [],
			env: { ...process.env, ...serverEnv },
			cwd: expandEnvPlaceholders(serverConfig.cwd),
			stderr: "pipe",
		});
		const client = new Client(
			{ name: "cross-review-v1-deepseek-cli", version: packageVersion() },
			{ capabilities: {} },
		);
		try {
			await client.connect(transport);
			const listed = await client.listTools();
			const serverTools = Array.isArray(listed.tools) ? listed.tools : [];
			for (const tool of serverTools) {
				const functionName = sanitizeToolName(serverName, tool.name, usedNames);
				const parameters =
					tool.inputSchema && typeof tool.inputSchema === "object"
						? tool.inputSchema
						: { type: "object", properties: {} };
				tools.push({
					type: "function",
					function: {
						name: functionName,
						description:
							`MCP ${serverName}/${tool.name}. ${tool.description || ""}`.trim(),
						parameters,
					},
				});
				toolMap.set(functionName, {
					serverName,
					toolName: tool.name,
					client,
				});
			}
			clients.push(client);
			process.stderr.write(
				`mcp: connected ${serverName}, tools=${serverTools.length}\n`,
			);
		} catch (err) {
			try {
				await client.close();
			} catch {}
			process.stderr.write(
				`mcp: ${serverName} unavailable: ${err?.message || err}\n`,
			);
		}
	}

	return { tools, toolMap, clients };
}

function packageVersion() {
	return require("../package.json").version;
}

async function runToolConversation(opts, userPrompt, mcp) {
	const messages = [
		{ role: "system", content: opts.system },
		{ role: "user", content: userPrompt },
	];
	let lastResponse = null;

	for (let turn = 0; turn <= opts.maxToolTurns; turn += 1) {
		lastResponse = await postChat(opts, messages, mcp.tools);
		const message = lastResponse?.choices?.[0]?.message;
		const toolCalls = Array.isArray(message?.tool_calls)
			? message.tool_calls
			: [];
		if (toolCalls.length === 0) return lastResponse;
		if (turn >= opts.maxToolTurns) {
			throw new Error(
				`max tool turns exceeded (${opts.maxToolTurns}); model still requested tools`,
			);
		}
		messages.push(message);
		for (const call of toolCalls) {
			const functionName = call?.function?.name;
			const mapping = mcp.toolMap.get(functionName);
			if (!mapping) {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: `Unknown MCP tool: ${functionName}`,
				});
				continue;
			}
			let args = {};
			try {
				args = call?.function?.arguments
					? JSON.parse(call.function.arguments)
					: {};
			} catch {
				args = {};
			}
			try {
				const result = await mapping.client.callTool({
					name: mapping.toolName,
					arguments: args,
				});
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: toolResultToText(result).slice(0, 120000),
				});
			} catch (err) {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: `MCP tool ${mapping.serverName}/${mapping.toolName} failed: ${err?.message || err}`,
				});
			}
		}
	}

	return lastResponse;
}

function extractContent(response) {
	const message = response?.choices?.[0]?.message;
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((part) => {
				if (typeof part === "string") return part;
				if (typeof part?.text === "string") return part.text;
				return "";
			})
			.join("");
	}
	return "";
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		process.stdout.write(usage());
		return;
	}
	if (opts.version) {
		process.stdout.write(`${packageVersion()}\n`);
		return;
	}
	const stdin = await readStdin();
	const prompt = [stdin, opts.prompt].filter((s) => String(s).trim()).join("\n");
	if (!prompt.trim()) {
		throw new Error("prompt is required via stdin or --prompt");
	}

	const mcp = await loadMcpTools(opts);
	try {
		const response = await runToolConversation(opts, prompt, mcp);
		const model = response?.model || opts.model;
		process.stderr.write(`model: ${model}\n`);

		if (opts.outputFormat === "json") {
			process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
			return;
		}
		process.stdout.write(extractContent(response));
		if (!String(extractContent(response)).endsWith("\n")) {
			process.stdout.write("\n");
		}
	} finally {
		for (const client of mcp.clients) {
			try {
				await client.close();
			} catch {}
		}
	}
}

if (require.main === module) {
	main().catch((err) => {
		const status = err?.status ? ` status=${err.status}` : "";
		process.stderr.write(
			`cross-review-v1-deepseek-cli error${status}: ${err?.message || err}\n`,
		);
		process.exitCode = 1;
	});
}

module.exports = {
	DEFAULT_MODEL,
	DEFAULT_BASE_URL,
	DEFAULT_MCP_CONFIG_PATH,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_MAX_TOKENS,
	DEFAULT_MAX_TOOL_TURNS,
	DEFAULT_ALLOWED_MCP_SERVERS,
	parseArgs,
	readPositiveInt,
	expandEnvPlaceholders,
	endpoint,
	postChat,
	toolResultToText,
	sanitizeToolName,
	loadMcpTools,
	runToolConversation,
	extractContent,
	packageVersion,
	main,
};
