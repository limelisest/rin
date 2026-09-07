import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {exists} from './core.js';

// Exact templates published by Rin. Keep this catalogue only for removal, never injection.
export const RIN_RETIRED_SUBAGENT_INSTRUCTIONS = Object.freeze([
  "## Rin subagent guidance\n\nChoose subagent models from those currently available in the host, using their stated capabilities and relative cost. Use lower-cost models for bounded, straightforward work; reserve more capable models for difficult reasoning, uncertain requirements, and integration decisions. Do not assume model names or prices remain current.\n\nDelegate concrete, independent tasks in parallel when the expected benefit exceeds coordination and context costs. Keep dependent steps sequential, avoid concurrent edits to the same files, and do small tasks locally when delegation adds overhead. Give each subagent only the context and acceptance criteria it needs. Follow the host's available tools and model-selection rules; if a model override is unavailable, use the supported default.\n\nThe primary agent owns the outcome: review and integrate subagent results, resolve conflicts, and verify the combined change before reporting completion.",
  "Make active use of subagents: use Astra for work that can run in parallel, Terra for relatively independent, simple tasks, and Luna for purely execution-oriented tasks.",
  "Actively use a separate subagent for each independent subtask. For example, use Astra subagents for work that can run in parallel, and Luna subagents for simple tasks.",
  "As the primary agent, handle only planning and acceptance review. Delegate every execution task to a separate Terra subagent for complex work or Luna subagent for simple work."
]);

function removeRetiredGuidance(previous: string) {
  const bom = previous.startsWith("\uFEFF") ? "\uFEFF" : "";
  let next = previous.slice(bom.length);
  for (const retired of RIN_RETIRED_SUBAGENT_INSTRUCTIONS) {
    // Match a complete managed paragraph/block, allowing line wrapping and CRLF.
    // A quoted template, custom wording, or an inline mention is not managed text.
    const pattern = retired.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ \t\r\n]+");
    next = next.replace(new RegExp(`^[ \t]*${pattern}[ \t]*(?=\r?$)`, "gm"), "");
  }
  return bom + next;
}

export async function migrateAgentsInstructions(file: string) {
  if (!await exists(file)) return false;
  const previous = await readFile(file, 'utf8');
  const next = removeRetiredGuidance(previous);
  if (next === previous) return false;
  await writeFile(file, next, {mode: 0o600});
  return true;
}

export async function appendAgentsInstructions(file: string, {agents = ''} = {}) {
  const previous = await exists(file) ? await readFile(file, 'utf8') : '';
  let next = previous;
  const append = (text: string) => { next += `${next && !next.endsWith('\n') ? '\n' : ''}${next ? '\n' : ''}${text}\n`; };
  if (agents.trim()) append(agents);
  if (next === previous) return false;
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, next, {mode: 0o600});
  return true;
}
