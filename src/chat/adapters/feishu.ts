import type { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
interface FeishuConfig extends AdapterConfig {
 appId: string; appSecret: string; attachmentTimeoutMs?: number; verificationToken?: string; encryptKey?: string; botOpenId?: string;
 sdk?: typeof import('@larksuiteoapi/node-sdk'); client?: Pick<Client, 'im'>; wsClient?: Pick<WSClient, 'start' | 'close'>;
}
interface FeishuContent {text?: string; title?: string; image_key?: string; file_key?: string; file_name?: string; }
interface FeishuEvent {
 message?: {message_id: string; chat_id: string; chat_type: string; content?: string; parent_id?: string; mentions?: {key?: string; id?: {open_id?: string}; open_id?: string}[]};
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
import { admitted } from '../policy.js';
import { COMMANDS, parseCommand, parseCommandText } from '../commands.js';

// Feishu posts are sent as immutable snapshots.  The API has update endpoints,
// but using them for live progress makes a private chat behave unlike the other
// non-editing transports and can leave a conversation full of rewritten posts.
const capabilities = Object.freeze({ edit: false, typing: false, maxText: 30000 });

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
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;

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
      dispatcher = new sdk.EventDispatcher({ verificationToken: config.verificationToken, encryptKey: config.encryptKey }).register({
        'im.message.receive_v1': async (rawEvent) => {
          const event: FeishuEvent = rawEvent;
          const message = event.message || event.event?.message;
          const sender = event.sender || event.event?.sender;
          if (!message || !sender) return;
          const kind = message.chat_type === 'p2p' ? 'dm' : 'group';
          const userId = String(sender.sender_id?.open_id || sender.sender_id?.user_id || '');
          let content: FeishuContent = {};
          try { content = JSON.parse(message.content || '{}'); } catch { content = { text: message.content || '' }; }
          const text = String(content.text || content.title || '').trim();
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
          // Admission deliberately precedes authenticated resource downloads.
          if (!admitted({...config,type:'feishu'},userId,kind,{command})) return;
          if (kind === 'group' && config.requireMention !== false && !mentioned && !command) return;
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
          if (context.isBound && !await context.isBound(envelope)) return;
          const files = [];
          if (content.image_key) files.push({ ...(await saveResource(message.message_id, content.image_key, 'image', `${content.image_key}.jpg`)), mimeType: 'image/*' });
          if (content.file_key) files.push(await saveResource(message.message_id, content.file_key, 'file', content.file_name || content.file_key));
          await onMessage({ ...envelope, files });
        },
      });
      wsClient = config.wsClient || new sdk.WSClient({ appId: config.appId, appSecret: config.appSecret, loggerLevel: sdk.LoggerLevel?.info });
      await wsClient.start({ eventDispatcher: dispatcher });
    },
    async stop() { const ws = wsClient; wsClient = undefined; client = undefined; await ws?.close?.(); },
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
  };
}
