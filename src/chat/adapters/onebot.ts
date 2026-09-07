import type WebSocket from 'ws';
import type { RawData, ClientOptions } from 'ws';
interface Segment { type: string; data: {text?: string; url?: string; file?: string; name?: string; qq?: string | number; id?: string | number}; }
interface ForwardRawNode { sender?: {user_id?: string | number; nickname?: string}; user_id?: string | number; nickname?: string; content?: string | Segment[]; message?: string | Segment[]; group_id?: string | number; children?: ForwardRawNode[]; }
interface OneBotResult { url?: string; message_id?: string | number; file_id?: string | number; messages?: ForwardRawNode[]; }
interface OneBotEvent {
 echo?: string; status?: string; retcode?: number; wording?: string; data?: OneBotResult;
 message?: string | Segment[]; post_type?: string; message_type?: string; user_id?: string | number;
 self_id?: string | number; message_id?: string | number; group_id?: string | number;
}
interface OneBotConfig extends AdapterConfig {
 wsUrl: string; httpUrl?: string; fetch?: typeof fetch; attachmentTimeoutMs?: number;
 WebSocket?: new (url: string, options: ClientOptions) => WebSocket;
 reconnectMs?: number; rpcTimeoutMs?: number;
}
import type { AdapterConfig, AdapterContext, ChatAdapter, ChatMessage, ChatTarget, ChatOutput, ChatCommand, FileAttachment } from '../types.js';
import { platformError } from './types.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { allowed } from '../policy.js';
import { privateLikeFromProof, shouldProbePrivateLike } from '../private-like.js';
import { COMMANDS, parseCommand, parseCommandText } from '../commands.js';
import { limitForward, mediaSummary, type ForwardNode, type InboundMedia } from '../input-normalization.js';

const capabilities = Object.freeze({ edit: false, delete: true, reaction: true, typing: false, maxText: 4000 });

function segments(message: OneBotEvent["message"]): Segment[] {
  return Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message || '') } }];
}

async function readLimited(response: Response, limit: number) {
  if (!response.body?.[Symbol.asyncIterator]) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('OneBot attachment exceeds 20 MB limit');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel?.(); throw new Error('OneBot attachment exceeds 20 MB limit'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function mediaKind(part: Segment): InboundMedia['kind'] | null {
  if (part.type === 'image') return 'image';
  if (part.type === 'video') return 'video';
  if (['record','audio'].includes(part.type)) return 'audio';
  if (part.type === 'voice') return 'voice';
  if (['sticker','face','mface'].includes(part.type)) return 'sticker';
  return part.type === 'file' ? 'file' : null;
}
function mediaMime(kind: InboundMedia['kind']) { return kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : ['audio','voice'].includes(kind) ? 'audio/*' : undefined; }

async function downloadFiles(event: OneBotEvent, config: OneBotConfig, context: AdapterContext, resolveFile: (file: string) => Promise<OneBotResult>): Promise<Array<{file?: FileAttachment; media: InboundMedia}>> {
  const media = segments(event.message).map((part,index) => ({part,index,kind:mediaKind(part)})).filter((entry): entry is {part: Segment; index: number; kind: InboundMedia['kind']} => entry.kind !== null);
  if (!media.length) return [];
  const adapterId = path.basename(String(config.id || 'onebot')).replaceAll(/[^\p{L}\p{N}._-]/gu, '_') || 'onebot';
  const dir = path.join(context.dataDir, 'attachments', adapterId, randomUUID());
  await mkdir(dir, { recursive: true });
  return Promise.all(media.map(async ({part, index, kind}) => {
    let url = part.data?.url;
    if (!url && part.data?.file) {
      const resolved = await resolveFile(part.data.file);
      url = resolved?.url;
    }
    const base = path.basename(part.data?.name || part.data?.file || `${part.type}-${index + 1}`).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
    if (!url) return {media:{kind,...(base?{name:base}:{}),...(mediaMime(kind)?{mimeType:mediaMime(kind)}:{}),unavailable:'no downloadable URL'}};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.attachmentTimeoutMs ?? 15000);
    timer.unref?.();
    // Attachment URLs may point at arbitrary QQ/CDN origins. The OneBot access
    // token authenticates only the gateway/API and must never follow media URLs.
    try {
      const response = await (config.fetch || fetch)(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > 20 * 1024 * 1024) throw new Error('exceeds 20 MB limit');
      const bytes = await readLimited(response, 20 * 1024 * 1024);
      const name = `${randomUUID()}-${base}`;
      const filePath = path.join(dir, name);
      await writeFile(filePath, bytes);
      return {file:{path:filePath,name,mimeType:mediaMime(kind)},media:{kind,name,mimeType:mediaMime(kind),path:filePath}};
    } catch(error) { return {media:{kind,...(base?{name:base}:{}),...(mediaMime(kind)?{mimeType:mediaMime(kind)}:{}),unavailable:String(error).slice(0,120)}}; }
    finally { clearTimeout(timer); }
  }));
}

function forwardNodes(raw: ForwardRawNode[]): ForwardNode[] {
  return (raw || []).map(node => ({...(node.sender?.user_id || node.user_id ? {authorId:String(node.sender?.user_id || node.user_id)} : {}),...(node.sender?.nickname || node.nickname ? {authorName:String(node.sender?.nickname || node.nickname)} : {}),text:segments(node.content || node.message).filter(part=>part.type==='text').map(part=>part.data.text || '').join(''),...(node.children?.length?{children:forwardNodes(node.children)}:{})}));
}

export function createAdapter(config: OneBotConfig, context: AdapterContext) {
  if (!config?.wsUrl) throw new Error('OneBot v11 adapter requires wsUrl');
  if (!Array.isArray(config.allowUsers) || config.allowUsers.length === 0) throw new Error('OneBot v11 adapter requires a non-empty allowUsers list');
  let socket: WebSocket | undefined;
  let stopped = true;
  let connectionGeneration = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let onMessage: (message: ChatMessage) => Promise<void>;
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;
  const pending = new Map<string, {timer: ReturnType<typeof setTimeout>; resolve: (result: OneBotResult) => void; reject: (error: Error) => void}>();

  function rejectPending(error: Error) {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  }

  async function handle(raw: RawData | string) {
    let event: OneBotEvent;
    try { event = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (event.echo != null && pending.has(String(event.echo))) {
      const call = pending.get(String(event.echo))!; pending.delete(String(event.echo)); clearTimeout(call.timer);
      if (event.status === 'failed' || (event.retcode != null && event.retcode !== 0)) call.reject(Object.assign(new Error(`OneBot RPC failed (${event.retcode}): ${event.message || event.wording || 'unknown error'}`),{fallbackSafe:true}));
      else call.resolve(event.data ?? {});
      return;
    }
    if (event.post_type !== 'message') return;
    const kind = event.message_type === 'group' ? 'group' : 'dm';
    const userId = String(event.user_id);
    const parts = segments(event.message);
    const text = parts.filter((part) => part.type === 'text').map((part) => part.data?.text || '').join('').trim();
    // Admission deliberately precedes URL downloads and get_file calls.
    const parsed = parseCommandText(text,commands);
    const selfId = String(event.self_id || '').toLowerCase();
    const commandTarget = parsed?.target ? (selfId && parsed.target === selfId ? 'self' : 'other') : undefined;
    const command = Boolean(parseCommand(text,commands,commandTarget));
    // Keep identity admission ahead of every membership and attachment request.
    if (!Array.isArray(config.allowUsers) || !config.allowUsers.includes(userId)) return;
    const mentioned = parts.some((part) => part.type === 'at' && String(part.data?.qq) === String(event.self_id));
    const reply = parts.find((part) => part.type === 'reply')?.data?.id;
    const envelope: ChatMessage = {
      id: String(event.message_id), chatId: String(kind === 'group' ? event.group_id : event.user_id), userId, kind,
      mentioned,
      text, files: [],
      ...(commandTarget ? { commandTarget } : {}),
      ...(reply == null ? {} : { replyTo: String(reply) }),
    };
    const privateLike = await provePrivateLike(envelope, String(event.self_id || ''));
    const admittedEnvelope = privateLike ? {...envelope, privateLike: true} : envelope;
    const policyEnvelope = parts.some((part) => mediaKind(part) !== null || part.type === 'forward') && !admittedEnvelope.text && !admittedEnvelope.replyTo
      ? {...admittedEnvelope, files: [{path: 'inbound-media'}]}
      : admittedEnvelope;
    if (!allowed(config, policyEnvelope, {command})) return;
    if (context.isBound && !await context.isBound(admittedEnvelope)) return;
    // All provider RPC and URL retrieval happens only after identity, policy and
    // binding admission. Forward content remains bounded and is verified against
    // the originating group whenever the gateway supplies a group id.
    const forwardIds=parts.filter(part=>part.type==='forward').map(part=>part.data?.id).filter((id): id is string | number=>id != null);
    let forward: ReturnType<typeof limitForward> | undefined;
    if (forwardIds.length) {
      const nodes: ForwardNode[]=[]; const unavailable: string[]=[];
      for (const forwardId of forwardIds) {
      try {
        const result=await call('get_forward_msg',{id:String(forwardId)});
        const rawNodes=result.messages || [];
        if (kind==='group' && rawNodes.some((node: ForwardRawNode)=>node.group_id != null && String(node.group_id)!==String(event.group_id))) throw new Error('forward source belongs to another chat');
        nodes.push(...forwardNodes(rawNodes));
      } catch(error) { unavailable.push(`${String(forwardId)}: ${String(error).slice(0,120)}`); }
      }
      const limited=limitForward(nodes);
      forward={...limited,...(unavailable.length?{unavailable:unavailable.join('; ')}:{})};
    }
    const downloaded = await downloadFiles(event, config, context, (file) => call('get_file', { file }));
    const files=downloaded.flatMap(item=>item.file?[item.file]:[]);
    let mediaIndex=0;
    const rendered=parts.map(part => {
      if(part.type==='text')return part.data.text || '';
      if(part.type==='at') return String(part.data.qq)===String(event.self_id) ? '' : `[@${String(part.data.qq || '').trim() || 'unknown'}]`;
      if(mediaKind(part)!==null)return mediaSummary(downloaded[mediaIndex++]!.media);
      return '';
    }).join('').trim();
    await onMessage({ ...admittedEnvelope, text:rendered || admittedEnvelope.text, files, ...(forward?{forward}: {}) });
  }

  async function provePrivateLike(message: ChatMessage, selfId: string) {
    if (!shouldProbePrivateLike(config, message)) return false;
    try {
      if (!selfId) return privateLikeFromProof(config, message, {complete: false});
      const groupId = Number(message.chatId);
      if (!Number.isSafeInteger(groupId)) return privateLikeFromProof(config, message, {complete: false});
      const members = await call('get_group_member_list', {group_id: groupId}) as unknown;
      if (!Array.isArray(members)) return privateLikeFromProof(config, message, {complete: false});
      const ids = members.map((member: unknown) => {
        if (!member || typeof member !== 'object') return '';
        const userId = (member as {user_id?: unknown}).user_id;
        return typeof userId === 'string' || typeof userId === 'number' ? String(userId).trim() : '';
      });
      if (ids.some(id => !id) || !ids.includes(selfId)) return privateLikeFromProof(config, message, {complete: false});
      return privateLikeFromProof(config, message, {
        complete: true,
        nonAgentUserIds: [...new Set(ids)].filter(id => id !== selfId),
      });
    } catch {
      return privateLikeFromProof(config, message, {complete: false});
    }
  }

  async function connect() {
    const generation = ++connectionGeneration;
    const Ws = config.WebSocket || (await import('ws')).WebSocket;
    const headers: Record<string, string> = config.token ? { Authorization: `Bearer ${config.token}` } : {};
    socket = new Ws(config.wsUrl, { headers });
    const current = socket;
    socket.on('message', (data) => { if (!stopped && generation === connectionGeneration && socket === current) void handle(data).catch((error) => context.log?.error?.('OneBot event error', error)); });
    socket.on('error', (error) => { if (!stopped && generation === connectionGeneration && socket === current) context.log?.warn?.('OneBot websocket error', error); });
    socket.on('close', () => {
      if (stopped || generation !== connectionGeneration || socket !== current) return;
      rejectPending(new Error('OneBot websocket closed before RPC response'));
      reconnectTimer = setTimeout(() => {
        if (stopped || generation !== connectionGeneration || socket !== current) return;
        void connect().catch((error) => { if (!stopped && generation === connectionGeneration) context.log?.warn?.('OneBot reconnect failed', error); });
      }, config.reconnectMs ?? 1000);
    });
    if (socket.readyState !== 1) {
      await new Promise<void>((resolve, reject) => {
        const opened = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => { socket?.off?.('open', opened); socket?.off?.('error', failed); };
        socket!.once('open', opened);
        socket!.once('error', failed);
      });
    }
  }

  function rpc(action: string, params: Record<string, unknown>): Promise<OneBotResult> {
    if (!socket || socket.readyState !== 1) throw new Error('OneBot websocket is not connected');
    const echo = randomUUID();
    return new Promise<OneBotResult>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`OneBot RPC timed out: ${action}`)); }, config.rpcTimeoutMs ?? 10000);
      pending.set(echo, { resolve, reject, timer });
      // Never retry sends: a missing response leaves delivery uncertain.
      socket!.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error) { clearTimeout(timer); pending.delete(echo); reject(error); }
      });
    });
  }

  async function call(action: string, params: Record<string, unknown>): Promise<OneBotResult> {
    if (!config.httpUrl) return rpc(action, params);
    const response = await (config.fetch || fetch)(`${config.httpUrl.replace(/\/$/, '')}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) }, body: JSON.stringify(params),
    });
    if (!response.ok) throw Object.assign(new Error(`OneBot HTTP ${action} failed: ${response.status}`),{fallbackSafe:true});
    const body = await response.json() as OneBotEvent;
    if (body.status === 'failed' || (body.retcode != null && body.retcode !== 0)) throw Object.assign(new Error(`OneBot HTTP ${action} failed (${body.retcode})`),{fallbackSafe:true});
    return body.data || {};
  }

  return {
    capabilities,
    async start(callback: (message: ChatMessage) => Promise<void>) { if (!stopped) throw new Error('OneBot adapter already started'); stopped = false; onMessage = callback; await connect(); },
    async stop() { stopped = true; connectionGeneration++; clearTimeout(reconnectTimer); reconnectTimer=undefined; rejectPending(new Error('OneBot adapter stopped')); const current = socket; socket = undefined; current?.close(); },
    async send(target: ChatTarget, output: ChatOutput): Promise<{id: string}> {
      if (output.editId) throw new Error('OneBot v11 does not define message editing');
      if(output.files?.some(file=>!(/^(image|audio|video)\//.test(file.mimeType || '')))) {
        // File transfer is an optional OneBot extension, not a v11 message segment.
        // Refuse mixed batches so a partial send cannot be mistaken for full success.
        if(output.text || output.files.length !== 1)throw new Error('OneBot file transfer requires one standalone file');
        const file=output.files[0], bytes=await readFile(file.path);
        if(bytes.length>20*1024*1024)throw new Error('OneBot attachment exceeds 20 MB limit');
        const group=target.kind==='group';
        const result=await call(group?'upload_group_file':'upload_private_file',{
          ...(group?{group_id:target.chatId}:{user_id:target.userId || target.chatId}),
          file:`base64://${bytes.toString('base64')}`,name:file.name || path.basename(file.path),upload_file:true,
        });
        const id=result?.file_id || result?.message_id;
        if(!id)throw new Error('OneBot file upload returned no file or message id');
        return {id:String(id)};
      }
      const message: Segment[] = [];
      if (output.replyTo) message.push({ type: 'reply', data: { id: String(output.replyTo) } });
      if (output.text) message.push({ type: 'text', data: { text: String(output.text) } });
      for (const file of output.files || []) {
        const mime=file.mimeType || '';
        const type=mime.startsWith('image/')?'image':mime.startsWith('audio/')?'record':mime.startsWith('video/')?'video':'file';
        // The OneBot gateway may run on another host; local paths are not portable.
        const bytes=await readFile(file.path);
        if(bytes.length>20*1024*1024)throw new Error('OneBot attachment exceeds 20 MB limit');
        message.push({type,data:{file:`base64://${bytes.toString('base64')}`,...(file.name?{name:file.name}:{})}});
      }
      if (!message.length) throw new Error('OneBot send requires text or files');
      const params = target.kind === 'group' ? { group_id: target.chatId, message } : { user_id: target.userId || target.chatId, message };
      const result = await call(target.kind === 'group' ? 'send_group_msg' : 'send_private_msg', params);
      if (result.message_id == null || result.message_id === '') throw new Error('OneBot send returned no message id');
      return { id: String(result.message_id) };
    },
    async delete(_target: ChatTarget, id: string) {
      if (id == null || id === '') throw new Error('OneBot delete requires a message id');
      await call('delete_msg', { message_id: id });
    },
    async startReaction(target: ChatTarget) {
      if (target.kind !== 'group' || !target.messageId) throw new Error('onebot_reaction_requires_group_message');
      await call('set_msg_emoji_like', {message_id: Number(target.messageId), emoji_id: '212', set: true});
      return {id: '212'};
    },
    async endReaction(target: ChatTarget, id: string) {
      if (target.kind !== 'group' || !target.messageId) return;
      await call('set_msg_emoji_like', {message_id: Number(target.messageId), emoji_id: String(id), set: false});
    },
    async typing() { throw new Error('OneBot v11 does not define typing indicators'); },
  };
}
