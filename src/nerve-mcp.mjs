// Compatibility entrypoint for existing Rin installations; implementation is TypeScript.
export * from '../dist/nerve-mcp.js';
import * as implementation from '../dist/nerve-mcp.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) { implementation.main().catch(()=>{process.stderr.write('Nerve MCP failed to start; check private configuration and credentials.\n');process.exitCode=1;}); }
