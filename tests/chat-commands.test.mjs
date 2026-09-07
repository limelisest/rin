import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../src/chat/bridge.mjs';
import {COMMANDS,parseCommand} from '../src/chat/commands.mjs';
import {stableId} from '../src/chat/store.mjs';
import {createAdapter as discordAdapter} from '../src/chat/adapters/discord.mjs';

test('the built-in catalog is minimal and accepts a shared extension grammar',()=>{
  assert.deepEqual(COMMANDS.map(c=>c.name),['help','usage']);
  assert.deepEqual(parseCommand('/usage@rin_bot history --days 7'),{name:'usage',args:'history --days 7'});
  assert.deepEqual(parseCommand('/echo_2 yes',[{name:'echo_2'}]),{name:'echo_2',args:'yes'});
});

test('every admitted caller can execute usage, extension privacy stays explicit, and replay is durable',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-commands-'));let bridge,receive,usageCalls=0;const sent=[];
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','echo.mjs'),`export default {name:'echo',description:'Echo text',privateOnly:true,run:async({args})=>({text:args,target:{chatId:'wrong'}})};`);
  const originalBinding={adapter:'d',chatId:'other',kind:'dm',threadId:'existing',mirror:true};
  const config={dataDir,bindings:[originalBinding],adapters:[{id:'d',type:'discord',dmOnly:false,allowUsers:['a','b']}]};
  const adapter={capabilities:{edit:true,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},send:async(t,o)=>{sent.push({t,o});return{id:String(sent.length)};}};
  let catalog;
  const start=async()=>{
    bridge=new ChatBridge(config,{log:{info(){},warn(){},error(){}},codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async(_c,context)=>{catalog=context.commands;return adapter;},usage:async()=>{usageCalls++;return{text:'PRIVATE LIMITS'};}});await bridge.start();
  };
  const msg=(id,text,extra={})=>({id,text,chatId:'chat',kind:'dm',userId:'a',mentioned:true,...extra});
  try {
    await start();assert.deepEqual(catalog.map(c=>c.name),['help','usage','echo']);assert.deepEqual(config.bindings,[originalBinding]);
    await receive(msg('g','/usage',{kind:'group'}));await bridge.flush();assert.equal(usageCalls,1);assert.match(sent.at(-1).o.text,/PRIVATE LIMITS/);
    await receive(msg('b','/usage',{userId:'b'}));await bridge.flush();assert.equal(usageCalls,2);
    await receive(msg('ignored','/usage',{userId:'stranger'}));assert.equal(usageCalls,2);
    await Promise.all([receive(msg('u','/usage',{commandInteraction:{id:'interaction'}})),receive(msg('u','/usage'))]);await bridge.flush();
    assert.equal(usageCalls,3);assert.equal(sent.at(-1).t.commandInteraction.id,'interaction');
    await receive(msg('eg','/echo hidden',{kind:'group',userId:'b'}));await bridge.flush();assert.match(sent.at(-1).o.text,/私聊/);
    await receive(msg('e','/echo literal',{userId:'b'}));await bridge.flush();assert.equal(sent.at(-1).o.text,'literal');assert.equal(sent.at(-1).t.chatId,'chat');
    await bridge.stop();await start();const count=sent.length;await receive(msg('e','/echo literal',{userId:'b'}));await receive(msg('u','/usage'));await bridge.flush();
    assert.equal(usageCalls,3);assert.equal(sent.length,count);assert.deepEqual(config.bindings,[originalBinding]);
    await receive(msg('help','/help',{kind:'group'}));await bridge.flush();assert.match(sent.at(-1).o.text,/\/usage/);assert.doesNotMatch(sent.at(-1).o.text,/\/echo|PRIVATE|existing/);
  } finally {await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('extensions must explicitly opt into empty silent results and visible results still send',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-silent-command-'));let bridge,receive;const sent=[],dismissed=[],warnings=[];
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','quiet.mjs'),`export default {
    name:'quiet',description:'Optionally stay quiet',async run({args}) {
      if(args==='null')return null;
      if(args==='undefined')return;
      if(args==='empty')return {};
      if(args==='false')return {silent:false};
      if(args==='typed')return {silent:'yes'};
      if(args==='fallback')return {silent:true,fallbackText:'fallback'};
      if(args==='visible')return {silent:true,text:'visible'};
      if(args==='file')return {silent:true,files:[{path:'/tmp/result.txt',name:'result.txt'}]};
      return {silent:true};
    }
  };`);
  const config={dataDir,bindings:[],adapters:[{id:'d',type:'discord',allowUsers:['owner']}]};
  const adapter={capabilities:{edit:true,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},
    send:async(t,o)=>{sent.push({t,o});return{id:String(sent.length)};},dismiss:async target=>{dismissed.push(target);if(target.commandInteraction.id==='fail')throw new Error('cleanup failed');}};
  const msg=(id,args='',extra={})=>({id,text:`/quiet${args?` ${args}`:''}`,chatId:'chat',kind:'dm',userId:'owner',mentioned:true,...extra});
  try {
    bridge=new ChatBridge(config,{log:{info(){},error(){},warn:(text,details)=>warnings.push({text,details})},
      codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter});
    await bridge.start();
    await receive(msg('silent'));await bridge.flush();
    assert.equal(sent.length,0);assert.equal(dismissed.length,0);
    assert.deepEqual(bridge.store.cursor(`command:${stableId('d','chat','silent')}`),{state:'done'});
    await receive(msg('silent'));await bridge.flush();assert.equal(sent.length,0);
    await receive(msg('silent-interaction','',{commandInteraction:{id:'ix'}}));
    assert.equal(sent.length,0);assert.equal(dismissed.length,1);assert.equal(dismissed[0].commandInteraction.id,'ix');
    await receive(msg('silent-cleanup-failure','',{commandInteraction:{id:'fail'}}));
    assert.equal(sent.length,0);assert.equal(dismissed.length,2);
    assert.deepEqual(bridge.store.cursor(`command:${stableId('d','chat','silent-cleanup-failure')}`),{state:'done'});
    await receive(msg('silent-cleanup-failure','',{commandInteraction:{id:'fail'}}));assert.equal(dismissed.length,2);
    await receive(msg('visible','visible'));await bridge.flush();assert.equal(sent.at(-1).o.text,'visible');
    await receive(msg('file','file'));await bridge.flush();assert.equal(sent.at(-1).o.files[0].name,'result.txt');
    for(const value of ['null','undefined','empty','false','typed','fallback'])await receive(msg(`bad-${value}`,value));
    await bridge.flush();
    assert.equal(sent.length,8);
    for(const entry of sent.slice(2))assert.match(entry.o.text,/命令未完成/);
    assert.equal(warnings.filter(entry=>entry.text==='command failed').length,6);
    assert.equal(warnings.filter(entry=>entry.text==='silent command interaction cleanup failed').length,1);
  } finally {await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('Discord completes explicit silence through its deferred interaction lifecycle',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-silent-discord-'));let bridge,resolveDeleted,resolveFailed;
  const deleted=new Promise(resolve=>{resolveDeleted=resolve;});const failed=new Promise(resolve=>{resolveFailed=resolve;});
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','quiet.mjs'),
    `export default {name:'quiet',description:'Stay quiet',async run(){return {silent:true};}};`);
  const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{};client.isReady=()=>true;client.destroy=async()=>{};
  client.application={commands:{set:async()=>{}}};client.channels={fetch:async()=>assert.fail('silent commands must not send publicly')};
  const warnings=[];const config={dataDir,bindings:[],adapters:[{id:'d',type:'discord',token:'x',allowUsers:['owner'],__client:client,__dismissRetryDelays:[0,0,0]}]};
  try {
    bridge=new ChatBridge(config,{log:{info(){},error(){},warn:(text,details)=>{warnings.push({text,details});if(text==='silent command interaction cleanup failed')resolveFailed();}},
      codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async(value,context)=>discordAdapter(value,context)});
    await bridge.start();
    let defers=0,edits=0,deletes=0;
    client.emit('interactionCreate',{id:'silent-ok',channelId:'dm',user:{id:'owner'},commandName:'quiet',isChatInputCommand:()=>true,options:{getString:()=>null},
      deferReply:async()=>{defers++;},editReply:async()=>{edits++;},deleteReply:async()=>{deletes++;resolveDeleted();}});
    await deleted;await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual({defers,edits,deletes},{defers:1,edits:0,deletes:1});
    assert.deepEqual(bridge.store.cursor(`command:${stableId('d','dm','silent-ok')}`),{state:'done'});
    let failedDeletes=0;
    client.emit('interactionCreate',{id:'silent-fail',channelId:'dm',user:{id:'owner'},commandName:'quiet',isChatInputCommand:()=>true,options:{getString:()=>null},
      deferReply:async()=>{defers++;},editReply:async()=>{edits++;},deleteReply:async()=>{failedDeletes++;throw new Error('network');}});
    await failed;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(failedDeletes,3);assert.equal(edits,0);
    assert.deepEqual(bridge.store.cursor(`command:${stableId('d','dm','silent-fail')}`),{state:'done'});
    assert.equal(warnings.filter(entry=>entry.text==='silent command interaction cleanup failed').length,1);
  } finally {await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('slow menu registration does not block readiness and its later failure is handled',async()=>{
  const {registerCommands}=await import('../src/chat/commands.mjs');let reject;const warnings=[];
  await registerCommands(()=>new Promise((_,fail)=>{reject=fail;}),{warn:m=>warnings.push(m)},'menu registration failed',5);
  assert.equal(warnings.length,0);reject(new Error('secret request metadata'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(warnings,['menu registration failed']);
});
