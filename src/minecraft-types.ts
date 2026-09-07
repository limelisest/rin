import type {MinecraftSource} from './nerve-types.js';
export interface MinecraftMessage extends MinecraftSource {version:number; id:string; conversationId:string; text:string; occurredAt:string}
export interface MinecraftTask {jobId:string; action:string; args:Record<string,string>}
export interface MinecraftSend {id:string; messageId:string; kind:string; text?:string; task?:MinecraftTask}
export interface MinecraftReceipt {id:string; state:string; replyTo:string; playerUuid?:string; maidUuid?:string}
export interface MinecraftState {version:number; afterCursor?:string; pages:{throughCursor:string;ids:string[]}[]; inbox:Record<string,{message:MinecraftMessage; fingerprint:string; forwarded:boolean}>; outbox:Record<string,{fingerprint:string; message:unknown; attempted:boolean; result?:MinecraftReceipt}>}
export interface MinecraftResponse {error?:string;version?:number;messages?:MinecraftMessage[];nextCursor?:string;jobs?:({playerUuid?:string;maidUuid?:string}&Record<string,unknown>)[];player?:{uuid?:string}|null;maid?:{uuid?:string}|null;nearbyContainers?:unknown[];nearbyBlocks?:unknown[];id?:string;replyTo?:string;playerUuid?:string;maidUuid?:string;state?:string}
export interface MinecraftOptions {endpoint:string;secret:string;stateFile:string;source:MinecraftSource;enqueue:(message:MinecraftMessage)=>Promise<unknown>;fetchImpl?:typeof fetch;timeoutMs?:number}
