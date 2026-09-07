import type {AttentionConfig} from './attention-types.js';
export interface NerveTarget {type:string; argv?:string[]; url?:string; threadId?:string; stateFile?:string; idempotent?:boolean; command?:string[]; timeoutMs?:number; maxBytes?:number; maxAttempts?:number; tokenEnv?:string; cwd?:string; codexHome?:string}
export interface NerveTrigger {id:string; target:string; everySeconds?:number; at?:string; daily?:string; timeZone?:string; check?:string[]; enabled?:boolean; timeoutMs?:number; payload?:unknown; managed?:boolean; revision?:number}
export interface MinecraftSource {serverId:string; playerUuid:string; maidUuid:string}
export interface NerveConfig {targets:Record<string,NerveTarget>; triggers?:NerveTrigger[]; attention?:AttentionConfig; minecraft?:{endpoint:string; stateFile:string; tokenEnv:string; target:string; source:MinecraftSource}; database:string; cwd?:string; port?:number}
export interface NerveEvent {id:string; target:string; payload:string; state:string; attempts:number; available:number; created:number; updated:number; error:string|null; result:string|null; source:string|null}
export interface TriggerRow {id:string; definition:string; revision:number}
