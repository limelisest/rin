import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexBridge } from '../dist/chat/codex.js';

async function fixture(t, { fail = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'call.json');
  const peer = join(dir, 'peer.mjs');
  await writeFile(peer, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3),home:process.env.CODEX_HOME}));
${fail ? "console.error('queue rejected');process.exit(7);" : "console.log(JSON.stringify({messageId:'22222222-2222-4222-8222-222222222222'}));"}
`);
  return { dir, log, command: [process.execPath, peer, log] };
}

test('queues text and attachments to an existing thread without permission overrides', async t => {
  const f = await fixture(t);
  const bridge = new CodexBridge({ command: f.command, codexHome: join(f.dir, 'home') });
  await bridge.start();
  const result = await bridge.queue('thread-one', {
    text: 'literal $(text); 中文',
    files: [
      { path: '/tmp/notes.pdf', name: 'notes.pdf', mimeType: 'application/pdf' },
    ],
  });
  assert.deepEqual(result, {
    threadId: 'thread-one',
    messageId: '22222222-2222-4222-8222-222222222222',
  });
  const call = JSON.parse(await readFile(f.log, 'utf8'));
  assert.deepEqual(call.args, [
    'queue', '--thread', 'thread-one', '--message',
    'literal $(text); 中文\n\nLocal attachments:\n- notes.pdf (application/pdf): /tmp/notes.pdf',
  ]);
  assert.equal(call.home, join(f.dir, 'home'));
  assert.equal(call.args.some(value => /sandbox|approval|remote/.test(value)), false);
  await assert.rejects(bridge.queue('thread-one', {files:[{path:'/tmp/only.png',mimeType:'image/png'}]}), {code:'CODEX_INPUT_UNSUPPORTED'});
});

test('requires start, validates inputs, and propagates queue failure', async t => {
  const f = await fixture(t, { fail: true });
  const bridge = new CodexBridge({ command: f.command });
  await assert.rejects(bridge.queue('thread-one', { text: 'hello' }), /not started/);
  await bridge.start();
  await assert.rejects(bridge.queue('', { text: 'hello' }), /threadId required/);
  await assert.rejects(bridge.queue('thread-one', { text: '' }), /text or files required/);
  await assert.rejects(bridge.queue('thread-one', { text: 'hello', files: [{ path: '' }] }), /files must/);
  await assert.rejects(bridge.queue('thread-one', { text: 'hello' }), /queue rejected/);
});

async function creationFixture(t, mode = 'success', timeoutMs = 2_000) {
  const dir = await mkdtemp(join(tmpdir(), 'rin-thread-create-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const peer = join(dir, 'peer.mjs');
  await writeFile(peer, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2], mode = process.argv[3];
appendFileSync(log, JSON.stringify({ args: process.argv.slice(4), home: process.env.CODEX_HOME, pid: process.pid }) + '\\n');
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(log, JSON.stringify(message) + '\\n');
  if (message.method === 'initialized') return;
  const reply = result => process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  const error = () => process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'fixture rejected' } }) + '\\n');
  if (message.method === 'initialize') return mode === 'initialize-error' ? error() : reply({});
  if (message.method === 'thread/start') {
    if (mode === 'lost') return process.exit(7);
    if (mode === 'hang') return;
    if (mode === 'start-error') return error();
    if (mode === 'missing-id') return reply({ thread: {} });
    process.stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'new-thread' } } }) + '\\n');
    return reply({ thread: { id: 'new-thread' } });
  }
  if (message.method === 'thread/inject_items') {
    if (mode === 'inject-lost') return process.exit(7);
    return mode === 'inject-error' ? error() : reply({});
  }
  if (message.method === 'thread/name/set') return mode === 'name-error' ? error() : reply({});
  throw new Error('Unexpected method: ' + message.method);
});
input.on('close', () => process.exit(0));
`);
  const bridge = new CodexBridge({ command: [process.execPath, peer, log, mode], codexHome: dir, queueTimeoutMs: timeoutMs });
  await bridge.start();
  t.after(() => bridge.stop());
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { bridge, dir, calls };
}

test('creates and names a persistent thread without starting a turn and closes its child', async t => {
  const f = await creationFixture(t);
  assert.equal(await f.bridge.createThread({ cwd: f.dir, model: 'selected-model', name: '频道 $(literal)' }), 'new-thread');
  const [processCall, ...calls] = await f.calls();
  assert.deepEqual(processCall.args, ['app-server', '--stdio']);
  assert.equal(processCall.home, f.dir);
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'initialized', 'thread/start', 'thread/inject_items', 'thread/name/set']);
  assert.equal(calls[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(calls[2].params, { cwd: f.dir, model: 'selected-model', ephemeral: false });
  assert.deepEqual(calls[3].params, { threadId: 'new-thread', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text:
    'This task receives messages through the Rin chat bridge. Ordinary assistant replies are automatically delivered to the bound chat; do not send a second copy with external messaging tools.',
  }] }] });
  assert.deepEqual(calls[4].params, { threadId: 'new-thread', name: '频道 $(literal)' });
  assert.equal(f.bridge.children.size, 0);
  assert.throws(() => process.kill(processCall.pid, 0), { code: 'ESRCH' });
});

test('creation omits optional configuration and validates before launching', async t => {
  const f = await creationFixture(t);
  await assert.rejects(f.bridge.createThread({}), /cwd required/);
  await assert.rejects(f.bridge.createThread({ cwd: f.dir, model: '' }), /model required/);
  await assert.rejects(f.bridge.createThread({ cwd: f.dir, name: null }), /name required/);
  assert.equal(await f.bridge.createThread({ cwd: '.' }), 'new-thread');
  const [, ...calls] = await f.calls();
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'initialized', 'thread/start', 'thread/inject_items']);
  assert.deepEqual(calls[2].params, { cwd: process.cwd(), ephemeral: false });
  await f.bridge.stop();
  await assert.rejects(f.bridge.createThread({ cwd: f.dir }), /not started/);
});

for (const mode of ['initialize-error', 'start-error', 'lost', 'missing-id', 'hang', 'inject-error', 'inject-lost', 'name-error']) {
  test(`thread creation ${mode} preserves uncertainty and closes without replay`, async t => {
    const f = await creationFixture(t, mode, mode === 'hang' ? 250 : 2_000);
    await assert.rejects(f.bridge.createThread({ cwd: f.dir, name: 'optional title' }), error => {
      assert.equal(error.code, mode === 'initialize-error' ? 'CODEX_THREAD_CREATE_FAILED' : 'CODEX_THREAD_CREATE_UNCERTAIN');
      assert.equal(error.threadId, mode === 'name-error' ? 'new-thread' : undefined);
      return true;
    });
    const [processCall, ...calls] = await f.calls();
    assert.equal(calls.filter(call => call.method === 'thread/start').length, mode === 'initialize-error' ? 0 : 1);
    assert.equal(calls.some(call => call.method === 'turn/start'), false);
    assert.equal(f.bridge.children.size, 0);
    assert.throws(() => process.kill(processCall.pid, 0), { code: 'ESRCH' });
  });
}

test('stopping the bridge cancels an in-flight creation without replay', async t => {
  const f = await creationFixture(t, 'hang');
  const creation = f.bridge.createThread({ cwd: f.dir });
  const rejected = assert.rejects(creation, { code: 'CODEX_THREAD_CREATE_UNCERTAIN' });
  const deadline = Date.now() + 1_000;
  while (!(await f.calls().catch(() => [])).some(call => call.method === 'thread/start')) {
    assert.ok(Date.now() < deadline, 'fixture should receive thread/start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.bridge.stop();
  await rejected;
  assert.equal(f.bridge.children.size, 0);
});

function historyFixture(dir) {
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cli_version TEXT NOT NULL, history_mode TEXT NOT NULL)`);
  state.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread-one', '0.153.4', 'paginated');
  state.close();
  const history = new DatabaseSync(join(dir, 'thread_history_1.sqlite'));
  history.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER,
      PRIMARY KEY(thread_id, turn_id));
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL,
      item_type TEXT NOT NULL, updated_at_ordinal INTEGER NOT NULL,
      PRIMARY KEY(thread_id, turn_id, item_id));
  `);
  return history;
}

const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('event wait timed out');
};

test('read-only observer baselines history and emits only new public output and completion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  const db = historyFixture(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'old', 1, 'completed', null, 1, 2);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'old', 'old-message', 2, 1, JSON.stringify({ type: 'agentMessage', id: 'old-message', text: 'old answer', phase: 'final_answer' }), 'agentMessage', 2,
  );
  const events = [];
  const bridge = new CodexBridge({ command: ['codex'], codexHome: dir, pollMs: 10, onEvent: event => events.push(event) });
  await bridge.start();
  const unwatch = bridge.watch('thread-one');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(events, []);

  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'new', 3, 'inProgress', null, 3, null);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'new', 'tool', 4, 4, JSON.stringify({ type: 'commandExecution', aggregatedOutput: 'secret tool output' }), 'commandExecution', 4,
  );
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'new', 'reason', 5, 5, JSON.stringify({ type: 'reasoning', summary: ['Obsolete public summary', 'Public summary'], content: ['private reasoning'] }), 'reasoning', 5,
  );
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'new', 'answer', 6, 6, JSON.stringify({ type: 'agentMessage', text: 'Work', phase: 'commentary' }), 'agentMessage', 6,
  );
  await waitFor(() => events.length === 3);
  assert.deepEqual(events.map(event => [event.type, event.itemId, event.text]), [
    ['started', undefined, undefined],
    ['text', 'reason', 'Public summary'],
    ['text', 'answer', 'Work'],
  ]);
  assert.equal(events[1].phase, 'summary');
  assert.equal(JSON.stringify(events).includes('Obsolete public summary'), false);
  assert.equal(JSON.stringify(events).includes('private reasoning'), false);
  assert.equal(JSON.stringify(events).includes('secret tool output'), false);

  db.prepare('UPDATE thread_items SET item_json=?, updated_at_ordinal=? WHERE item_id=?').run(
    JSON.stringify({ type: 'agentMessage', text: 'Working', phase: 'commentary' }), 7, 'answer',
  );
  await waitFor(() => events.length === 4);
  assert.equal(events[3].text, 'Working');
  assert.equal(events[3].delta, undefined);
  db.prepare('UPDATE thread_turns SET status=?, completed_at=? WHERE turn_id=?').run('completed', 8, 'new');
  await waitFor(() => events.at(-1)?.type === 'completed');
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'bad', 9, 'failed', JSON.stringify({ message: 'model failed' }), 9, 10,
  );
  await waitFor(() => events.at(-1)?.type === 'failed');
  assert.deepEqual(events.slice(-2).map(event => [event.type, event.turnId, event.text]), [
    ['started', 'bad', undefined],
    ['failed', 'bad', 'model failed'],
  ]);
  unwatch();
  await bridge.stop();
});

test('observer projects the persisted steer input client id and immutable rollout ordinal before later output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-steer-boundary-'));
  const db = historyFixture(dir);t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'physical', 1, 'inProgress', null, 1, null);
  const events=[];const bridge=new CodexBridge({command:['codex'],codexHome:dir,pollMs:10,onEvent:event=>events.push(event)});
  await bridge.start();bridge.watch('thread-one');await new Promise(resolve=>setTimeout(resolve,30));
  // The old output is discovered after the receipt boundary in wall-clock time,
  // but its creation ordinal proves it belongs before the steered input.
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('thread-one','physical','old',10,10,JSON.stringify({type:'agentMessage',text:'old',phase:'final_answer'}),'agentMessage',30);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('thread-one','physical','input-b',20,20,JSON.stringify({type:'userMessage',id:'input-b',clientId:'steer-receipt'}),'userMessage',31);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('thread-one','physical','new',21,21,JSON.stringify({type:'agentMessage',text:'new',phase:'final_answer'}),'agentMessage',32);
  await waitFor(()=>events.filter(event=>event.type!=='started').length===3);
  assert.deepEqual(events.filter(event=>event.type!=='started').map(event=>[event.type,event.itemId,event.ordinal,event.clientMessageId,event.text]),[
    ['text','old',10,undefined,'old'],['input','input-b',20,'steer-receipt',undefined],['text','new',21,undefined,'new'],
  ]);
  await bridge.stop();
});

test('observer rejects unsupported history schema and stop disables watch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = historyFixture(dir);
  db.close();
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.prepare('UPDATE threads SET cli_version=?').run('0.154.0');
  state.close();
  const bridge = new CodexBridge({ codexHome: dir });
  await bridge.start();
  assert.throws(() => bridge.watch('thread-one'), /Unsupported Codex history schema/);
  await bridge.stop();
  assert.throws(() => bridge.watch('thread-one'), /not started/);
});

test('observer reports live schema drift as a typed event without crashing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = historyFixture(dir);
  db.close();
  const events = [];
  const bridge = new CodexBridge({ codexHome: dir, pollMs: 10, onEvent: event => events.push(event) });
  await bridge.start();
  bridge.watch('thread-one');
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.prepare('UPDATE threads SET cli_version=?').run('0.154.0');
  state.close();
  await waitFor(() => events.some(event => event.type === 'observerError'));
  assert.match(events.at(-1).text, /Unsupported Codex history schema/);
  await bridge.stop();
});

test('persistent cursor catches a missed final after observer restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  const db = historyFixture(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'active', 1, 'inProgress', null, 1, null);
  let cursor;
  const cursorApi = {
    getCursor: () => cursor,
    setCursor: (_key, value) => { cursor = structuredClone(value); },
  };
  const first = new CodexBridge({ codexHome: dir, pollMs: 10, ...cursorApi });
  await first.start();
  first.watch('thread-one');
  await first.stop();
  assert.deepEqual(cursor.activeTurns.map(row => row.turnId), ['active']);

  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'active', 'final', 2, 2, JSON.stringify({ type: 'agentMessage', text: 'Finished' }), 'agentMessage', 2,
  );
  db.prepare('UPDATE thread_turns SET status=?, completed_at=? WHERE turn_id=?').run('completed', 3, 'active');
  const events = [];
  const second = new CodexBridge({ codexHome: dir, pollMs: 10, onEvent: event => events.push(event), ...cursorApi });
  await second.start();
  second.watch('thread-one');
  await waitFor(() => events.at(-1)?.type === 'completed');
  assert.deepEqual(events.map(event => [event.type, event.phase, event.text]), [
    ['text', 'final', 'Finished'],
    ['completed', undefined, undefined],
  ]);
  await second.stop();
});

test('App text and images share IPC; backend selects start for idle threads', async t => {
  const f = await fixture(t); const bridge = new CodexBridge({command:f.command});
  await bridge.start(); t.after(()=>bridge.stop());
  const calls=[];bridge.appIpc={steer:async(thread,input)=>{calls.push({thread,input});return {threadId:thread,messageId:'mid',turnId:'turn',transport:'app-ipc-steer'};},stop:async()=>{}};
  bridge.threadContext=()=>({cwd:f.dir,active:true});
  const receipt=await bridge.queue('thread',{text:'change direction'});
  assert.equal(receipt.transport,'app-ipc-steer');assert.equal(calls.length,1);
  await assert.rejects(readFile(f.log),{code:'ENOENT'});
  await bridge.queue('thread',{text:'image',files:[{path:'/tmp/photo.png',mimeType:'image/png'}]});assert.equal(calls.length,2);assert.equal(calls[1].input.files[0].path,'/tmp/photo.png');
  bridge.threadContext=()=>({cwd:f.dir,active:false});await bridge.queue('thread',{text:'next task'});assert.equal(calls.length,3);assert.equal(calls[2].input.start,true);await assert.rejects(readFile(f.log),{code:'ENOENT'});
});

test('unknown steer outcome never falls back to queue; absent owner may queue', async t => {
  const f=await fixture(t); const bridge=new CodexBridge({command:f.command});await bridge.start();t.after(()=>bridge.stop());
  bridge.threadContext=()=>({cwd:f.dir,active:true});bridge.appIpc={steer:async()=>{throw Error('outcome uncertain');},stop:async()=>{}};
  await assert.rejects(bridge.queue('thread',{text:'one'}),/uncertain/);await assert.rejects(readFile(f.log),{code:'ENOENT'});
  bridge.appIpc.steer=async()=>null;await bridge.queue('thread',{text:'two'});assert.ok(JSON.parse(await readFile(f.log,'utf8')).args.includes('two'));
});

test('steering reads latest turn and original cwd without mutating Codex state', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-steer-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=new DatabaseSync(join(dir,'state_5.sqlite'));state.exec("CREATE TABLE threads(id TEXT,cwd TEXT,cli_version TEXT,history_mode TEXT); INSERT INTO threads VALUES('thread','/original/project','0.153.4','paginated')");state.close();
  const history=new DatabaseSync(join(dir,'thread_history_1.sqlite'));history.exec("CREATE TABLE thread_turns(thread_id TEXT,status TEXT,rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES('thread','inProgress',1)");
  const bridge=new CodexBridge({codexHome:dir});assert.deepEqual(bridge.activeThread('thread'),{cwd:'/original/project'});
  history.exec("INSERT INTO thread_turns VALUES('thread','completed',2)");assert.equal(bridge.activeThread('thread'),null);history.close();
  assert.equal(bridge.activeThread('missing'),null);
});

test('async final_answer questions do not terminate the visible output stream', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-question-history-'));
  const db=historyFixture(dir);
  const events=[];
  const bridge=new CodexBridge({codexHome:dir,pollMs:10,onEvent:event=>events.push(event)});
  t.after(async()=>{await bridge.stop();db.close();await rm(dir,{recursive:true,force:true});});
  await bridge.start();bridge.watch('thread-one');
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one','turn',1,'inProgress',null,1,null);
  const items=[
    {text:'before',phase:'commentary'},
    {text:'Which permission?',phase:'final_answer',delivery:'async',questions:[{title:'Which permission?',options:null}]},
    {text:'after',phase:'commentary'},
    {text:'Another question',phase:'final_answer',questions:[{title:'Another question'}]},
    {text:'finished',phase:'final_answer',delivery:null,questions:null},
  ];
  for(const [index,item] of items.entries())db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one','turn',`item-${index}`,index+2,index+2,JSON.stringify({type:'agentMessage',...item}),'agentMessage',index+2,
  );
  await waitFor(()=>events.length===6);
  assert.deepEqual(events.filter(event=>event.type==='text').map(({phase,text})=>({phase,text})),[
    {phase:'commentary',text:'before'},
    {phase:'question',text:'Which permission?'},
    {phase:'commentary',text:'after'},
    {phase:'question',text:'Another question'},
    {phase:'final',text:'finished'},
  ]);
});

async function wakeFixture(t, options = {}) {
  const f = await fixture(t);
  const wakes = [];
  const bridge = new CodexBridge({ command: f.command, appSteering: true, appWake: true,
    wakeApp: async id => { wakes.push(id); }, queueTimeoutMs: 1000, ...options });
  await bridge.start();
  t.after(() => bridge.stop());
  bridge.threadContext = () => ({ cwd: f.dir, active: false });
  bridge.appIpc = { steer: async () => null, stop: async () => {} };
  return { ...f, bridge, wakes };
}

test('unloaded App task wakes once, rereads busy state, and delivers without native queue', async t => {
  const f = await wakeFixture(t);
  const calls = [];
  let active = false;
  f.bridge.threadContext = () => ({ cwd: f.dir, active });
  f.bridge.appIpc.steer = async (_id, input) => {
    calls.push(input);
    if (calls.length === 1) { active = true; return null; }
    if (calls.length === 2) return null;
    return { threadId: 'thread', turnId: 'active-turn', transport: 'app-ipc-steer' };
  };
  const input = { text: 'image and text', files: [{ path: '/tmp/image.png', mimeType: 'image/png' }] };
  const receipt = await f.bridge.queue('thread', input);
  assert.deepEqual(f.wakes, ['thread']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.start), [true, false, false]);
  assert.deepEqual(calls.map(call => call.files), [input.files, input.files, input.files]);
  assert.equal(receipt.turnId, 'active-turn');
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('an existing App owner does not wake or queue again', async t => {
  const f = await wakeFixture(t);
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; return { turnId: 'turn' }; };
  assert.deepEqual(await f.bridge.queue('thread', { text: 'hello' }), { turnId: 'turn' });
  assert.equal(calls, 1);
  assert.deepEqual(f.wakes, []);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('ambiguous App mutation after wake is never replayed or queued', async t => {
  const f = await wakeFixture(t);
  let calls = 0;
  f.bridge.appIpc.steer = async () => {
    if (++calls === 1) return null;
    throw new Error('mutation outcome uncertain');
  };
  await assert.rejects(f.bridge.queue('thread', { text: 'send once' }), /outcome uncertain/);
  assert.equal(calls, 2);
  assert.deepEqual(f.wakes, ['thread']);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('ambiguous initial App submission does not launch wake retry', async t => {
  const f = await wakeFixture(t);
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; throw new Error('receipt lost'); };
  await assert.rejects(f.bridge.queue('thread', { text: 'send once' }), /receipt lost/);
  assert.equal(calls, 1);
  assert.deepEqual(f.wakes, []);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('App load timeout never leaves a silently stranded native queue message', async t => {
  const f = await wakeFixture(t, { queueTimeoutMs: 10 });
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; return null; };
  await assert.rejects(f.bridge.queue('thread', { text: 'cannot load' }), /wake timed out; message was not queued/);
  assert.ok(calls >= 2);
  assert.deepEqual(f.wakes, ['thread']);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('App wake failure propagates without retrying business input', async t => {
  const f = await wakeFixture(t, { wakeApp: async () => { throw new Error('URL handler unavailable'); } });
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; return null; };
  await assert.rejects(f.bridge.queue('thread', { text: 'cannot open' }), /URL handler unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('observer emits completed image artifacts without exposing image payload or tool output, and resumes once', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-image-history-'));
  const db=historyFixture(dir);t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  const events=[];let cursor;
  const options={codexHome:dir,pollMs:10,onEvent:e=>events.push(e),getCursor:()=>cursor,setCursor:(_k,v)=>{cursor=v;}};
  let bridge=new CodexBridge(options);await bridge.start();bridge.watch('thread-one');
  db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)').run('thread-one','image-turn',1,'inProgress',null,1,null);
  const insert=db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)');
  insert.run('thread-one','image-turn','image',2,2,JSON.stringify({status:'inProgress',savedPath:'/tmp/not-ready.png',result:'private pixels'}),'imageGeneration',2);
  insert.run('thread-one','image-turn','tool',3,3,JSON.stringify({output:'private tool image'}),'mcpToolCall',3);
  await waitFor(()=>events.some(e=>e.type==='started'));
  const path=join(dir,'generated_images','thread-one','image.png');
  db.prepare('UPDATE thread_items SET item_json=?,updated_at_ordinal=4 WHERE item_id=?').run(JSON.stringify({status:'completed',savedPath:path,result:'private pixels',revisedPrompt:'private prompt'}),'image');
  await waitFor(()=>events.some(e=>e.type==='image'));
  assert.deepEqual(events.filter(e=>e.type==='image'),[{threadId:'thread-one',turnId:'image-turn',type:'image',itemId:'image',path,ordinal:2}]);
  assert.equal(JSON.stringify(events).includes('private'),false);
  await bridge.stop();bridge=new CodexBridge(options);await bridge.start();bridge.watch('thread-one');
  await new Promise(r=>setTimeout(r,35));await bridge.stop();
  assert.equal(events.filter(e=>e.type==='image').length,1);
});
