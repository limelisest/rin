import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,copyFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareSetupDependencies} from '../src/install/bootstrap.mjs';

async function root(t, installed) {
  const path = await mkdtemp(join(tmpdir(), 'rin-setup-bootstrap-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  await writeFile(join(path, 'package.json'), JSON.stringify({dependencies: {'@clack/prompts': '0.10.1'}}));
  if (installed) {
    await mkdir(join(path, 'node_modules/@clack/prompts'), {recursive: true});
    await writeFile(join(path, 'node_modules/@clack/prompts/package.json'), JSON.stringify({version: installed}));
  }
  return path;
}

test('a clean installer root prepares Clack before setup import', async t => {
  const calls = [], path = await root(t);
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.match(args[0], /npm-cli\.js$/);
  assert.deepEqual(args.slice(1), ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(options, {cwd: path});
});

test('a matching installed Clack version skips npm preparation', async t => {
  const calls = [], path = await root(t, '0.10.1');
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.deepEqual(calls, []);
});

// Exercise the real bootstrap entrypoint without installing packages or services.
test('bootstrap runs through a symlinked directory and stays inert when imported', async t => {
  const path = await root(t, '0.10.1');
  const source = join(path, 'source');
  await mkdir(join(source, 'src/install'), {recursive: true});
  await copyFile(new URL('../src/install/bootstrap.mjs', import.meta.url), join(source, 'src/install/bootstrap.mjs'));
  await copyFile(join(path, 'package.json'), join(source, 'package.json'));
  await mkdir(join(source, 'node_modules/@clack/prompts'), {recursive: true});
  await copyFile(join(path, 'node_modules/@clack/prompts/package.json'), join(source, 'node_modules/@clack/prompts/package.json'));
  await writeFile(join(source, 'src/install/core.mjs'), "export function findNpmCli(){throw Error('unexpected npm')} export function run(){throw Error('unexpected install')}");
  await writeFile(join(source, 'src/install/setup.mjs'), "export async function setup(){console.log('SETUP_STARTED')}");
  const alias = join(path, 'alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const directory of [source, alias]) {
    const result = spawnSync(process.execPath, [join(directory, 'src/install/bootstrap.mjs')], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'SETUP_STARTED');
  }
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(alias, 'src/install/bootstrap.mjs')).href)})`], {encoding: 'utf8'});
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});
