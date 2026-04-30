# Third-Party Components

`cross-review-v1` is a TypeScript-free CommonJS MCP server. Runtime depends solely on `@modelcontextprotocol/sdk` (MIT). The other 90 packages in the lockfile are transitive dependencies of the SDK.

## License inventory (from `package-lock.json`, 91 packages total)

| License | Count |
|---------|-------|
| MIT | 81 |
| ISC | 7 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |

All licenses are permissive and compatible with this project's Apache-2.0 license.

## Direct runtime dependency

| Package | Version | License | Origin |
|---------|---------|---------|--------|
| @modelcontextprotocol/sdk | ^1.18.0 | MIT | https://registry.npmjs.org/@modelcontextprotocol/sdk |

## Notable transitive dependencies (>10% of bundle weight or commonly recognized)

| Package | License | Used for |
|---------|---------|----------|
| express | MIT | Internal SDK HTTP transport |
| body-parser | MIT | Internal SDK request parsing |
| @hono/node-server | MIT | Internal SDK HTTP transport |
| cors | MIT | Internal SDK CORS handling |
| ajv / ajv-formats | MIT | Internal SDK JSON schema validation |
| zod / zod-to-json-schema | MIT | Internal SDK schema definition |
| eventsource / eventsource-parser | MIT | Internal SDK streaming |
| pkce-challenge | MIT | Internal SDK auth |
| express-rate-limit | MIT | Internal SDK rate limiting |
| raw-body | MIT | Internal SDK body parsing |

For an exhaustive package-by-package inventory, run:

```bash
npm ls --all
# or
npx license-checker --production --json
```

`package-lock.json` in the repo root is the authoritative source for all transitive dependencies and their resolved versions.
