import type { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
interface FeishuConfig extends AdapterConfig {
 appId: string; appSecret: string; attachmentTimeoutMs?: number; verificationToken?: string; encryptKey?: string; botOpenId?: string;
 sdk?: typeof import('@larksuiteoapi/node-sdk'); client?: Pick<Client, 'im'>; wsClient?: Pick<WSClient, 'start' | 'close'>;
}
interface FeishuContent {text?: string; title?: string; image_key?: string; file_key?: string; file_name?: string; }
interface FeishuEvent {
 message?: {message_id: string; chat_id: string; chat_type: string; content?: string; parent_id?: string; create_time?: string; mentions?: {key?: string; id?: {open_id?: string}; open_id?: string}[]};
 sender?: {sender_id?: {open_id?: string; user_id?: string}};
 event?: FeishuEvent;
}
interface FeishuResult {data?: FeishuResult; message_id?: string; message?: {message_id?: string}; image_key?: string; file_key?: string; }
import type { AdapterConfig, AdapterContext, ChatAdapter, ChatMessage, ChatTarget, ChatOutput, ChatCommand, FileAttachment } from '../types.js';
import { platformError } from './types.js';
import { postData } from '../feishu-presentation.js';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { allowed } from '../policy.js';
import { privateLikeFromProof, shouldProbePrivateLike } from '../private-like.js';
import { COMMANDS, parseCommand, parseCommandText } from '../commands.js';

// Feishu posts are sent as immutable snapshots.  The API has update endpoints,
// but using them for live progress makes a private chat behave unlike the other
// non-editing transports and can leave a conversation full of rewritten posts.
const capabilities = Object.freeze({ edit: false, reaction: true, typing: false, maxText: 30000 });
const MEMBER_PROOF_PAGE_SIZE = 100;
const MEMBER_PROOF_MAX_PAGES = 100;

function richContent(value: unknown, botOpenId?: string) {
  const plain = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof plain.text === 'string') return {text: plain.text, media: [] as Array<{key: string; type: 'image' | 'file'; name: string}>};
  // Feishu posts appear as {post:{locale:{title,content}}}, {locale:{...}},
  // or the locale object itself. Preserve title and rows in provider order.
  const candidate = plain.post && typeof plain.post === 'object' ? plain.post as Record<string, unknown> : plain;
  const locale = Array.isArray(candidate.content) ? candidate : Object.values(candidate).find(part => part && typeof part === 'object' && Array.isArray((part as {content?: unknown}).content)) as Record<string, unknown> | undefined;
  if (!locale) return {text: typeof plain.title === 'string' ? plain.title : '', media: [] as Array<{key: string; type: 'image' | 'file'; name: string}>};
  const media: Array<{key: string; type: 'image' | 'file'; name: string}> = [];
  const lines = (locale.content as unknown[]).map(row => Array.isArray(row) ? row.map(node => {
    if (!node || typeof node !== 'object') return '';
    const item = node as {tag?: unknown; text?: unknown; href?: unknown; user_name?: unknown; name?: unknown; id?: unknown; user_id?: unknown; image_key?: unknown; file_key?: unknown; file_name?: unknown; alt?: unknown};
    const tag = String(item.tag || '').toLowerCase();
    const userId = item.user_id ?? item.id;
    if (tag === 'at') return botOpenId && String(userId || '') === botOpenId ? '' : `@${String(item.user_name || item.name || userId || 'unknown')}`;
    const imageKey = typeof item.image_key === 'string' ? item.image_key : '';
    const fileKey = typeof item.file_key === 'string' ? item.file_key : '';
    if (imageKey) { const name=String(item.alt || imageKey); media.push({key: imageKey, type: 'image', name}); return `[image: ${name}]`; }
    if (fileKey) { const name=String(item.file_name || fileKey); media.push({key: fileKey, type: 'file', name}); return `[file: ${name}]`; }
    if (tag === 'a' && item.href && item.text) return `[${String(item.text)}](${String(item.href)})`;
    return String(item.text || item.href || '');
  }).join('') : '').join('\n');
  return {text: [typeof locale.title === 'string' ? locale.title : '', lines].filter(Boolean).join('\n'), media};
}

function unwrap(response: FeishuResult | null): FeishuResult { return response?.data?.data || response?.data || response || {}; }

// Use the SDK response envelope, not a generic network Error.message.  A
// missing message is harmless only while deleting a retired remote post; broad
// SDK target_revoked classifications also include chat/permission failures.
function apiFailure(input: unknown) {
  const value = platformError(input);
  const data=value?.response?.data || (value?.code !== undefined ? value : value?.data || value);
  const code=Number(data?.code);
  if(!Number.isFinite(code) || code===0)return null;
  return {code,message:String(data.msg || data.message || '')};
}
function checked<T>(result: T): T {
  const failure=apiFailure(result);
  if(failure)throw Object.assign(new Error(`Feishu API ${failure.code}: ${failure.message}`),{code:failure.code,msg:failure.message,fallbackSafe:true});
  return result;
}
function missingRemoteMessage(error: unknown) {
  const failure=apiFailure(error);
  return Boolean(failure && /^(?:the )?message (?:is |was |has been )?(?:recalled|withdrawn|deleted|not found|does not exist|cannot be edited|can't be edited)[.!]?$/i.test(failure.message.trim()));
}

async function readLimited(stream: Readable, limit: number) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) { stream.destroy?.(); throw new Error('Feishu attachment exceeds 20 MB limit'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export function createAdapter(config: FeishuConfig, context: AdapterContext) {
  if (!config?.appId || !config?.appSecret) throw new Error('Feishu adapter requires appId and appSecret');
  if (!Array.isArray(config.allowUsers) || config.allowUsers.length === 0) throw new Error('Feishu adapter requires a non-empty allowUsers list');
  let client: Pick<Client, 'im'> | undefined;
  let wsClient: Pick<WSClient, 'start' | 'close'> | undefined;
  let dispatcher: EventDispatcher;
  let cancelRecovery: (() => void) | undefined;
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;

  async function provePrivateLike(message: ChatMessage) {
    if (!shouldProbePrivateLike(config, message)) return false;
    try {
      const list = client?.im.chatMembers?.get;
      if (!list) return privateLikeFromProof(config, message, {complete: false});
      const ids: string[] = [];
      const seenTokens = new Set<string>();
      let total: number | undefined;
      let pageToken: string | undefined;
      for (let page = 0; page < MEMBER_PROOF_MAX_PAGES; page++) {
        const response = await list({
          path: {chat_id: message.chatId},
          params: {member_id_type: 'open_id', page_size: MEMBER_PROOF_PAGE_SIZE, ...(pageToken ? {page_token: pageToken} : {})},
        });
        const data = response?.code === 0 ? response.data : null;
        if (!data || data.trigger_security_conf_limit || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') return privateLikeFromProof(config, message, {complete: false});
        const memberTotal = Number(data.member_total);
        if (!Number.isSafeInteger(memberTotal) || memberTotal < 0 || (total !== undefined && total !== memberTotal)) return privateLikeFromProof(config, message, {complete: false});
        total = memberTotal;
        const pageIds = data.items.map((item: unknown) => String((item as {member_id?: unknown})?.member_id || '').trim());
        if (pageIds.some((id: string) => !id)) return privateLikeFromProof(config, message, {complete: false});
        ids.push(...pageIds);
        if (!data.has_more) {
          const uniqueIds = [...new Set(ids)];
          if (uniqueIds.length !== total) return privateLikeFromProof(config, message, {complete: false});
          const getChat = client?.im.chat?.get;
          if (!getChat) return privateLikeFromProof(config, message, {complete: false});
          const chat = await getChat({path: {chat_id: message.chatId}});
          const chatData = chat?.code === 0 ? chat.data : null;
          const userCount = typeof chatData?.user_count === 'string' && /^(0|[1-9]\d*)$/.test(chatData.user_count) ? Number(chatData.user_count) : null;
          const botCount = typeof chatData?.bot_count === 'string' && /^(0|[1-9]\d*)$/.test(chatData.bot_count) ? Number(chatData.bot_count) : null;
          return userCount === uniqueIds.length && botCount === 1
            ? privateLikeFromProof(config, message, {complete: true, nonAgentUserIds: uniqueIds})
            : privateLikeFromProof(config, message, {complete: false});
        }
        const next = String(data.page_token || '').trim();
        if (!next || seenTokens.has(next)) return privateLikeFromProof(config, message, {complete: false});
        seenTokens.add(next);
        pageToken = next;
      }
    } catch {
      return privateLikeFromProof(config, message, {complete: false});
    }
    return privateLikeFromProof(config, message, {complete: false});
  }

  async function saveResource(messageId: string, key: string, type: 'image' | 'file', name: string) {
    const result = await client!.im.messageResource.get({ path: { message_id: messageId, file_key: key }, params: { type } });
    const declared = Number(result.headers?.['content-length'] || result.headers?.get?.('content-length') || 0);
    if (declared > 20 * 1024 * 1024) throw new Error('Feishu attachment exceeds 20 MB limit');
    if (typeof result.getReadableStream !== 'function') throw new Error('Feishu resource response does not expose getReadableStream()');
    const adapterId = path.basename(String(config.id || 'feishu')).replaceAll(/[^\p{L}\p{N}._-]/gu, '_') || 'feishu';
    const dir = path.join(context.dataDir, 'attachments', adapterId, randomUUID());
    await mkdir(dir, { recursive: true });
    const safe = `${randomUUID()}-${path.basename(name || key).replaceAll(/[^\p{L}\p{N}._-]/gu, '_')}`;
    const filePath = path.join(dir, safe);
    const stream = result.getReadableStream();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stream.destroy?.(); reject(new Error('Feishu attachment download timed out')); }, config.attachmentTimeoutMs ?? 15000);
      timer.unref?.();
    });
    const bytes = await Promise.race([readLimited(stream, 20 * 1024 * 1024), timeout]).finally(() => clearTimeout(timer));
    await writeFile(filePath, bytes);
    return { path: filePath, name: safe };
  }

  return {
    capabilities,
    async start(onMessage: (message: ChatMessage) => Promise<void>) {
      if (client) throw new Error('Feishu adapter already started');
      const sdk = config.sdk || await import('@larksuiteoapi/node-sdk');
      client = config.client || new sdk.Client({ appId: config.appId, appSecret: config.appSecret, appType: sdk.AppType?.SelfBuild, domain: sdk.Domain?.Feishu });
      let recoveryActive = true;
      const headsKey = `feishu:${config.id}:recovery-heads`;
      const heads = context.getCursor<Record<string, {messageId: string; createTime: number; kind?: 'dm' | 'group'}>>(headsKey) || {};
      const recovering = new Set<string>();
      const buffered = new Map<string, Array<{raw: FeishuEvent; resolve: () => void; reject: (error: unknown) => void}>>();
      const handleRaw = async (rawEvent: FeishuEvent) => {
          if (!recoveryActive) return;
          const event: FeishuEvent = rawEvent;
          const message = event.message || event.event?.message;
          const sender = event.sender || event.event?.sender;
          if (!message || !sender) return;
          const kind = message.chat_type === 'p2p' ? 'dm' : 'group';
          const userId = String(sender.sender_id?.open_id || sender.sender_id?.user_id || '');
          let content: FeishuContent = {};
          try { content = JSON.parse(message.content || '{}'); } catch { content = { text: message.content || '' }; }
          const rich = richContent(content, config.botOpenId);
          const text = rich.text.trim();
          const botMentions = kind === 'group' && Boolean(config.botOpenId) && Array.isArray(message.mentions)
            ? message.mentions.filter((mention) => String(mention.id?.open_id || mention.open_id || '') === String(config.botOpenId)) : [];
          const mentioned = botMentions.length > 0;
          const commandText = botMentions.reduce((value, mention) => {
            const key = String(mention.key || '');
            return key ? value.split(key).join('') : value;
          }, text).trim();
          const parsed = parseCommandText(commandText,commands);
          const botOpenId = String(config.botOpenId || '').toLowerCase();
          const commandTarget = parsed?.target ? (botOpenId && parsed.target === botOpenId ? 'self' : 'other') : undefined;
          const command = Boolean(parseCommand(commandText,commands,commandTarget));
          // Admission deliberately precedes membership and authenticated resource requests.
          if (!Array.isArray(config.allowUsers) || !config.allowUsers.includes(userId)) return;
          const envelope: ChatMessage = {
            id: String(message.message_id), chatId: String(message.chat_id), userId, kind,
            mentioned,
            // Keep command-like text after removing our mention even when it is
            // unknown or addressed elsewhere, so the bridge can reject it
            // instead of treating the original mention markup as a prompt.
            text: parsed ? commandText : text, files: [],
            ...(commandTarget ? { commandTarget } : {}),
            ...(message.parent_id ? { replyTo: String(message.parent_id) } : {}),
          };
          const privateLike = await provePrivateLike(envelope);
          const admittedEnvelope = privateLike ? {...envelope, privateLike: true} : envelope;
          const policyEnvelope = (content.image_key || content.file_key || rich.media.length) && !admittedEnvelope.text
            ? {...admittedEnvelope, files: [{path: 'inbound-media'}]}
            : admittedEnvelope;
          if (!allowed(config, policyEnvelope, {command})) return;
          if (context.isBound && !await context.isBound(admittedEnvelope)) return;
          const files = [];
          if (content.image_key) files.push({ ...(await saveResource(message.message_id, content.image_key, 'image', `${content.image_key}.jpg`)), mimeType: 'image/*' });
          if (content.file_key) files.push(await saveResource(message.message_id, content.file_key, 'file', content.file_name || content.file_key));
          for (const resource of rich.media) files.push({...(await saveResource(message.message_id, resource.key, resource.type, resource.name)), ...(resource.type === 'image' ? {mimeType: 'image/*'} : {})});
          if (!recoveryActive) return;
          await onMessage({ ...admittedEnvelope, files });
          const createTime = Number(message.create_time);
          if (Number.isSafeInteger(createTime) && createTime >= 0) {
            heads[String(message.chat_id)] = {messageId: String(message.message_id), createTime, kind};
            context.setCursor(headsKey, heads);
          }
      };
      cancelRecovery = () => {
        recoveryActive = false;
        for (const queue of buffered.values()) for (const entry of queue) entry.reject(new Error('Feishu adapter stopped during recovery'));
        buffered.clear(); recovering.clear();
      };
      const receive = async (rawEvent: FeishuEvent) => {
        if (!recoveryActive) return;
        const chatId = String((rawEvent.message || rawEvent.event?.message)?.chat_id || '');
        if (!chatId || !recovering.has(chatId)) return handleRaw(rawEvent);
        await new Promise<void>((resolve, reject) => {
          const queue = buffered.get(chatId) || [];
          queue.push({raw: rawEvent, resolve, reject}); buffered.set(chatId, queue);
        });
      };
      dispatcher = new sdk.EventDispatcher({ verificationToken: config.verificationToken, encryptKey: config.encryptKey }).register({
        'im.message.receive_v1': receive,
      });
      async function recoverChat(chatId: string, head: {messageId: string; createTime: number; kind?: 'dm' | 'group'}) {
        try {
          if (!recoveryActive) return;
          const list = client?.im.message?.list;
          if (!list) throw new Error('feishu_history_api_missing');
          let pageToken: string | undefined;
          let found = false;
          const recovered: FeishuEvent[] = [];
          const seenTokens = new Set<string>();
          for (let page = 0; page < 100; page++) {
            if (!recoveryActive) return;
            const response = await list({params: {container_id_type: 'chat', container_id: chatId, start_time: String(Math.max(0, Math.floor(head.createTime / 1000) - 1)), sort_type: 'ByCreateTimeAsc', page_size: 50, ...(pageToken ? {page_token: pageToken} : {})}});
            const data = response.data;
            if (response.code !== 0 || !data?.items || typeof data.has_more !== 'boolean') throw new Error('feishu_history_incomplete');
            for (const item of data.items) {
              if (!found) { if (item.message_id === head.messageId) found = true; continue; }
              const sender = item.sender;
              const senderId = sender?.id;
              const idType = sender?.id_type;
              if (!item.message_id || !item.chat_id || !senderId || (idType !== 'open_id' && idType !== 'user_id')) continue;
              recovered.push({message: {message_id: item.message_id, chat_id: item.chat_id, chat_type: head.kind === 'dm' ? 'p2p' : 'group', content: item.body?.content, parent_id: item.parent_id, create_time: item.create_time, mentions: item.mentions?.map(mention => ({key: mention.key, open_id: mention.id_type === 'open_id' ? mention.id : undefined}))}, sender: {sender_id: idType === 'open_id' ? {open_id: senderId} : {user_id: senderId}}});
            }
            if (!data.has_more) break;
            const next = data.page_token;
            if (!next || seenTokens.has(next)) throw new Error('feishu_history_incomplete');
            seenTokens.add(next); pageToken = next;
            if (page === 99) throw new Error('feishu_history_incomplete');
          }
          if (!found) throw new Error('feishu_history_cursor_missing');
          for (const raw of recovered) { if (!recoveryActive) return; await handleRaw(raw); }
        } finally {
          // Keep the gate closed while draining. New live arrivals join this same
          // FIFO; only delete it after observing the queue empty.
          for (;;) {
            if (!recoveryActive) break;
            const queue = buffered.get(chatId);
            if (!queue?.length) break;
            const entry = queue.shift()!;
            try { await handleRaw(entry.raw); entry.resolve(); } catch (error) { entry.reject(error); }
          }
          buffered.delete(chatId);
          recovering.delete(chatId);
        }
      }
      // Gates exist before the socket subscribes. Start history only after the
      // subscription has completed so its time window cannot precede a live gap.
      for (const chatId of Object.keys(heads)) recovering.add(chatId);
      wsClient = config.wsClient || new sdk.WSClient({ appId: config.appId, appSecret: config.appSecret, loggerLevel: sdk.LoggerLevel?.info });
      await wsClient.start({ eventDispatcher: dispatcher });
      await Promise.all(Object.entries(heads).map(async ([chatId, head]) => {
        try { await recoverChat(chatId, head); } catch (error) { context.log?.warn?.('feishu inbound recovery failed', error); }
      }));
    },
    async stop() { cancelRecovery?.(); cancelRecovery = undefined; const ws = wsClient; wsClient = undefined; client = undefined; await ws?.close?.(); },
    async send(target: ChatTarget, output: ChatOutput): Promise<{id: string}> {
      if (!client) throw new Error('Feishu adapter is not started');
      const receiveIdType = 'chat_id';
      const receiveId = target.chatId;
      if (output.editId) throw new Error('Feishu adapter does not support editing sent messages');
      let result: FeishuResult | undefined;
      if (output.replyTo && output.text) {
        result = await client.im.message.reply({ path: { message_id: String(output.replyTo) }, data: postData(String(output.text)) });
      } else if (output.text) {
        result = await client.im.message.create({ params: { receive_id_type: receiveIdType }, data: { receive_id: String(receiveId), ...postData(String(output.text)) } });
      }
      for (const file of output.files || []) {
        const image = file.mimeType?.startsWith('image/');
        const uploaded = image
          ? await client.im.image.create({ data: { image_type: 'message', image: createReadStream(file.path) } })
          : await client.im.file.create({ data: { file_type: 'stream', file_name: file.name || path.basename(file.path), file: createReadStream(file.path) } });
        const key = unwrap(uploaded)?.[image ? 'image_key' : 'file_key'];
        if(!key)throw Object.assign(new Error('Feishu upload returned no media key'),{fallbackSafe:true});
        const data={msg_type:image?'image':'file',content:JSON.stringify({[image?'image_key':'file_key']:key})};
        const media=output.replyTo && !result
          ? await client.im.message.reply({path:{message_id:String(output.replyTo)},data})
          : await client.im.message.create({params:{receive_id_type:receiveIdType},data:{receive_id:String(receiveId),...data}});
        result ||= media;
      }
      if (!result) throw new Error('Feishu send requires text or files');
      checked(result);
      const data = unwrap(result);
      const id = data.message_id || data.message?.message_id;
      if (id == null || id === '') throw new Error('Feishu send returned no message id');
      return { id: String(id) };
    },
    async delete(_target: ChatTarget, id: string) {
      if (!client) throw new Error('Feishu adapter is not started');
      if (id == null || id === '') throw new Error('Feishu delete requires a message id');
      try { checked(await client.im.message.delete({ path: { message_id: String(id) } })); }
      catch (errorValue) { const error = platformError(errorValue);if(!missingRemoteMessage(error))throw error;}
    },
    async typing() { throw new Error('Feishu bot API does not support typing indicators'); },
    async startReaction(target: ChatTarget) {
      if (!target.messageId) throw new Error('feishu_reaction_requires_message');
      if (!client) throw new Error('Feishu adapter is not started');
      const result = await client.im.messageReaction.create({path:{message_id:String(target.messageId)},data:{reaction_type:{emoji_type:'THINKING'}}});
      checked(result);
      const id = result.data?.reaction_id;
      if (!id) throw new Error('Feishu reaction returned no id');
      return {id:String(id)};
    },
    async endReaction(target: ChatTarget, id: string) {
      if (!client) throw new Error('Feishu adapter is not started');
      if (!target.messageId) throw new Error('feishu_reaction_requires_message');
      checked(await client.im.messageReaction.delete({path:{message_id:String(target.messageId), reaction_id:String(id)}}));
    },
  };
}
