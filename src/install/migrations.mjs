import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateAgentsInstructions} from './instructions.mjs';
import {removeObsoleteCodexSettings,migrateContextManagementConfig} from './profile.mjs';
import {exists,readInstall} from './core.mjs';
import {ensureNerveMcp} from './nerve.mjs';
import {activateNerveMcp} from './nerve-service.mjs';
import {createService} from './service.mjs';
import {writeNerveLauncher} from './setup.mjs';

// Older updaters pass only Codex options. Infer the installation from the
// verified candidate location so their very first upgrade repairs MCP too.
export function migrationHome(moduleUrl=import.meta.url) {
  const release=resolve(dirname(fileURLToPath(moduleUrl)),'../..');
  return /^[a-f0-9]{40}$/.test(basename(release)) && basename(dirname(release))==='releases'
    ? dirname(dirname(release)) : undefined;
}

export async function runUpdateMigrations({home=migrationHome(),codexHome, command, writeConfig, readConfig, binary, resolveCommand, service, deferActivation=false, ensureMcp=ensureNerveMcp, activateMcp=activateNerveMcp} = {}) {
  const agentsChanged = await migrateAgentsInstructions(join(codexHome, 'AGENTS.md'));
  const config = await removeObsoleteCodexSettings({codexHome,command,writeConfig,binary,resolveCommand});
  const context = await migrateContextManagementConfig({codexHome,command,writeConfig,readConfig,binary,resolveCommand});
  const result={agentsChanged,obsoleteConfigRemoved:config.status!=='unchanged',contextManagementMigrated:context.status!=='unchanged'};
  if (home) {
    const state=await readInstall(home);
    if (!await exists(join(home,'nerve-mcp-run.mjs'))) await writeNerveLauncher(home);
    const nerve=await ensureMcp({home,codexHome,command,binary,writeConfig,node:state.node});
    result.nerve=nerve;
    if (!deferActivation) await activateMcp({home,nerve,service:service || createService({home,node:state.node})});
  }
  return result;
}
