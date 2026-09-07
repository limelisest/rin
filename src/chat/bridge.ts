import type { ChatConfig, AdapterConfig, ChatMessage, ChatTarget, ChatOutput, Binding, ChatCommand, CommandContext, Logger, AdapterContext, ChatAdapter, PublicItem, CodexEvent } from './types.js';
import type { CodexBridge } from './codex.js';
type AutoBindingState = {state: 'bound'; binding: Binding} | {state: 'creating' | 'uncertain'};
type AutoBindings = Record<string, AutoBindingState>;
interface Segments { current: number; questions: string[]; items: Record<string, number>; groups: string[]; }
const failure = (error: unknown) => error as {threadId?: string; code?: string; cause?: {code?: string}; fallbackSafe?: boolean; deliveryUncertain?: boolean};
import { COMMANDS, parseCommandText, builtinCommands, commandHelp } from './commands.js';
import { loadCommandExtensions } from './command-extensions.js';
import { executeUsage } from './usage.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { AttentionClient } from './attention-client.js';
import { ChatStore, stableId } from './store.js';
import { allowed, splitText, validateConfig } from './policy.js';
import { outputFiles, outputParts } from './files.js';
import { prepareText, editableIntermediateHeadText, composeEditableMessageText, normalizeAssistantSummaryText, stripMarkdownFormatting } from './presentation.js';
import { resolveWorking, workingFrame } from './working.js';

export class ChatBridge {
  config: ChatConfig; log: Logger; usage: typeof executeUsage; commands: ChatCommand[]; store: ChatStore; attention: AttentionClient | null;
  bindingCreations: Map<string, Promise<Binding>>; codex: CodexBridge; adapterFactory: (config: AdapterConfig, context: AdapterContext) => Promise<ChatAdapter> | ChatAdapter;
  adapters: Map<string, ChatAdapter>; items: Map<string, PublicItem>; finalizedTurns: Set<string>; active: Set<string>; faultedThreads: Set<string>;
  retryAt: Map<string, {at: number; delay: number}>; lastTypingAt: Map<string, number>; working: ReturnType<typeof resolveWorking>;
  workingTimers: Map<string, {timer: ReturnType<typeof setInterval>; threadId: string; turnId: string}>;
  running: boolean; flushing: boolean; submitting: boolean; timer?: ReturnType<typeof setInterval>; typingTimer?: ReturnType<typeof setInterval>;
  constructor(config: ChatConfig, { codex, adapterFactory, log = console, store, usage = executeUsage }: {codex: CodexBridge; adapterFactory: ChatBridge['adapterFactory']; log?: Logger; store?: ChatStore; usage?: typeof executeUsage}) {
    this.config = validateConfig(config);
    this.log = log;
    this.usage = usage;
    this.commands = [];
    this.store = store || new ChatStore(resolve(config.dataDir, 'chat.sqlite'));
    this.attention = config.attention?.nerveConfig ? new AttentionClient(config.attention.nerveConfig,this.store,{log}) : null;
    if(this.store.cursor('bindings')) this.config.bindings=this.store.cursor<Binding[]>('bindings')!;
    this.config.bindings=[...this.config.bindings];
    for(const entry of Object.values(this.store.cursor<AutoBindings>('auto-bindings') || {})) {
      if(entry.state==='bound' && !this.config.bindings.some(b=>this.routeKey(b)===this.routeKey(entry.binding))) this.config.bindings.push(entry.binding);
    }
    validateConfig(this.config);
    this.bindingCreations=new Map();
    this.codex = codex;
    this.codex.getCursor = key => this.store.cursor(key);
    this.codex.setCursor = (key,value) => this.store.setCursor(key,value);
    this.adapterFactory = adapterFactory;
    this.adapters = new Map();
    this.items = new Map(this.store.cursor<[string, PublicItem][]>('public-items') || []);
    this.finalizedTurns = new Set(this.store.cursor<string[]>('finalized-turns') || []);
    this.active = new Set();
    this.faultedThreads = new Set();
    this.retryAt = new Map();
    this.lastTypingAt = new Map();
    this.working = resolveWorking(this.config.display?.working);
    this.workingTimers = new Map();
    this.running = false;
    this.flushing = false;
    this.submitting = false;
  }
  routeKey(binding: Pick<Binding, 'adapter' | 'chatId'>) { return JSON.stringify([binding.adapter, String(binding.chatId)]); }
  route(key: string) { return this.config.bindings.find(b => this.routeKey(b) === key); }
  attachmentRoots(threadId: string) {
    return [...(this.config.attachmentRoots || [this.config.dataDir]),
      resolve(this.config.codex?.codexHome || resolve(homedir(),'.codex'),'generated_images',threadId)];
  }
  async start() {
    this.running = true;
    const builtins=builtinCommands((name,context)=>this.builtinCommand(name,context));
    const directory=resolve(this.config.dataDir,this.config.commands?.directory || 'commands');
    this.commands=[...builtins,...await loadCommandExtensions({directory,reservedNames:COMMANDS.map(c=>c.name),log:this.log})];
    this.codex.onEvent = event => this.event(event);
    await this.codex.start();
    for (const config of this.config.adapters.filter(a => a.enabled !== false)) {
      const adapter = await this.adapterFactory(config, {
        dataDir: this.config.dataDir, log: this.log,
        getCursor: key => this.store.cursor(key),
        setCursor: (key,value) => this.store.setCursor(key,value),
        observeDiscord: this.attention ? record => this.attention!.observe(record) : undefined,
        commands: this.commands,
        isCommand: message => Boolean(parseCommandText(message.text,this.commands)),
        // An explicit route is a direct chat bridge.  Attention can suppress only
        // lazy Discord task creation, never a route the operator deliberately bound.
        isBound: message => Boolean(parseCommandText(message.text,this.commands)) ||
          this.config.bindings.some(b=>b.adapter===config.id && String(b.chatId)===String(message.chatId) && b.kind===message.kind) ||
          this.canAutoBind(config,message),
      });
      this.adapters.set(config.id, adapter);

    }
    for (const threadId of new Set(this.config.bindings.filter(b=>this.adapters.has(b.adapter)).map(b=>b.threadId))) await this.codex.watch?.(threadId);
    for (const config of this.config.adapters.filter(a => this.adapters.has(a.id))) {
      await this.adapters.get(config.id)!.start(message => this.receive(config,message));
      this.log.info('adapter started',{id:config.id,type:config.type});
    }
    this.timer = setInterval(() => {
      this.submit().catch(e=>this.log.error('submit failed', e));
      this.flush().catch(e=>this.log.error('delivery failed',e));
      this.attention?.flush().catch(e=>this.log.error('attention forwarding failed',e));
    }, 1000);
    this.typingTimer = setInterval(() => this.typing(), 1000);
    await this.submit();
  }
  async receive(config: AdapterConfig, message: ChatMessage) {
    if (!allowed(config,message,{command:Boolean(parseCommandText(message.text,this.commands))})) return;
    if(await this.command(config,message))return;
    let binding;
    try { binding=await this.ensureBinding(config,message); }
    catch(error) {
      this.log.warn('chat task creation was not confirmed',{adapter:config.id,chatId:message.chatId});
      const route=JSON.stringify([config.id,String(message.chatId)]);
      this.store.stage(stableId(route,message.id,'create-failure'),route,{text:'聊天任务创建未能确认，请在本机检查后再继续；不会自动重复创建。',target:{chatId:message.chatId,kind:message.kind,userId:message.userId,messageId:message.id},replyTo:message.id});
      return;
    }
    if (!binding) { this.log.warn('message ignored: chat has no explicit binding', {adapter:config.id,chatId:message.chatId}); return; }
    const admitted = this.store.admit(config.id,binding.threadId,message);
    this.store.setCursor(`reply:${this.routeKey(binding)}`,{messageId:message.id,userId:message.userId});
    if (admitted.fresh) {
      // A durable admission only confirms that Rin accepted the message. Give the
      // user one prompt typing hint, but wait for Codex to confirm actual work
      // before the periodic typing loop treats the thread as active.
      this.typing(binding.threadId);
      // Admission is durable before acknowledging a platform cursor. Submission runs separately.
      queueMicrotask(()=>this.submit().catch(e=>this.log.error('submit failed',e)));
    }
  }
  canAutoBind(config: AdapterConfig,message: ChatMessage) {
    return Boolean(config.autoBind && !(this.attention && config.type==='discord') &&
      !config.autoBind.excludedChatIds?.includes(String(message.chatId)));
  }
  async ensureBinding(config: AdapterConfig,message: ChatMessage) {
    const existing=this.config.bindings.find(b=>b.adapter===config.id && String(b.chatId)===String(message.chatId) && b.kind===message.kind);
    if(existing || !this.canAutoBind(config,message))return existing;
    const key=JSON.stringify([config.id,String(message.chatId)]);
    if(this.bindingCreations.has(key))return this.bindingCreations.get(key);
    const saved=this.store.cursor<AutoBindings>('auto-bindings') || {};
    if(saved[key])throw new Error('Previous task creation requires reconciliation');
    saved[key]={state:'creating'};this.store.setCursor('auto-bindings',saved);
    const pending=Promise.resolve().then(async()=>{
      try {
        let threadId;
        try { threadId=await this.codex.createThread({cwd:(config.autoBind as Exclude<AdapterConfig['autoBind'], false | undefined>).cwd,model:(config.autoBind as Exclude<AdapterConfig['autoBind'], false | undefined>).model,name:`${config.id} · ${message.chatName || String(message.chatId)}`}); }
        catch(error) { if(typeof failure(error).threadId==='string' && failure(error).threadId)threadId=failure(error).threadId;else throw error; }
        if(typeof threadId!=='string' || !threadId)throw new Error('Missing created task id');
        const binding={adapter:config.id,chatId:String(message.chatId),kind:message.kind,threadId,mirror:true};
        validateConfig({...this.config,bindings:[...this.config.bindings,binding]});
        const current=this.store.cursor<AutoBindings>('auto-bindings') || {};current[key]={state:'bound',binding};this.store.setCursor('auto-bindings',current);
        this.config.bindings.push(binding);
        await this.codex.watch?.(threadId);
        return binding;
      } catch(error) {
        const current=this.store.cursor<AutoBindings>('auto-bindings') || {};
        if(current[key]?.state!=='bound'){current[key]={state:'uncertain'};this.store.setCursor('auto-bindings',current);}
        throw error;
      } finally { this.bindingCreations.delete(key); }
    });
    this.bindingCreations.set(key,pending);
    return pending;
  }
  async builtinCommand(name: string,{args,message}: CommandContext) {
    if(name==='help')return {text:commandHelp(this.commands,message.kind==='dm')};
    if(name==='usage')return this.usage(args,{config:this.config.codex || {},dataDir:this.config.dataDir});
    throw new Error('Unknown built-in command');
  }
  async command(config: AdapterConfig,message: ChatMessage) {
    const parsed=parseCommandText(message.text,this.commands);
    if(!parsed)return false;
    // This was deliberately removed from the old catalog. It remains silent,
    // including in a private chat, rather than being submitted as a prompt.
    if(parsed.name==='session')return true;
    if(!parsed.registered || (parsed.target && message.commandTarget!=='self'))return this.unknownCommand(config,message);
    const command=this.commands.find(c=>c.name===parsed.name)!;
    // Admission is the only caller permission check. Claim before every handler.
    const key=`command:${stableId(config.id,message.chatId,message.id)}`;
    if(this.store.cursor(key))return true;
    this.store.setCursor(key,{state:'started'});
    let output;
    try {
      if(command.privateOnly && message.kind!=='dm')output={text:'请在私聊中使用此命令。'};
      else {
        const result=await command.run({args:parsed.args,message:{adapter:config.id,id:message.id,chatId:message.chatId,userId:message.userId,kind:message.kind,text:message.text},dataDir:this.config.dataDir});
        if(!result || typeof result!=='object' || (result.text!==undefined && typeof result.text!=='string') ||
          (result.fallbackText!==undefined && typeof result.fallbackText!=='string') ||
          (result.files!==undefined && (!Array.isArray(result.files) || result.files.some(file=>!file || typeof file.path!=='string' || (file.name!==undefined && typeof file.name!=='string') || (file.mimeType!==undefined && typeof file.mimeType!=='string')))) ||
          (!result.text && !result.files?.length))throw new Error('Invalid command result');
        output={text:result.text || '',...(result.fallbackText?{fallbackText:result.fallbackText}:{}),...(result.files?.length?{files:result.files.map(({path,name,mimeType})=>({path,...(name?{name}:{}),...(mimeType?{mimeType}:{})}))}:{})};
      }
    } catch {
      this.log.warn('command failed',{name:command.name});
      output={text:'命令未完成，请检查输入或稍后重试。'};
    }
    const target={chatId:message.chatId,kind:message.kind,userId:message.userId,messageId:message.id,
      ...(message.commandInteraction?{commandInteraction:{id:message.commandInteraction.id}}:{})};
    const chunks=['discord','telegram'].includes(config.type)
      ? prepareText(config.type,output.text || '',this.adapters.get(config.id)?.capabilities.maxText || 1900)
      : splitText(stripMarkdownFormatting(output.text || ''),1900).map(text=>({text}));
    // Native interaction replies are one private response; adapters retain the handle in memory.
    const parts=message.commandInteraction?[{text:output.text,...(output.fallbackText?{fallbackText:output.fallbackText}:{}),...(output.files?.length?{files:output.files}:{})}]
      : [...chunks,...(output.files?.length?[{files:output.files,...(output.fallbackText?{fallbackText:output.fallbackText}:{})}]:[])];
    for(const [index,part] of parts.entries())this.store.stage(stableId(key,index),JSON.stringify([config.id,String(message.chatId)]),{
      ...part,...(!message.commandInteraction && index===0?{replyTo:message.id}:{}),target});
    this.store.setCursor(key,{state:'done'});
    if(message.commandInteraction)await this.flush();
    return true;
  }
  unknownCommand(config: AdapterConfig,message: ChatMessage) {
    if(message.kind!=='dm')return true;
    const key=`unknown-command:${stableId(config.id,message.chatId,message.id)}`;
    if(this.store.cursor(key))return true;
    this.store.setCursor(key,{state:'started'});
    this.store.stage(stableId(key,0),JSON.stringify([config.id,String(message.chatId)]),{
      text:'Unknown command. Send /help to see available commands.',replyTo:message.id,
      target:{chatId:message.chatId,kind:message.kind,userId:message.userId,messageId:message.id},
    });
    this.store.setCursor(key,{state:'done'});
    return true;
  }

  async submit() {
    if (this.submitting || !this.running) return;
    this.submitting = true;
    try {
      for (const job of this.store.pending()) {
        if (!this.running) break;
        if(this.faultedThreads.has(job.thread)) continue;
        this.store.inboxState(job.id,'submitting');
        const message = JSON.parse(job.payload) as ChatMessage;
        try {
          const receipt = await this.codex.queue(job.thread,{text:message.text,files:message.files || []});
          const appIpc=receipt?.transport?.startsWith('app-ipc-');
          const state=receipt?.transport==='app-ipc-steer' ? 'steered' : appIpc ? 'delivered' : 'queued';
          this.store.inboxState(job.id,state,typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
          if(appIpc) {
            this.active.add(job.thread);
            if(receipt.turnId) for(const binding of this.config.bindings.filter(b=>b.threadId===job.thread && b.mirror===true && this.adapters.has(b.adapter))) {
              const [adapterId]=JSON.parse(job.id);
              const context=binding.adapter===adapterId && String(binding.chatId)===String(message.chatId)
                ? {messageId:message.id,userId:message.userId}
                : this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {};
              this.stageWorkingMarker(binding,receipt.turnId,context);
            }
          }
          this.log.info('message submitted', {threadId:job.thread,transport:receipt?.transport || 'native-queue'});
        } catch (error) {
          // A lost CLI response may follow a successful submission. Do not replay it automatically.
          this.store.inboxState(job.id,'uncertain',null,'Codex submission failed; inspect redacted service log');
          const [adapterId] = JSON.parse(job.id);
          const binding=this.config.bindings.find(b=>b.adapter===adapterId && String(b.chatId)===String(message.chatId) && b.kind===message.kind);
          if(binding) {
            const unsupported=failure(error)?.code==='CODEX_INPUT_UNSUPPORTED' || failure(error)?.cause?.code==='CODEX_INPUT_UNSUPPORTED';
            const text=unsupported
              ? '暂不支持发送附件，请先发送文字消息。'
              : '消息投递未确认。为避免重复，我不会自动重发。';
            this.store.stage(stableId('submission-error',job.id),this.routeKey(binding),{
              text,replyTo:message.id,
              target:{chatId:message.chatId,kind:message.kind,userId:message.userId,messageId:message.id},
            });
          }
          this.log.error('message submission uncertain; inspect before retry',error);
        }
      }
    } finally { this.submitting = false; }
  }
  event(event: CodexEvent) {
    if (!event.threadId) return;
    if(event.type==='observerError') {this.log.error('Codex observer stopped',event.error || event.text || 'unsupported history');this.stopWorkingRotation(event.threadId);this.active.delete(event.threadId);this.faultedThreads.add(event.threadId);return;}
    const bindings = this.config.bindings.filter(b=>b.threadId===event.threadId && this.adapters.has(b.adapter) && b.mirror === true);
    if (!bindings.length) return;
    if (event.type === 'image' && event.itemId && event.turnId && typeof event.path === 'string') {
      // Only the App's completed image artifact for this task is eligible;
      // generic tool outputs and artifacts belonging to other tasks stay private.
      const root=resolve(this.config.codex?.codexHome || resolve(homedir(),'.codex'),'generated_images',event.threadId);
      const files=outputFiles(`[image](${encodeURIComponent(event.path)})`,[root]).filter(file=>file.mimeType?.startsWith('image/'));
      if (!files.length) { this.log.error('Generated image cannot be delivered: missing file or invalid task artifact path'); return; }
      for (const binding of bindings) {
        const context=this.store.cursor<Partial<ChatTarget>>(`turn-reply:${this.routeKey(binding)}:${event.turnId}`) || this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {};
        const type=this.config.adapters.find(a=>a.id===binding.adapter)?.type || '';
        this.store.stage(stableId(this.routeKey(binding),event.turnId,event.itemId,'generated-image'),this.routeKey(binding),{
          files,...(context.messageId?{replyTo:context.messageId}:{}),
          ...(type==='qqbot'?{target:{chatId:binding.chatId,kind:binding.kind,...context}}:{}),
        });
      }
      return;
    }
    if (event.type === 'started') {
      this.active.add(event.threadId);
      this.typing(event.threadId);
      for(const binding of bindings) {
        const key=`turn-reply:${this.routeKey(binding)}:${event.turnId}`;
        if(this.store.cursor(key)===undefined)this.store.setCursor(key,this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {});
        if(this.adapters.get(binding.adapter)!.capabilities.edit) {
          this.stageText(binding,{threadId:event.threadId,turnId:event.turnId,itemId:'progress',phase:'working',text:workingFrame(this.working)},false);
          this.startWorkingRotation(binding,event.threadId,event.turnId);
        }
        else this.stageWorkingMarker(binding,event.turnId,this.store.cursor<Partial<ChatTarget>>(key) || {});
      }
    }
    if (event.type === 'text') {
      if(event.phase==='question') {
        if(event.text && event.itemId)for(const binding of bindings)this.stageText(binding,{...event,itemId:event.itemId!,text:event.text!,phase:event.phase!},true);
        return;
      }
      if(!event.phase)event={...event,phase:'final'};
      if(event.phase==='summary' || event.phase==='reasoning_summary')event={...event,text:normalizeAssistantSummaryText(event.text)};
      if(event.phase==='final_answer') event={...event,phase:'final'};
      if(event.phase==='reasoning_summary') event={...event,phase:'summary'};
      if (!['commentary','final','summary'].includes(event.phase || 'final')) return;
      if (event.phase==='summary' && this.config.display?.summaries === false) return;
      const turnKey=JSON.stringify([event.threadId,event.turnId]);
      if(event.phase !== 'final' && this.finalizedTurns.has(turnKey))return;
      if(event.phase === 'final') {
        this.stopWorkingRotation(event.threadId,event.turnId);
        this.finalizedTurns.add(turnKey);
        this.store.setCursor('finalized-turns',[...this.finalizedTurns]);
      }
      if(event.phase==='summary' && !event.text)return;
      const itemId = event.itemId || event.turnId;
      if (!itemId) return;
      const key = JSON.stringify([event.threadId,event.turnId,itemId]);
      const old = this.items.get(key) || {text:'',phase:event.phase || 'final',turnId:event.turnId,threadId:event.threadId,itemId};
      old.phase = event.phase || 'final';
      old.text = event.delta !== undefined ? old.text+event.delta : (event.text ?? old.text);
      // A subsequent public item closes the preceding message on transports without edits.
      if(!this.items.has(key)) for(const previous of this.items.values()) {
        if(previous.threadId===event.threadId && previous.turnId===event.turnId)
          for(const binding of bindings) if(!this.adapters.get(binding.adapter)!.capabilities.edit) this.stageText(binding,previous,true);
      }
      this.items.set(key,old);
      this.store.setCursor('public-items',[...this.items]);
      for (const binding of bindings) this.stageText(binding,old,event.done === true || event.delta === undefined);
    }
    if (event.type === 'completed' || event.type === 'failed') {
      this.stopWorkingRotation(event.threadId,event.turnId);
      for (const [key,item] of this.items) {
        if (item.threadId !== event.threadId || (event.turnId && item.turnId !== event.turnId)) continue;
        for (const binding of bindings) this.stageText(binding,item,true);
      }
      for(const [key,item] of this.items) if(item.threadId===event.threadId && (!event.turnId || item.turnId===event.turnId))this.items.delete(key);
      if (event.type === 'failed') {
        for (const binding of bindings) this.store.stage(stableId(this.routeKey(binding),event.turnId,'failure'),this.routeKey(binding),{text:'本轮执行未完成，请在 Codex 中查看错误后继续。'});
      }
      this.store.setCursor('public-items',[...this.items]);
      this.active.delete(event.threadId);
    }
  }
  stageWorkingMarker(binding: Binding,turnId: string,context: Partial<ChatTarget>) {
    const adapter=this.adapters.get(binding.adapter);
    if(!adapter || adapter.capabilities.edit || adapter.capabilities.reaction) return;
    if(this.finalizedTurns.has(JSON.stringify([binding.threadId,turnId])))return;
    const route=this.routeKey(binding);
    this.store.stage(stableId(route,turnId,context.messageId || 'chat','working-marker'),route,{
      text:workingFrame(this.working),
      ...(context.messageId?{replyTo:context.messageId}:{}),
      target:{chatId:binding.chatId,kind:binding.kind,...context},
    });
  }

  stageText(binding: Binding,item: PublicItem,done: boolean) {
    const adapter = this.adapters.get(binding.adapter)!;
    if (!adapter.capabilities.edit && !done) return;
    const type=this.config.adapters.find(a=>a.id===binding.adapter)?.type || '';
    const replyKey=`turn-reply:${this.routeKey(binding)}:${item.turnId}`;
    if(this.store.cursor(replyKey)===undefined)this.store.setCursor(replyKey,this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {});
    const replyContext=this.store.cursor<Partial<ChatTarget>>(replyKey) || {};
    const replyTo=replyContext.messageId;
    const targetContext=type==='qqbot' ? {target:{chatId:binding.chatId,kind:binding.kind,...replyContext}} : {};
    const progressScope=type==='telegram' ? 'chat' : (replyTo ? `quote:${replyTo}` : 'chat');
    const baseProgressGroup=stableId(this.routeKey(binding),'progress',progressScope);
    const segmentKey=`progress-segments:${this.routeKey(binding)}:${item.turnId}`;
    const segments=this.store.cursor<Segments>(segmentKey) || {current:0,questions:[],items:{},groups:[]};
    let progressGroup=segments.current===0 ? baseProgressGroup : stableId(baseProgressGroup,item.turnId,'segment',segments.current);
    if(adapter.capabilities.edit && item.phase==='question' && !segments.questions.includes(item.itemId)) {
      // Questions remain in the timeline. Later progress must appear below them.
      segments.questions.push(item.itemId);
      segments.current++;
      this.store.setCursor(segmentKey,segments);
    }
    if(adapter.capabilities.edit && item.phase!=='question') {
      if(item.phase==='final') {
        for(const group of new Set([baseProgressGroup,...segments.groups])) {
          this.store.retire(group,[]);
          this.store.setCursor(`progress-sections:${group}`,{});
        }
        // Clear the same turn's progress created by the initial turn-keyed deployment.
        this.store.retire(stableId(this.routeKey(binding),item.turnId,'progress'),[]);
        this.store.setCursor(`progress-sections:${progressGroup}`,{});
      } else {
        if(this.finalizedTurns.has(JSON.stringify([item.threadId,item.turnId])))return;
        const itemSegment=segments.items[item.itemId];
        // Working frames always belong to the current progress segment. Public
        // items retain their original segment when history is replayed.
        if(item.phase!=='working' && itemSegment!==undefined && itemSegment!==segments.current)return;
        if(item.phase!=='working')segments.items[item.itemId]=segments.current;
        if(!segments.groups.includes(progressGroup))segments.groups.push(progressGroup);
        this.store.setCursor(segmentKey,segments);
        const sections=this.store.cursor<Record<string,string>>(`progress-sections:${progressGroup}`) || {};
        if(item.phase==='working')sections.working=item.text || workingFrame(this.working);
        else sections[item.phase]=item.text;
        this.store.setCursor(`progress-sections:${progressGroup}`,sections);
        item={...item,itemId:'progress',text:composeEditableMessageText({
          workingTextChunks:[editableIntermediateHeadText(sections.summary || sections.working || workingFrame(this.working))],
          contentTextChunks:sections.commentary ? [sections.commentary] : [],
          todoTextChunks:sections.todo ? [sections.todo] : [],
        })};
      }
    }
    if(item.phase==='final' || item.phase==='question' || (!adapter.capabilities.edit && done)) {
      const group=stableId(this.routeKey(binding),item.turnId,item.itemId,...(!adapter.capabilities.edit ? [item.text] : []));
      const liveIds=[];
      let first=true;
      const parts=outputParts(item.text,this.attachmentRoots(item.threadId));
      for(const [index,part] of parts.entries()) {
        if(part.text && !adapter.capabilities.edit && !['final','question'].includes(item.phase))part.text=editableIntermediateHeadText(part.text);
        if(part.text && ['qqbot','onebot'].includes(type))part.text=stripMarkdownFormatting(part.text);
        const outputs: ChatOutput[]=part.files ? [part] : ['discord','telegram'].includes(type)
          ? prepareText(type,part.text,adapter.capabilities.maxText || 1900)
          : splitText(part.text,adapter.capabilities.maxText || 1900).map(text=>({text}));
        for(const [chunk,output] of outputs.entries()) {
          const id=stableId(group,'part',index,chunk,output.files?.[0]?.path || 'text');
          liveIds.push(id);
          this.store.stage(id,this.routeKey(binding),{...output,...targetContext,...(first && replyTo?{replyTo}:{})},group);
          first=false;
        }
      }
      if(adapter.capabilities.edit && typeof adapter.delete==='function')this.store.retire(group,liveIds);
      return;
    }
    const progress=adapter.capabilities.edit && item.itemId==='progress';
    const sourceText=!adapter.capabilities.edit && ['commentary','summary'].includes(item.phase) ? editableIntermediateHeadText(item.text) : item.text;
    const chunks = ['discord','telegram'].includes(type)
      ? prepareText(type,sourceText,adapter.capabilities.maxText || 1900)
      : splitText(sourceText,adapter.capabilities.maxText || 1900).map(text=>({text}));
    const group=progress ? progressGroup : stableId(this.routeKey(binding),item.turnId,item.itemId);
    const liveIds=[];
    for (let i=0;i<chunks.length;i++) {
      const id=progress ? stableId(group,i) : stableId(this.routeKey(binding),item.turnId,item.itemId,i);liveIds.push(id);
      this.store.stage(id,this.routeKey(binding),{...chunks[i],...targetContext,...(progress?{progress:true}:{}),...(i===0 && replyTo ? {replyTo} : {})},group);
    }
    if(typeof adapter.delete==='function')this.store.retire(group,liveIds);
    if(done) for(const file of outputFiles(item.text,this.attachmentRoots(item.threadId))) {
      this.store.stage(stableId(this.routeKey(binding),item.turnId,item.itemId,'file',file.path),this.routeKey(binding),{files:[file]});
    }
  }
  startWorkingRotation(binding: Binding,threadId: string,turnId: string) {
    const key=JSON.stringify([this.routeKey(binding),turnId]);
    if(this.workingTimers.has(key) || this.working.frames.length<2)return;
    let index=0;
    const timer=setInterval(()=>{
      if(!this.running || !this.active.has(threadId) || this.finalizedTurns.has(JSON.stringify([threadId,turnId])))return this.stopWorkingRotation(threadId,turnId);
      index=(index+1)%this.working.frames.length;
      this.stageText(binding,{threadId,turnId,itemId:'progress',phase:'working',text:workingFrame(this.working,index)},false);
      this.flush().catch(error=>this.log.error('working status delivery failed',error));
    },this.working.intervalMs);
    timer.unref?.();
    this.workingTimers.set(key,{timer,threadId,turnId});
  }
  stopWorkingRotation(threadId: string,turnId?: string) {
    for(const [key,state] of this.workingTimers) {
      if(state.threadId!==threadId || (turnId && state.turnId!==turnId))continue;
      clearInterval(state.timer);this.workingTimers.delete(key);
    }
  }
  async flush() {
    if (this.flushing || !this.running) return;
    this.flushing = true;
    try {
      for (const item of this.store.outgoing()) {
        if (!this.running) break;
        if((this.retryAt.get(item.id)?.at || 0)>Date.now())continue;
        const payload = JSON.parse(item.payload) as ChatOutput;
        const route = this.route(item.route) || (payload.target && {...payload.target,adapter:JSON.parse(item.route)[0]}); const adapter = this.adapters.get(route?.adapter || '');
        if (!adapter || !route) continue;
        this.store.sending(item.id);
        const target = {...route,...this.store.cursor<Partial<ChatTarget>>(`reply:${item.route}`),...payload.target};
        try {
          if(payload.delete) {if(item.message_id)await adapter.delete?.(target,item.message_id);this.store.sent(item.id,item.payload,null);continue;}
          const sent = await adapter.send(target,{...payload,...(item.message_id && adapter.capabilities.edit ? {editId:item.message_id} : {})});
          this.store.sent(item.id,item.payload,sent.id);
          this.retryAt.delete(item.id);
          if(payload.progress && route && 'threadId' in route && typeof route.threadId === 'string')this.typing(route.threadId);
        } catch (error) {
          if(payload.files?.length && payload.fallbackText && failure(error)?.fallbackSafe===true) {
            try {
              const fallback=await adapter.send(target,{text:payload.fallbackText,...(payload.replyTo?{replyTo:payload.replyTo}:{})});
              this.store.sent(item.id,item.payload,fallback.id);this.retryAt.delete(item.id);continue;
            } catch(fallbackError) { error=fallbackError; }
          }
          // Editing an identified message is safe to retry; a first send with unknown outcome isn't.
          this.store.failed(item.id,'Platform delivery failed; inspect redacted service log',Boolean(item.message_id) && failure(error)?.deliveryUncertain !== true);
          const delay=Math.min(30000,(this.retryAt.get(item.id)?.delay || 500)*2);
          this.retryAt.set(item.id,{delay,at:Date.now()+delay});
          this.log.error('outbound delivery failed',error);
        }
      }
    } finally { this.flushing = false; }
  }
  typing(threadId?: string) {
    for (const b of this.config.bindings) {
      if (threadId ? b.threadId !== threadId : !this.active.has(b.threadId)) continue;
      const a = this.adapters.get(b.adapter);
      const config=this.config.adapters.find(a=>a.id===b.adapter);
      const now=Date.now();
      const interval=config?.type==='telegram'?4000:config?.type==='discord'?9000:30000;
      if(!threadId && now-(this.lastTypingAt.get(this.routeKey(b)) || 0)<interval)continue;
      this.lastTypingAt.set(this.routeKey(b),now);
      if (a?.capabilities.typing && !(config?.type==='qqbot' && b.kind==='group')) a.typing({...b,...this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(b)}`)}).catch(e=>this.log.warn('typing failed',e));
    }
  }
  async stop() {
    this.running = false; clearInterval(this.timer); clearInterval(this.typingTimer);
    for(const {timer} of this.workingTimers.values())clearInterval(timer);
    this.workingTimers.clear();
    this.attention?.stop();
    await Promise.allSettled([...this.adapters.values()].map(a=>a.stop()));
    await this.codex.stop();
    const deadline = Date.now()+15000;
    while ((this.flushing || this.submitting || this.attention?.busy || this.bindingCreations.size) && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    if (!this.flushing && !this.submitting && !this.attention?.busy && !this.bindingCreations.size) this.store.close();
  }
}
