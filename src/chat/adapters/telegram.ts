import type { Api, InputFile as GrammyInputFile, RawApi } from 'grammy';
import type { Message, Update, User } from 'grammy/types';
interface TelegramConfig extends AdapterConfig {
 __api?: {raw: RawApi} | Partial<RawApi>; __InputFile?: typeof GrammyInputFile; __fetch?: typeof fetch;
}
type FileDescriptor = {id: string; name?: string; mimeType?: string};
type MediaField = 'animation' | 'photo' | 'video' | 'voice' | 'audio' | 'document';
import type { AdapterConfig, AdapterContext, ChatAdapter, ChatMessage, ChatTarget, ChatOutput, ChatCommand, FileAttachment } from '../types.js';
import { platformError } from './types.js';
import {mkdir, writeFile} from 'node:fs/promises';
import {basename, extname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {telegramHtmlToPlainText} from '../presentation.js';
import {admitted} from '../policy.js';
import {COMMANDS,parseCommand,registerCommands} from '../commands.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function explicitMediaRejection(value: unknown) {
  const error = platformError(value);
  const status=Number(error?.error_code ?? error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isFinite(status) && status>=400 && status<500;
}

function fileDescriptor(message: Message): FileDescriptor | null {
  if (message.document) return {id: message.document.file_id, name: message.document.file_name, mimeType: message.document.mime_type};
  if (message.video) return {id: message.video.file_id, name: 'video.mp4', mimeType: message.video.mime_type};
  if (message.audio) return {id: message.audio.file_id, name: message.audio.file_name || 'audio.mp3', mimeType: message.audio.mime_type};
  if (message.voice) return {id: message.voice.file_id, name: 'voice.ogg', mimeType: message.voice.mime_type};
  if (message.animation) return {id: message.animation.file_id, name: message.animation.file_name || 'animation.mp4', mimeType: message.animation.mime_type};
  if (message.sticker) return {id: message.sticker.file_id, name: 'sticker.webp', mimeType: 'image/webp'};
  const photo = message.photo?.at?.(-1);
  return photo ? {id: photo.file_id, name: 'photo.jpg', mimeType: 'image/jpeg'} : null;
}

export function normalizeTelegramUpdate(update: Update, config: TelegramConfig, bot: {id?: string | number; username?: string} = {}, commands = COMMANDS): (ChatMessage & {descriptor: FileDescriptor | null}) | null {
  const message = update?.message;
  if (!message || message.from?.is_bot) return null;
  const userId = String(message.from?.id || '');
  const kind = message.chat?.type === 'private' ? 'dm' : 'group';
  const raw = String(message.text || message.caption || '');
  const entities = message.entities || message.caption_entities || [];
  const username = String(bot.username || '').replace(/^@/, '').toLowerCase();
  let mentioned = kind === 'dm';
  let text = raw;
  for (const entity of [...entities].sort((a, b) => b.offset - a.offset)) {
    const token = raw.slice(entity.offset, entity.offset + entity.length);
    const matches = entity.type === 'mention' && username && token.replace(/^@/, '').toLowerCase() === username;
    const textMatch = entity.type === 'text_mention' && String(entity.user?.id) === String(bot.id);
    if (matches || textMatch) { mentioned = true; text = text.slice(0, entity.offset) + text.slice(entity.offset + entity.length); }
  }
  text = text.trim();
  const commandMatch = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(text);
  let commandTarget: 'self' | 'other' | undefined;
  if (commandMatch) {
    const target = String(commandMatch[2] || '').toLowerCase();
    if (target) commandTarget = username && target === username ? 'self' : 'other';
    if (commands.some(command => command.name === commandMatch[1].toLowerCase()) && commandTarget !== 'other') {
      if (target) mentioned = true;
      text = `/${commandMatch[1].toLowerCase()}${text.slice(commandMatch[0].length)}`;
    }
  }
  const recognizedCommand = Boolean(parseCommand(text,commands,commandTarget));
  if (!userId || !admitted({...config,type:'telegram'},userId,kind,{command:recognizedCommand})) return null;
  if (kind === 'group' && (config.requireMention ?? true) && !mentioned && !recognizedCommand) return null;
  return {id: String(message.message_id), chatId: String(message.chat.id), userId, kind, mentioned,
    text: text.trim(), replyTo: message.reply_to_message?.message_id ? String(message.reply_to_message.message_id) : undefined,
    ...(commandTarget ? {commandTarget} : {}),
    descriptor: fileDescriptor(message)};
}

export function createAdapter(config: TelegramConfig, context: AdapterContext) {
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;
  const telegramCommands = commands.map(({name, description}) => ({command: name, description}));
  let api: {raw: RawApi} | Partial<RawApi>;
  let InputFile: typeof GrammyInputFile | undefined;
  let running = false;
  let pollPromise: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let bot: {id?: string; username?: string} = {};
  let onMessage: (message: ChatMessage) => Promise<void>;
  const cursorKey = `telegram:${config.id}:offset`;
  const fetchImpl = config.__fetch || globalThis.fetch;
  const capabilities = {edit: true, typing: true, maxText: 4096};

  async function call<K extends keyof RawApi>(method: K, payload: Parameters<RawApi[K]>[0], signal?: AbortSignal): Promise<Awaited<ReturnType<RawApi[K]>>> {
    const owner = 'raw' in api ? api.raw : api;
    const fn = owner[method];
    if (typeof fn !== 'function') throw new Error(`telegram_api_method_missing:${method}`);
    // The method and payload remain correlated at the public generic boundary.
    const invoke = fn as (payload: Parameters<RawApi[K]>[0], signal?: AbortSignal) => Promise<Awaited<ReturnType<RawApi[K]>>>;
    return await invoke.call(owner, method === 'getMe' ? signal as Parameters<RawApi[K]>[0] : payload, signal);
  }

  async function download(descriptor: FileDescriptor | null) {
    if (!descriptor) return [];
    const remote = await call('getFile', {file_id: descriptor.id});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const chunks = [];
    let size = 0;
    try {
      const response = await fetchImpl(`https://api.telegram.org/file/bot${config.token}/${remote.file_path}`, {signal: controller.signal});
      if (!response.ok) throw new Error(`telegram_attachment_download_failed:${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) throw new Error('telegram_attachment_too_large');
      if (!response.body?.getReader) throw new Error('telegram_attachment_stream_required');
      const reader = response.body.getReader();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new Error('telegram_attachment_too_large'); }
        chunks.push(Buffer.from(value));
      }
    } finally { clearTimeout(timeout); }
    const directory = join(context.dataDir, 'chat', 'attachments', 'telegram');
    await mkdir(directory, {recursive: true});
    const name = basename(String(descriptor.name || 'attachment')).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || 'attachment';
    const filePath = join(directory, `${Date.now()}-${randomUUID()}${extname(name)}`);
    await writeFile(filePath, Buffer.concat(chunks, size));
    return [{path: filePath, name, mimeType: descriptor.mimeType || undefined}];
  }

  async function process(update: Update) {
    const incoming = normalizeTelegramUpdate(update, config, bot, commands);
    if (!incoming) return;
    const {descriptor, ...value} = incoming;
    if (context.isBound && !await context.isBound(value)) return;
    const files = await download(descriptor);
    await onMessage({...value, files});
  }

  async function poll() {
    let offset = Number(await context.getCursor(cursorKey)) || 0;
    while (running) {
      abort = new AbortController();
      try {
        const updates = await call('getUpdates', {offset, timeout: 25, limit: 100, allowed_updates: ['message']}, abort.signal);
        for (const update of updates || []) {
          await process(update);
          const next = Number(update.update_id) + 1;
          if (Number.isFinite(next)) { await context.setCursor(cursorKey, next); offset = next; }
        }
      } catch (errorValue) { const error = platformError(errorValue);
        if (!running) break;
        context.log?.warn?.('telegram poll failed');
        await delay(1000);
      }
    }
  }

  return {
    capabilities,
    async start(handler: (message: ChatMessage) => Promise<void>) {
      if (!Array.isArray(config.allowUsers) || config.allowUsers.length === 0) throw new Error('telegram_allow_users_required');
      if (!config.token) throw new Error('telegram_token_required');
      onMessage = handler;
      if (config.__api) { api = config.__api; InputFile = config.__InputFile; }
      else { const Grammy = await import('grammy'); api = new Grammy.Api(config.token); InputFile = Grammy.InputFile; }
      try { await call('deleteWebhook', {drop_pending_updates: false}); } catch {}
      const me = await call('getMe', undefined);
      bot = {id: String(me.id), username: me.username || ''};
      await registerCommands(async()=>{
        for (const type of ['all_private_chats','all_group_chats','all_chat_administrators'] as const) {
          await call('deleteMyCommands', {scope: {type}});
        }
        const scope = {type: 'default' as const};
        const current = await call('getMyCommands', {scope});
        if (JSON.stringify(current || []) !== JSON.stringify(telegramCommands)) {
          await call('setMyCommands', {commands: telegramCommands, scope});
        }
      },context.log,'Telegram command registration failed');
      running = true;
      pollPromise = poll();
    },
    async stop() { running = false; abort?.abort(); await pollPromise; pollPromise = undefined; },
    async send(target: ChatTarget, output: ChatOutput): Promise<{id: string}> {
      const chat_id = target.chatId;
      const reply = output.replyTo ? {reply_parameters: {message_id: Number(output.replyTo), allow_sending_without_reply: true}} : {};
      const textPayload = {chat_id, text: String(output.text || ''), ...(output.parseMode === 'HTML' ? {parse_mode: 'HTML' as const} : {})};
      // Only a confirmed entity-parser rejection can safely trigger a plain-text resend.
      const textCall = async (method: 'sendMessage' | 'editMessageText', payload: Parameters<RawApi['sendMessage']>[0] & {message_id?: number}) => {
        try { return await call(method, payload); }
        catch (errorValue) { const error = platformError(errorValue);
          const description = String(error?.description || error?.message || '');
          if (!payload.parse_mode || !/can't parse entities|cannot parse entities|unsupported start tag|can't find end tag/i.test(description)) throw error;
          const {parse_mode, ...plain} = payload;
          return await call(method, {...plain, text: telegramHtmlToPlainText(payload.text)});
        }
      };
      let result;
      if (output.editId) {
        if (output.files?.length) throw new Error('telegram_edit_with_files_unsupported');
        try {
          await textCall('editMessageText', {...textPayload, message_id: Number(output.editId)});
          return {id: String(output.editId)};
        } catch (errorValue) { const error = platformError(errorValue);
          const description = String(error?.description || error?.message || '');
          if (/message is not modified/i.test(description)) return {id: String(output.editId)};
          if (!/message to edit not found|message can't be edited|message identifier is not specified/i.test(description)) throw error;
          try { result = await textCall('sendMessage', {...textPayload, ...reply}); }
          catch (replacementErrorValue) { const replacementError = platformError(replacementErrorValue);
            // The original message is gone; retrying this as an ordinary edit could duplicate a replacement.
            replacementError.deliveryUncertain = true;
            throw replacementError;
          }
        }
      } else if (output.text) {
        result = await textCall('sendMessage', {...textPayload, ...reply});
      }
      for (const file of output.files || []) {
        const mime = String(file.mimeType || '').toLowerCase();
        const field = mime === 'image/gif' ? 'animation' : mime.startsWith('image/') ? 'photo'
          : mime.startsWith('video/') ? 'video' : mime === 'audio/ogg' || mime === 'audio/opus' ? 'voice'
          : mime.startsWith('audio/') ? 'audio' : 'document';
        const sendFile = (nextField: MediaField) => {
          const media = InputFile ? new InputFile(file.path, file.name) : file.path;
          switch(nextField) {
            case 'animation': return call('sendAnimation', {chat_id, animation: media, ...reply});
            case 'photo': return call('sendPhoto', {chat_id, photo: media, ...reply});
            case 'video': return call('sendVideo', {chat_id, video: media, ...reply});
            case 'voice': return call('sendVoice', {chat_id, voice: media, ...reply});
            case 'audio': return call('sendAudio', {chat_id, audio: media, ...reply});
            case 'document': return call('sendDocument', {chat_id, document: media, ...reply});
          }
        };
        let fileResult;
        try { fileResult = await sendFile(field); }
        catch (errorValue) { const error = platformError(errorValue);
          if (field !== 'photo' || !/PHOTO_INVALID_DIMENSIONS/i.test(String(error?.description || error?.message || ''))) {
            if(explicitMediaRejection(error))error.fallbackSafe=true;throw error;
          }
          try { fileResult = await sendFile('document'); }
          catch (documentErrorValue) { const documentError = platformError(documentErrorValue); if(explicitMediaRejection(documentError))documentError.fallbackSafe=true;throw documentError; }
        }
        if (!result) result = fileResult;
      }
      if (!result) throw new Error('telegram_empty_output');
      return {id: String(typeof result === 'object' ? result.message_id : output.editId)};
    },
    async typing(target: ChatTarget) { await call('sendChatAction', {chat_id: target.chatId, action: 'typing'}); },
    async delete(target: ChatTarget, messageId: string) {
      try {
        await call('deleteMessage', {chat_id: target.chatId, message_id: Number(messageId)});
      } catch (errorValue) { const error = platformError(errorValue);
        if (/message (?:to delete )?not found/i.test(String(error?.description || error?.message || ''))) return;
        throw error;
      }
    },
  };
}
