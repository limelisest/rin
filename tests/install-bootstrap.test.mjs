import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,copyFile,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareSetupDependencies} from '../dist/install/bootstrap.js';

async function root(t, installed) {
  const path = await mkdtemp(join(tmpdir(), 'rin-setup-bootstrap-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  await writeFile(join(path, 'package.json'), JSON.stringify({type: 'module', dependencies: {'@clack/prompts': '0.10.1'}}));
  if (installed) {
    await mkdir(join(path, 'node_modules/@clack/prompts'), {recursive: true});
    await writeFile(join(path, 'node_modules/@clack/prompts/package.json'), JSON.stringify({version: installed}));
  }
  return path;
}

test('a clean installer root prepares locked dependencies including the TypeScript compiler', async t => {
  const calls = [], path = await root(t);
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.match(args[0], /npm-cli\.js$/);
  assert.deepEqual(args.slice(1), ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(options, {cwd: path});
});

test('matching Clack skips preparation while mismatched Clack is repaired', async t => {
  const calls = [], path = await root(t, '0.10.1');
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.deepEqual(calls, []);
  await writeFile(join(path, 'node_modules/@clack/prompts/package.json'), JSON.stringify({version: '0.0.0'}));
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.equal(calls.length, 1);
});

async function sourceFixture(t) {
  const path = await root(t);
  await mkdir(join(path, 'src/install'), {recursive: true});
  await mkdir(join(path, 'scripts'), {recursive: true});
  await mkdir(join(path, 'compiled/install'), {recursive: true});
  await copyFile(new URL('../src/install/bootstrap.mjs', import.meta.url), join(path, 'src/install/bootstrap.mjs'));
  await copyFile(new URL('../scripts/bootstrap.mjs', import.meta.url), join(path, 'scripts/bootstrap.mjs'));
  for (const name of ['bootstrap', 'core', 'types']) {
    await copyFile(new URL(`../dist/install/${name}.js`, import.meta.url), join(path, `compiled/install/${name}.js`));
  }
  await writeFile(join(path, 'compiled/install/setup.js'), "export async function setup(){console.log('SETUP_STARTED')}");
  // Mimic npm's phase boundary without network, package installation, or services.
  await writeFile(join(path, 'npm-cli.js'), `
    import {appendFile,mkdir,writeFile,cp} from 'node:fs/promises';
    import {join} from 'node:path';
    const args = process.argv.slice(2), root = process.cwd();
    await appendFile(join(root,'npm-calls.jsonl'), JSON.stringify({args,root})+'\\n');
    if (args[0] === 'ci') {
      await mkdir(join(root,'node_modules/@clack/prompts'),{recursive:true});
      await writeFile(join(root,'node_modules/@clack/prompts/package.json'),JSON.stringify({version:'0.10.1'}));
    } else if (args.join(' ') === 'run build') {
      if (process.env.RIN_TEST_BUILD_FAIL) process.exit(9);
      await cp(join(root,'compiled'),join(root,'dist'),{recursive:true});
    } else throw new Error('unexpected npm invocation');
  `);
  return {path, env: {...process.env, NODE_ENV: 'production', npm_execpath: join(path, 'npm-cli.js')}};
}

test('cold bootstrap installs then builds before typed setup, through real and symlink paths', async t => {
  const {path, env} = await sourceFixture(t);
  const alias = `${path}-alias`;
  t.after(() => rm(alias, {force: true}));
  await symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const directory of [path, alias]) {
    await rm(join(path, 'node_modules'), {recursive: true, force: true});
    await rm(join(path, 'dist'), {recursive: true, force: true});
    await rm(join(path, 'npm-calls.jsonl'), {force: true});
    const result = spawnSync(process.execPath, [join(directory, 'src/install/bootstrap.mjs')], {encoding: 'utf8', env});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'SETUP_STARTED');
    const calls = (await readFile(join(path, 'npm-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(call => call.args), [['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'build']]);
    assert.equal(calls[0].root, calls[1].root);
    assert.ok(!calls[0].root.endsWith('-alias'));
  }
  await rm(join(path, 'node_modules'), {recursive: true, force: true});
  await rm(join(path, 'dist'), {recursive: true, force: true});
  await rm(join(path, 'npm-calls.jsonl'), {force: true});
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(alias, 'src/install/bootstrap.mjs')).href)})`], {encoding: 'utf8', env});
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  await assert.rejects(access(join(path, 'npm-calls.jsonl')), {code: 'ENOENT'});
  await assert.rejects(access(join(path, 'dist')), {code: 'ENOENT'});
});

test('a failed cold build never enters setup', async t => {
  const {path, env} = await sourceFixture(t);
  const result = spawnSync(process.execPath, [join(path, 'src/install/bootstrap.mjs')], {encoding: 'utf8', env: {...env, RIN_TEST_BUILD_FAIL: '1'}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installer preparation failed \(9\)/);
  assert.doesNotMatch(result.stdout, /SETUP_STARTED/);
  await assert.rejects(access(join(path, 'dist')), {code: 'ENOENT'});
});
