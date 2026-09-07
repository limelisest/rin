// Compatibility entrypoint for existing Rin installations; implementation is TypeScript.
export * from '../../dist/install/setup.js';
import * as implementation from '../../dist/install/setup.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) { implementation.setup().catch(error=>{if(error.code!=='INSTALL_CANCELLED')console.error(error.message);process.exitCode=1;}); }
