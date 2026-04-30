#!/usr/bin/env node

"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
	StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const server = new Server(
	{ name: "cross-review-v1-echo-fixture", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echo a short text payload for smoke tests.",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string" },
				},
				required: ["text"],
				additionalProperties: false,
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [
		{
			type: "text",
			text: String(request.params.arguments?.text || ""),
		},
	],
}));

server.connect(new StdioServerTransport()).catch((err) => {
	process.stderr.write(`mcp-echo-server error: ${err?.message || err}\n`);
	process.exitCode = 1;
});
