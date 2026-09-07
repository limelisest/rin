import {errorCode,errorMessage} from './types.js';
import {readFile,realpath} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findNpmCli,run} from './core.js';

export async function prepareSetupDependencies(root: string, {exec = run} = {}) {
  const expected = JSON.parse(await readFile(join(root,'package.json'),'utf8')).dependencies['@clack/prompts'];
  let installed;
  try { installed = JSON.parse(await readFile(join(root,'node_modules/@clack/prompts/package.json'),'utf8')).version; } catch {}
  if (installed === expected) return;
  await exec(process.execPath,[await findNpmCli(),'ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:root});
}

export async function bootstrap() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  await prepareSetupDependencies(root);
  const {setup} = await import('./setup.js');
  await setup();
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) bootstrap().catch(error => {
  if (errorCode(error) !== 'INSTALL_CANCELLED') console.error(errorMessage(error));
  process.exitCode = 1;
});
