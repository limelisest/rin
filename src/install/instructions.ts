import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {exists} from './core.js';

export const RIN_SUBAGENT_INSTRUCTIONS = 'As the primary agent, handle only planning and acceptance review. Delegate every execution task to a separate Terra subagent for complex work or Luna subagent for simple work.';
export const RIN_LEGACY_SUBAGENT_INSTRUCTIONS = Object.freeze([
  'Actively use a separate subagent for each independent subtask. For example, use Astra subagents for work that can run in parallel, and Luna subagents for simple tasks.',
  'Make active use of subagents: use Astra for work that can run in parallel, Terra for relatively independent, simple tasks, and Luna for purely execution-oriented tasks.',
]);

function replaceLegacyGuidance(previous: string) {
  let next = previous;
  for (const legacy of RIN_LEGACY_SUBAGENT_INSTRUCTIONS) {
    const first = next.indexOf(legacy);
    if (first < 0) continue;
    next = next.replaceAll(legacy, '');
    if (!next.includes(RIN_SUBAGENT_INSTRUCTIONS)) {
      next = `${next.slice(0, first)}${RIN_SUBAGENT_INSTRUCTIONS}${next.slice(first)}`;
    }
  }
  return next;
}

export async function migrateAgentsInstructions(file: string) {
  if (!await exists(file)) return false;
  const previous = await readFile(file, 'utf8');
  const next = replaceLegacyGuidance(previous);
  if (next === previous) return false;
  await writeFile(file, next, {mode: 0o600});
  return true;
}

export async function appendAgentsInstructions(file: string, {agents = '', subagentGuidance = false} = {}) {
  const previous = await exists(file) ? await readFile(file, 'utf8') : '';
  let next = subagentGuidance ? replaceLegacyGuidance(previous) : previous;
  const append = (text: string) => { next += `${next && !next.endsWith('\n') ? '\n' : ''}${next ? '\n' : ''}${text}\n`; };
  if (agents.trim()) append(agents);
  if (subagentGuidance && !next.includes(RIN_SUBAGENT_INSTRUCTIONS)) append(RIN_SUBAGENT_INSTRUCTIONS);
  if (next === previous) return false;
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, next, {mode: 0o600});
  return true;
}
