import type {AppEvent, ExecOptions, ExecResult} from './runtime-types.js';
interface BridgeContract { start():Promise<unknown>; stop():Promise<unknown>; watch(id:string):()=>void; queue(id:string,input:{text:string}):Promise<{turnId?:string;transport?:string}>; activeThread(id:string):unknown }
interface AppExecOptions extends ExecOptions {bridgeFactory?:(options:ExecOptions & {appSteering:boolean;appWake:boolean;onEvent:(event:AppEvent)=>void})=>BridgeContract}
import { CodexBridge } from './chat/codex.js';

function uncertain(reason: string, cause?: unknown) {
  const details = cause instanceof Error
    ? `; cause=${cause.name}${typeof (cause as NodeJS.ErrnoException).code === 'string' ? ` [${(cause as NodeJS.ErrnoException).code}]` : ''}: ${cause.message.slice(0,1024)}`
    : '';
  const error: NodeJS.ErrnoException = new Error(`Codex App ${reason}${details}; outcome uncertain, do not replay automatically`);
  error.code = 'CODEX_APP_UNCERTAIN';
  if (cause instanceof Error) {
    const causeCode = typeof (cause as NodeJS.ErrnoException).code === 'string' ? ` [${(cause as NodeJS.ErrnoException).code}]` : '';
    error.cause = new Error(`${cause.name}${causeCode}: ${cause.message.slice(0,1024)}`);
  }
  return error;
}

/** Deliver to the existing App owner and wait for the exact acknowledged turn. */
export class CodexAppExec {
 declare timeoutMs:number; declare stopped:boolean; declare pending:Set<{cancel:()=>void;onEvent:(event:AppEvent)=>void}>; declare submissions:Promise<void>; declare unsubscribe:(()=>void)|null; declare threadId:string|null; declare bridge:BridgeContract;
  constructor({ timeoutMs = 1_800_000, bridgeFactory = options => new CodexBridge(options), ...options }: AppExecOptions = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('positive timeoutMs required');
    this.timeoutMs = timeoutMs;
    this.stopped = false;
    this.pending = new Set();
    this.submissions = Promise.resolve();
    this.unsubscribe = null;
    this.threadId = null;
    this.bridge = bridgeFactory({ ...options, appSteering: true, appWake: true, onEvent: (event:AppEvent) => { for (const pending of [...this.pending]) pending.onEvent(event); } });
  }

  async run(threadId:string, { text }: {text?:string} = {}) {
    if (this.stopped) throw new Error('CodexAppExec stopped');
    if (this.pending.size >= 16) throw new Error('CodexAppExec in-flight limit reached');
    if (this.threadId && this.threadId !== threadId) throw new Error('CodexAppExec supports one session');
    if (typeof threadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('existing thread UUID required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
    this.threadId = threadId;
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false, turnId: string | undefined, stage = 'start';
      const observed = new Map<string,{text?:string;terminal?:string}>();
      const finish = (error:Error|null, result?:ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(active);
        if (!this.pending.size) { this.unsubscribe?.(); this.unsubscribe = null; }
        if (error) reject(error); else resolve(result!);
      };
      const check = () => {
        if (!turnId) return;
        const state = observed.get(turnId);
        if (state?.terminal === 'completed') finish(null, { threadId, turnId, completed: true, text: state.text || '' });
        else if (state?.terminal === 'failed') finish(uncertain('turn failed or was interrupted'));
      };
      const active = {
        cancel: () => finish(uncertain('observe stopped')),
        onEvent: (event:AppEvent) => {
          if (settled || event.threadId !== threadId) return;
          if (event.type === 'observerError') return finish(uncertain('observe failed', new Error(String((event as AppEvent & {error?: unknown}).error || event.text || 'history observer failed'))));
          if (!event.turnId || (turnId && event.turnId !== turnId)) return;
          if (!['completed', 'failed', 'text'].includes(event.type)) return;
          // A turn can finish while IPC is still returning its receipt. Keep a
          // bounded provisional record, then match only the receipt's turn ID.
          if (!observed.has(event.turnId) && observed.size >= 128) return finish(uncertain('observer event limit exceeded'));
          const state = observed.get(event.turnId) || {};
          if (event.type === 'text' && ['final', 'final_answer'].includes(event.phase || '')) state.text = String(event.text || '').slice(-65536);
          if (['completed', 'failed'].includes(event.type)) state.terminal = event.type;
          observed.set(event.turnId, state);
          check();
        },
      };
      this.pending.add(active);
      const timer = setTimeout(() => finish(uncertain('completion timed out')), this.timeoutMs);
      this.submissions = this.submissions.then(async () => {
        try {
          if (settled || this.stopped) return;
          stage = 'start';
          await this.bridge.start();
          if (settled || this.stopped) return;
          stage = 'watch';
          this.unsubscribe ||= this.bridge.watch(threadId);
          if (settled) return;
          stage = 'queue';
          const receipt = await this.bridge.queue(threadId, { text });
          if (settled) return;
          if (!receipt?.turnId || !['app-ipc-start', 'app-ipc-steer'].includes(receipt.transport || '')) {
            finish(uncertain('delivery did not identify an App turn'));
            return;
          }
          stage = 'receipt';
          turnId = receipt.turnId;
          check();
        } catch (error) { finish(uncertain(`${stage} failed`, error)); }
      });
    });
  }

  async stop() {
    this.stopped = true;
    for (const pending of [...this.pending]) pending.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.bridge.stop();
  }
}
