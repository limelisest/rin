import type { MessageInput } from './runtime-types.js';
import { CodexAppIpc } from './codex-app-ipc.js';
import { wakeCodexApp } from './codex-app-wake.js';
import { CodexQueue } from './codex-queue.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CodexInputOptions { command?:string[]; codexHome?:string; queueTimeoutMs?:number; appSteering?:boolean; appWake?:boolean; wakeApp?:(threadId:string)=>Promise<unknown> }

/** Submit to the current Codex owner. No thread creation, history mirror, or turn lifecycle. */
export class CodexInput extends CodexQueue {
  appIpc:CodexAppIpc|null; wakeApp:CodexInputOptions['wakeApp']|null; wakeTimeoutMs:number;
  constructor({command=['codex'],codexHome=join(homedir(),'.codex'),queueTimeoutMs=30_000,appSteering=false,appWake=false,wakeApp=wakeCodexApp}:CodexInputOptions={}) {
    super({command,codexHome,queueTimeoutMs});
    if(typeof appSteering!=='boolean')throw new Error('appSteering must be boolean');
    if(typeof appWake!=='boolean'||typeof wakeApp!=='function')throw new Error('Invalid App wake configuration');
    if(appWake&&!appSteering)throw new Error('appWake requires appSteering');
    this.appIpc=appSteering?new CodexAppIpc({codexHome:this.codexHome,timeoutMs:queueTimeoutMs}):null;
    this.wakeApp=appWake?wakeApp:null;
    this.wakeTimeoutMs=queueTimeoutMs;
  }
  async queue(threadId: string, input: MessageInput = {}): Promise<{threadId: string; messageId: string; turnId?: string; transport?: string}> {
    if (!this.started) throw new Error('CodexBridge not started');
    const files = input.files || [];
    if (!Array.isArray(files)) throw new Error('files must be an array');
    if (this.appIpc) {
      let context = this.threadContext(threadId);
      if (!context && this.wakeApp) throw new Error('Codex task context unavailable; message was not queued');
      if (context) {
        const receipt = await this.appIpc.steer(threadId, {
          text: input.text, files, cwd: context.cwd, start: !context.active, onClientMessageId: input.onClientMessageId,
        });
        if (receipt) return receipt;
        if (this.wakeApp) {
          await this.wakeApp(threadId);
          const deadline = Date.now() + this.wakeTimeoutMs;
          while (this.started && Date.now() < deadline) {
            // Loading can change the active turn. Re-read before each submission.
            context = this.threadContext(threadId);
            if (!context) throw new Error('Codex task unavailable after App wake');
            const resumed = await this.appIpc.steer(threadId, {
              text: input.text, files, cwd: context.cwd, start: !context.active, onClientMessageId: input.onClientMessageId,
            });
            if (resumed) return resumed;
            // null means no business input was sent. Errors, including ambiguous
            // receipts, propagate without replay or a second queue submission.
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          throw new Error('Codex App did not load the task before wake timed out; message was not queued');
        }
      }
    }
    return super.queue(threadId, input);
  }

  activeThread(threadId: string) {
    const context = this.threadContext(threadId);
    return context?.active ? {cwd:context.cwd} : null;
  }

  threadContext(threadId: string) {
    let state, history;
    try {
      state = new DatabaseSync(join(this.codexHome!, 'state_5.sqlite'), { readOnly: true });
      const metadata = state.prepare('SELECT cwd,cli_version,history_mode FROM threads WHERE id=?').get(threadId);
      if (!metadata || !/^0\.153\./.test(String(metadata.cli_version)) || metadata.history_mode !== 'paginated' || !metadata.cwd) return null;
      history = new DatabaseSync(join(this.codexHome!, 'thread_history_1.sqlite'), { readOnly: true });
      const turn = history.prepare('SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(threadId);
      return { cwd: String(metadata.cwd), active: turn?.status === 'inProgress' };
    } catch { return null; }
    finally { history?.close(); state?.close(); }
  }

  async stop() {
    await this.appIpc?.stop();
    await super.stop();
  }
}
