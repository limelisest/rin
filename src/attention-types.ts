export interface AttentionChannel {mode?: string; idleDelayMs?: number; maxDelayMs?: number; idleOnly?: boolean}
export interface AttentionConfig {target: string; ambientWindowMs: number; ownerUserIds?: string[]; ignoredChatKeys?: string[]; mirrorDiscordChannelIds?: string[]; mirrorDiscordCategoryId?: string; channels?: Record<string,AttentionChannel>; chatConfig: string}
export interface AttentionRecord {id:string; messageId:string; platform:string; platformInstance:string; chatKey:string; userId:string; receivedAt:string; text:string; disposition:string; role?:string; trust?:string; bot?:boolean; authorBot?:boolean; chatType?:string; authorName?:string; mentionedBot?:boolean; ancestorIds?:string[]; replyTo?:string; attachments?: {name?:string; url:string; mimeType?:string}[]}
export interface AttentionItem {messageId:string; platformMessageId?:string; chatKey:string; receivedAt:string; priority:number; reason:string; idleOnly:boolean; nextCheckAt:string; latestCheckAt:string}
export interface AttentionBatch {id:string; dedupeKey:string; createdAt:string; maxPriority:number; items:AttentionItem[]}
export interface AttentionChat {awaitingReplySince?:string; awaitingReplyUntil?:string; attentionMode?:string; attentionModeUntil?:string; lastViewedAt?:string; lastViewedId?:string}
export interface AttentionState {version:number; lastMessageId?:string; pending:AttentionItem[]; chats:Record<string,AttentionChat>; emitting?:AttentionBatch}
export interface AttentionPolicy {ignoredChatKeys?:Set<string>; mirrorDiscordChannelIds:Set<string>; ownerUserIds:Set<string>; channels?:Record<string,AttentionChannel>; awaitingReply?:boolean|string; ambientWindowMs:number}
export interface AttentionGroup {chatKey:string; count:number; firstMessageId:string; lastMessageId:string; reasons:string[]}
export interface AttentionRead {chatKey?:string|null; limit?:number; before?:string; markViewed?:boolean; attentionMode?:string; attentionForMs?:number}
export interface AttentionSend {id?:string; chatKey?:string; text?:string; replyTo?:string; awaitingReply?:boolean; awaitingReplyMs?:number}
export interface AttentionSendInput {id:string; chatKey:string; chatId:string; text:string; replyTo?:string; record:AttentionRecord}
export type AttentionSender=(input:AttentionSendInput)=>Promise<{messageId?:string; id?:string}>;
