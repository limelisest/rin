import {join} from 'node:path';
import {migrateAgentsInstructions} from './instructions.mjs';
import {removeObsoleteCodexSettings,migrateContextManagementConfig} from './profile.mjs';

export async function runUpdateMigrations({codexHome, command, writeConfig, readConfig, binary, resolveCommand} = {}) {
  const agentsChanged = await migrateAgentsInstructions(join(codexHome, 'AGENTS.md'));
  const config = await removeObsoleteCodexSettings({codexHome,command,writeConfig,binary,resolveCommand});
  const context = await migrateContextManagementConfig({codexHome,command,writeConfig,readConfig,binary,resolveCommand});
  return {agentsChanged,obsoleteConfigRemoved:config.status!=='unchanged',contextManagementMigrated:context.status!=='unchanged'};
}
