import {errorCode} from './types.js';
import type {Executable,JsonValue} from './types.js';
import { spawn } from 'node:child_process';
import {readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {codexCommand} from './core.js';

export const RIN_RECOMMENDED_CODEX_EDITS = Object.freeze(([
  ['features.context_management.experimental_mode', true],
  ['features.memories', true],
  ['tool_output_token_limit', 4000],
  ['model', 'gpt-6-astra'],
  ['model_reasoning_effort', 'medium'],
  ['sandbox_mode', 'danger-full-access'],
  ['approval_policy', 'never'],
  ['desktop.preventSleepWhileRunning', true],
  ['desktop.keepRemoteControlAwakeWhilePluggedIn', true],
  ['desktop.git-branch-prefix', ''],
  ['desktop.git-pull-request-merge-method', 'squash'],
  ['desktop.worktree-upstream-refresh-mode', 'best-effort'],
  ['apps.connector_20205bf7d4e99a89d7154bb849718324.enabled', false],
  ['apps.connector_openai_hotline.enabled', false],
  ['apps.connector_openai_safety_settings.enabled', false],
] satisfies [string,JsonValue][]).map(([keyPath,value])=>Object.freeze({keyPath,value,mergeStrategy:'upsert' as const})));

export const RIN_OBSOLETE_CODEX_EDITS = Object.freeze([
  Object.freeze({keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}),
]);

function hasObsoleteRootSetting(source: string) {
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return false;
    if (/^\s*model_auto_compact_token_limit\s*=/.test(line)) return true;
  }
  return false;
}

export function createCodexConfigWriter({ command, codexHome, spawnImpl = spawn, timeoutMs = 15_000 }: {command?: Executable; codexHome?: string; spawnImpl?: typeof spawn; timeoutMs?: number}) {
  if(!command?.command)throw new TypeError('Codex command is required');
  return async <T = ConfigWriteResult>(params: unknown,method = 'config/batchWrite'): Promise<T> => new Promise<T>((resolve,reject)=>{
    const env=codexHome?{...process.env,CODEX_HOME:codexHome}:process.env;
    const child=spawnImpl(command.command,[...(command.args || []),'app-server','--stdio'],{env,stdio:['pipe','pipe','pipe']});
    let buffer='',settled=false,nextId=1;
    const pending=new Map<string,{accept:(value: unknown)=>void; decline:(error: Error)=>void}>();
    const finish=(error: unknown,value?: T)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value as T);};
    const request=(method: string,requestParams: unknown)=>new Promise<unknown>((accept,decline)=>{
      const id=nextId++;pending.set(String(id),{accept,decline});
      child.stdin.write(`${JSON.stringify({id,method,params:requestParams})}\n`);
    });
    const timer=setTimeout(()=>finish(new Error('Codex configuration write timed out')),timeoutMs);
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>finish(new Error('Codex configuration writer input failed')));
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop() || '';
      for(const line of lines){
        let message: {id?: number|string; error?: {message?: string}; result?: unknown};try{message=JSON.parse(line);}catch{continue;}
        const entry=pending.get(String(message.id));if(!entry)continue;
        pending.delete(String(message.id));
        if(message.error)entry.decline(new Error(message.error.message || 'Codex configuration write failed'));
        else entry.accept(message.result);
      }
    });
    child.once('error',finish);
    child.once('exit',code=>{if(!settled)finish(new Error(`Codex configuration writer exited (${code})`));});
    (async()=>{
      try{
        await request('initialize',{clientInfo:{name:'rin-installer',title:'Rin installer',version:'1'},capabilities:{experimentalApi:true,requestAttestation:false}});
        finish(null,await request(method,params) as T);
      }catch(error){finish(error);}
    })();
  });
}

export async function applyRecommendedCodexProfile({ codexHome, command, writeConfig }: ConfigOptions = {}) {
  if(!codexHome)throw new TypeError('codexHome is required');
  const writer=writeConfig || createCodexConfigWriter({command,codexHome});
  return writer({
    edits:RIN_RECOMMENDED_CODEX_EDITS.map(edit=>({...edit})),
    reloadUserConfig:true,
  });
}

export async function migrateContextManagementConfig({ codexHome, command, writeConfig, readConfig, binary, resolveCommand = codexCommand }: ConfigOptions = {}) {
  if(!codexHome)throw new TypeError('codexHome is required');
  let filePath=resolve(codexHome,'config.toml');
  let source;
  try { source=await readFile(filePath,'utf8'); }
  catch(error) { if(errorCode(error)==='ENOENT')return{status:'unchanged'};throw error; }
  // This is only a fast path; Codex parses TOML and identifies the user layer below.
  if(!source.includes('context_management'))return{status:'unchanged'};
  filePath=await realpath(filePath);
  const resolved=command || (readConfig && writeConfig ? undefined : await resolveCommand({binary,env:{...process.env,CODEX_HOME:codexHome}}));
  const client=readConfig && writeConfig ? undefined : createCodexConfigWriter({command:resolved,codexHome});
  const reader=readConfig || ((params: {includeLayers: boolean})=>client!<ConfigSnapshot>(params,'config/read'));
  const writer=writeConfig || client;
  const snapshot=await reader({includeLayers:true});
  const layer=snapshot.layers?.find(layer=>layer.name?.type==='user' && !layer.name.profile && layer.name.file===filePath);
  if(!layer)throw new Error('Codex did not return the base user configuration layer');
  const value=layer.config?.features?.context_management;
  if(typeof value!=='boolean')return{status:'unchanged'};
  const result=await writer!({
    edits:[{keyPath:'features.context_management',value:{experimental_mode:value},mergeStrategy:'replace'}],
    filePath,
    expectedVersion:layer.version,
    reloadUserConfig:true,
  });
  return{status:'migrated',result};
}

export async function removeObsoleteCodexSettings({ codexHome, command, writeConfig, binary, resolveCommand = codexCommand }: ConfigOptions = {}) {
  if(!codexHome)throw new TypeError('codexHome is required');
  let source;
  try { source=await readFile(join(codexHome,'config.toml'),'utf8'); }
  catch(error) { if(errorCode(error)==='ENOENT')return{status:'unchanged'};throw error; }
  if(!hasObsoleteRootSetting(source))return{status:'unchanged'};
  const resolved=command || (writeConfig ? undefined : await resolveCommand({binary,env:{...process.env,CODEX_HOME:codexHome}}));
  const writer=writeConfig || createCodexConfigWriter({command:resolved,codexHome});
  const result=await writer!({
    edits:RIN_OBSOLETE_CODEX_EDITS.map(edit=>({...edit})),
    reloadUserConfig:true,
  });
  if(!writeConfig && hasObsoleteRootSetting(await readFile(join(codexHome,'config.toml'),'utf8'))) {
    throw new Error('Codex reported success but the obsolete root setting remains');
  }
  return result;
}

export interface ConfigEdit {keyPath: string; value: JsonValue; mergeStrategy: 'upsert' | 'replace'}
export interface ConfigWriteRequest {edits: readonly ConfigEdit[]; reloadUserConfig: boolean; filePath?: string; expectedVersion?: string}
export interface ConfigWriteResult {status?: string; ok?: boolean}
export type ConfigWriter=(params: ConfigWriteRequest)=>Promise<ConfigWriteResult>;
export interface ConfigSnapshot {layers?: {name?: {type?: string;profile?: string;file?: string}; version?: string; config?: {features?: {context_management?: boolean | Record<string,unknown>}}}[]}
export interface ConfigOptions {codexHome?: string;command?: Executable;writeConfig?: ConfigWriter;readConfig?: (params:{includeLayers: boolean})=>Promise<ConfigSnapshot>;binary?: string;resolveCommand?: typeof codexCommand}
