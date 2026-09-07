import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activateNerveMcp} from '../dist/install/nerve-service.js';

async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'rin-nerve-activation-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'private'));
  const pending=join(home,'private/nerve-setup-pending.json');
  await writeFile(pending,'{}');
  return{home,pending,nerve:{needsActivation:true,configPath:join(home,'private/nerve.json')}};
}

test('new Nerve service starts and clears pending work only after authenticated health',async t=>{
  const f=await fixture(t),events=[];
  await activateNerveMcp({...f,service:{isRunning:async()=>false,start:async()=>events.push('start')},healthy:async()=>true});
  assert.deepEqual(events,['start']);
  await assert.rejects(readFile(f.pending),{code:'ENOENT'});
});

test('running chat daemon restarts only when the added Nerve endpoint is absent',async t=>{
  const f=await fixture(t),events=[];
  let healthy=false;
  const service={isRunning:async()=>true,stop:async()=>events.push('stop'),start:async()=>{events.push('start');healthy=true;}};
  await activateNerveMcp({...f,service,healthy:async()=>healthy});
  assert.deepEqual(events,['stop','start']);
  events.length=0;
  await activateNerveMcp({...f,service,healthy:async()=>true});
  assert.deepEqual(events,[]);
});

test('failed activation keeps marker for the next update',async t=>{
  const f=await fixture(t);
  await assert.rejects(activateNerveMcp({...f,service:{isRunning:async()=>false,start:async()=>{}},healthy:async()=>false}),/not healthy/);
  assert.equal(await readFile(f.pending,'utf8'),'{}');
});

test('already configured or explicitly disabled installations do not restart on repair',async t=>{
  const f=await fixture(t);
  await activateNerveMcp({...f,nerve:{needsActivation:false},service:{isRunning:async()=>{throw Error('must not inspect or change service');}}});
});
