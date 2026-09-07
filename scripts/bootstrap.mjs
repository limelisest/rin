// Dependency-free cold start only. Installer policy and behavior live in TypeScript.
import {spawn} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

async function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    candidates.push(join(directory,'npm'), join(directory,'node_modules/npm/bin/npm-cli.js'));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { const path = await realpath(candidate); if (basename(path) === 'npm-cli.js') return path; } catch {}
  }
  throw new Error('npm CLI was not found. Install Node.js with npm and retry.');
}

export async function bootstrapSource(directory) {
  const root = await realpath(directory), npm = await npmCli();
  for (const args of [['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'], ['run','build']]) {
    await new Promise((accept,reject) => {
      const child = spawn(process.execPath,[npm,...args],{cwd:root,stdio:'inherit'});
      child.once('error',reject);
      child.once('close',(code,signal) => code === 0 ? accept() : reject(new Error(`Installer preparation failed (${signal || code})`)));
    });
  }
  const {bootstrap} = await import(pathToFileURL(join(root,'dist/install/bootstrap.js')).href);
  await bootstrap();
}
