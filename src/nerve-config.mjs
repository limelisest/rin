// Pure configuration validation shared by installation and runtime.
// Importing this module must not load SQLite or start runtime components.
export function validateConfig(config) {
  if (!config.targets || typeof config.targets !== 'object') throw new Error('targets required');
  for (const [name,target] of Object.entries(config.targets)) {
    if (!['command','http','codex','codex-app'].includes(target.type)) throw new Error(`Unknown target type: ${name}`);
    if (target.type === 'command' && (!Array.isArray(target.argv) || !target.argv.length)) throw new Error(`argv required: ${name}`);
    if (target.type === 'http' && !/^https?:\/\//.test(target.url || '')) throw new Error(`Invalid URL: ${name}`);
    if(['codex','codex-app'].includes(target.type)) {
      if(typeof target.threadId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.threadId))throw new Error('Codex target requires an existing threadId; migrate the old stateFile explicitly');
      if(target.stateFile!==undefined)throw new Error('Use the existing threadId instead of legacy stateFile');
      if(target.idempotent===true)throw new Error('Codex execution is not idempotent; automatic retries are forbidden');
      if(target.command!==undefined && (!Array.isArray(target.command) || !target.command.length || target.command.some(part=>typeof part!=='string'||!part)))throw new Error('Invalid Codex command argv');
    }
    if (target.timeoutMs !== undefined && (!Number.isFinite(target.timeoutMs) || target.timeoutMs <= 0)) throw new Error('Invalid timeout');
  }
  if(Object.values(config.targets).filter(t=>['codex','codex-app'].includes(t.type)).length>1)throw new Error('Only one Codex session target is supported');
  if (config.minecraft !== undefined) {
    const mc = config.minecraft;
    if (!mc || typeof mc !== 'object' || typeof mc.endpoint !== 'string' || typeof mc.stateFile !== 'string' || typeof mc.tokenEnv !== 'string' || !mc.tokenEnv || mc.tokenEnv === 'NERVE_TOKEN' || !config.targets[mc.target] || !['codex','codex-app'].includes(config.targets[mc.target].type)) throw new Error('Minecraft transport must target the configured Codex persona');
    if (!mc.source || typeof mc.source !== 'object' || typeof mc.source.serverId !== 'string' || !mc.source.serverId || typeof mc.source.playerUuid !== 'string' || typeof mc.source.maidUuid !== 'string') throw new Error('Minecraft source lock is required');
  }
  const ids = new Set();
  for (const t of config.triggers || []) {
    if (typeof t.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(t.id) || ids.has(t.id)) throw new Error('Trigger ids must be unique');
    ids.add(t.id);
    if(t.check!==undefined && (!Array.isArray(t.check) || !t.check.length || t.check.some(x=>typeof x!=='string')))throw new Error('Invalid check argv');
    if(t.enabled!==undefined && typeof t.enabled!=='boolean')throw new Error('Invalid enabled flag');
    if (!config.targets[t.target]) throw new Error(`Unknown trigger target: ${t.target}`);
    if ([t.everySeconds,t.at,t.daily].filter(x=>x !== undefined).length !== 1) throw new Error('Exactly one schedule per trigger');
    if (t.everySeconds !== undefined && (!Number.isFinite(t.everySeconds) || t.everySeconds < 1)) throw new Error('Invalid interval');
    if (t.at && !Number.isFinite(Date.parse(t.at))) throw new Error('Invalid timestamp');
    if (t.daily && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.daily)) throw new Error('Invalid daily time');
    if (t.timeZone) new Intl.DateTimeFormat('en',{timeZone:t.timeZone});
  }
}
