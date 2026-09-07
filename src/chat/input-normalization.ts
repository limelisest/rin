/** Platform-neutral, display-safe inbound context.  These fields are context,
 * never an authority claim or a second user instruction. */
export type InboundMediaKind = 'image' | 'file' | 'video' | 'audio' | 'voice' | 'sticker';

export interface InboundMedia {
  kind: InboundMediaKind;
  name?: string;
  mimeType?: string;
  path?: string;
  description?: string;
  unavailable?: string;
}

export interface ReplyContext {
  messageId: string;
  authorId?: string;
  authorName?: string;
  text?: string;
  media?: InboundMedia[];
  unavailable?: boolean;
}

export interface ForwardNode {
  authorId?: string;
  authorName?: string;
  text?: string;
  media?: InboundMedia[];
  children?: ForwardNode[];
}

export interface ForwardContext {
  nodes: ForwardNode[];
  unavailable?: string;
  truncated?: boolean;
}

const oneLine = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function mediaSummary(media: InboundMedia): string {
  const label = media.kind === 'sticker' ? 'sticker' : media.kind;
  const detail = oneLine(media.description || media.name || media.mimeType);
  const unavailable = oneLine(media.unavailable);
  return `[${label}${detail ? `: ${detail}` : ''}${unavailable ? `; unavailable: ${unavailable}` : ''}]`;
}

/** Render a quote with a hard context boundary, so quoted text cannot change sender identity or permissions. */
export function renderReplyContext(reply: ReplyContext | undefined): string {
  if (!reply?.messageId) return '';
  const author = oneLine(reply.authorName || reply.authorId);
  const lines = [`[Quoted message ${reply.messageId}${author ? ` from ${author}` : ''}; context only]`];
  if (reply.text) lines.push(reply.text);
  for (const media of reply.media || []) lines.push(mediaSummary(media));
  if (!reply.text && !(reply.media?.length) || reply.unavailable) lines.push('[quoted body unavailable]');
  lines.push('[End quoted message]');
  return lines.join('\n');
}

/** Keep a provider's chat id and thread/topic id as separate values. */
export function sameConversation(
  left: {adapter?: string; chatId: string; topicId?: string},
  right: {adapter?: string; chatId: string; topicId?: string},
): boolean {
  return String(left.adapter || '') === String(right.adapter || '') &&
    String(left.chatId) === String(right.chatId) &&
    String(left.topicId || '') === String(right.topicId || '');
}

/** Bound a forward tree after retrieval.  The caller must retrieve it only after admission. */
export function limitForward(nodes: ForwardNode[], limits: {maxDepth?: number; maxNodes?: number; maxBytes?: number} = {}): ForwardContext {
  const maxDepth = limits.maxDepth ?? 3;
  const maxNodes = limits.maxNodes ?? 20;
  const maxBytes = limits.maxBytes ?? 64 * 1024;
  let count = 0, bytes = 0, truncated = false;
  const visit = (node: ForwardNode, depth: number): ForwardNode | null => {
    if (depth > maxDepth || count >= maxNodes) { truncated = true; return null; }
    const candidate: ForwardNode = {
      ...(node.authorId ? {authorId: oneLine(node.authorId)} : {}),
      ...(node.authorName ? {authorName: oneLine(node.authorName)} : {}),
      ...(node.text ? {text: String(node.text)} : {}),
      ...(node.media?.length ? {media: node.media} : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(candidate));
    if (bytes + size > maxBytes) { truncated = true; return null; }
    bytes += size; count++;
    const children = (node.children || []).map(child => visit(child, depth + 1)).filter((child): child is ForwardNode => child !== null);
    if (children.length) candidate.children = children;
    return candidate;
  };
  return {nodes: (nodes || []).map(node => visit(node, 1)).filter((node): node is ForwardNode => node !== null), ...(truncated ? {truncated: true} : {})};
}

export function renderForwardContext(forward: ForwardContext | undefined): string {
  if (!forward) return '';
  const lines = ['[Forwarded messages; context only]'];
  const walk = (nodes: ForwardNode[], depth: number) => {
    for (const node of nodes) {
      const author = oneLine(node.authorName || node.authorId) || 'unknown author';
      lines.push(`${'  '.repeat(depth)}- ${author}: ${node.text || ''}`.trimEnd());
      for (const media of node.media || []) lines.push(`${'  '.repeat(depth + 1)}${mediaSummary(media)}`);
      walk(node.children || [], depth + 1);
    }
  };
  walk(forward.nodes, 0);
  if (forward.unavailable) lines.push(`[Forwarded messages unavailable: ${oneLine(forward.unavailable)}]`);
  if (forward.truncated) lines.push('[Forwarded messages truncated by safety limits]');
  lines.push('[End forwarded messages]');
  return lines.join('\n');
}

export function composeInboundText(text: string, context: {reply?: ReplyContext; forward?: ForwardContext} = {}): string {
  return [renderReplyContext(context.reply), renderForwardContext(context.forward), String(text || '')].filter(Boolean).join('\n\n');
}
