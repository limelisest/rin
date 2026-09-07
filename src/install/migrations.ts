import type {ConfigOptions} from './profile.js';
import type {ManagedService} from './types.js';
import type {NerveMcpResult} from './nerve.js';
export interface MigrationOptions extends ConfigOptions {home?: string|null;service?: ManagedService;deferActivation?: boolean;ensureMcp?: typeof ensureNerveMcp;activateMcp?: typeof activateNerveMcp}
export interface MigrationResult {agentsChanged:boolean;obsoleteConfigRemoved:boolean;contextManagementMigrated:boolean;nerve?:NerveMcpResult}
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateAgentsInstructions} from './instructions.js';
import {removeObsoleteCodexSettings,migrateContextManagementConfig} from './profile.js';
import {exists,readInstall} from './core.js';
import {ensureNerveMcp} from './nerve.js';
import {activateNerveMcp} from './nerve-service.js';
import {createService} from './service.js';
import {writeNerveLauncher} from './setup.js';

// Older updaters pass only Codex options. Infer the installation from the
// verified candidate location so their very first upgrade repairs MCP too.
export function migrationHome(moduleUrl=import.meta.url) {
  const release=resolve(dirname(fileURLToPath(moduleUrl)),'../..');
  return /^[a-f0-9]{40}$/.test(basename(release)) && basename(dirname(release))==='releases'
    ? dirname(dirname(release)) : undefined;
}

export async function runUpdateMigrations({home=migrationHome(),codexHome, command, writeConfig, readConfig, binary, resolveCommand, service, deferActivation=false, ensureMcp=ensureNerveMcp, activateMcp=activateNerveMcp}: MigrationOptions = {}): Promise<MigrationResult> {
  if (!codexHome) throw new TypeError('codexHome is required');
  const agentsChanged = await migrateAgentsInstructions(join(codexHome, 'AGENTS.md'));
  const config = await removeObsoleteCodexSettings({codexHome,command,writeConfig,binary,resolveCommand});
  const context = await migrateContextManagementConfig({codexHome,command,writeConfig,readConfig,binary,resolveCommand});
  const result: MigrationResult={agentsChanged,obsoleteConfigRemoved:config.status!=='unchanged',contextManagementMigrated:context.status!=='unchanged'};
  if (home) {
    const state=await readInstall(home);
    if (!await exists(join(home,'nerve-mcp-run.mjs'))) await writeNerveLauncher(home);
    const nerve=await ensureMcp({home,codexHome,command,binary,writeConfig,node:state.node});
    result.nerve=nerve;
    if (!deferActivation) await activateMcp({home,nerve,service:service || createService({home,node:state.node})});
  }
  return result;
}
