// Cold-start glue: Node cannot load TypeScript before dependencies are installed.
import {realpath} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {bootstrapSource} from '../../scripts/bootstrap.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  bootstrapSource(fileURLToPath(new URL('../..', import.meta.url))).catch(error => {
    if (error?.code !== 'INSTALL_CANCELLED') console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
