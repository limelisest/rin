import { spawn } from 'node:child_process';

// A short-lived creation transport. Existing threads remain owned by the App;
// this client never submits a turn or retries a thread/start mutation.
export function createCodexThread({ command, codexHome, timeoutMs, children, cwd, model, name }) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NERVE_|PI_|RIN_DIR$)/i.test(key)));
    if (codexHome) env.CODEX_HOME = codexHome;
    const child = spawn(command[0], [...command.slice(1), 'app-server', '--stdio'], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let buffer = '', nextId = 1, settled = false, closed = false, creationSent = false, threadId;
    let pending;
    const closeWaiters = [];
    const close = () => new Promise(done => {
      if (closed) return done();
      const terminate = setTimeout(() => child.kill('SIGTERM'), 250);
      const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
      closeWaiters.push(() => { clearTimeout(terminate); clearTimeout(force); done(); });
      child.stdin.end();
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        error.code = creationSent ? 'CODEX_THREAD_CREATE_UNCERTAIN' : 'CODEX_THREAD_CREATE_FAILED';
        if (threadId) error.threadId = threadId;
        else if (creationSent) error.message += '; thread creation outcome uncertain';
      }
      void close().then(() => error ? reject(error) : resolve(value));
    };
    const timer = setTimeout(() => finish(new Error('Codex thread creation timed out')), timeoutMs);
    const request = (method, params) => new Promise((accept, decline) => {
      if (settled) return decline(new Error('Codex thread creation connection closed'));
      const id = nextId++;
      pending = { id, accept, decline };
      if (method === 'thread/start') creationSent = true;
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => finish(new Error('Codex thread creation input failed')));
    child.stdout.on('error', () => finish(new Error('Codex thread creation output failed')));
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      closed = true;
      children.delete(child);
      for (const done of closeWaiters) done();
      finish(new Error(`Codex thread creation connection closed (${signal || code})`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Codex thread creation response too large'));
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (settled) break;
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { finish(new Error('Invalid Codex thread creation response')); break; }
        if (!message || typeof message !== 'object') {
          finish(new Error('Invalid Codex thread creation response')); break;
        }
        if (!pending || message.id !== pending.id || message.method) continue;
        const entry = pending;
        pending = undefined;
        if (message.error) entry.decline(new Error(message.error.message || 'Codex thread creation rejected'));
        else entry.accept(message.result);
      }
    });
    void (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'rin-chat', title: 'Rin chat', version: '1' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        if (settled) return;
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        const result = await request('thread/start', { cwd, ...(model ? { model } : {}), ephemeral: false });
        if (typeof result?.thread?.id !== 'string' || !result.thread.id.trim()) {
          throw new Error('Codex thread creation returned no thread ID');
        }
        threadId = result.thread.id;
        if (name) await request('thread/name/set', { threadId, name });
        finish(null, threadId);
      } catch (error) { finish(error); }
    })();
  });
}
