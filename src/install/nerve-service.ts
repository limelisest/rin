import type {ManagedService} from './types.js';
import type {NerveMcpResult} from './nerve.js';
export interface ActivationOptions {home: string;service: ManagedService;nerve?: NerveMcpResult;healthy?: typeof nerveHealthy}
import {readFile,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';

export async function nerveHealthy(configPath: string) {
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const secrets=JSON.parse(await readFile(join(dirname(configPath),'secrets.json'),'utf8'));
  try {
    const response=await fetch(`http://127.0.0.1:${config.port ?? 9761}/health`,{
      headers:{authorization:`Bearer ${secrets.NERVE_TOKEN}`},
      redirect:'error',signal:AbortSignal.timeout(5000),
    });
    return response.ok && (await response.json()).ok===true;
  } catch { return false; }
}

// Only activate newly added background work. A configured service that the user
// stopped remains stopped. The marker survives failures so update can retry.
export async function activateNerveMcp({home,service,nerve,healthy=nerveHealthy}: ActivationOptions) {
  if (!nerve?.needsActivation) return;
  const running=await service.isRunning();
  if (!running || !await healthy(nerve.configPath)) {
    if (running) await service.stop();
    await service.start();
  }
  if (!await healthy(nerve.configPath)) throw new Error('Nerve MCP is registered, but its local service is not healthy. Inspect the Rin service log and retry rin update.');
  await rm(join(home,'private/nerve-setup-pending.json'),{force:true});
}
