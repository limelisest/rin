export interface LocalFile { path: string; mimeType?: string; name?: string }
export interface MessageInput { text?: string; files?: LocalFile[]; cwd?: string; start?: boolean; onClientMessageId?: (id: string) => void }
export interface ExecOptions { command?: string[]; codexHome?: string; cwd?: string; timeoutMs?: number }
export interface ExecResult { threadId: string; text: string; completed: boolean; turnId?: string }
export interface ExecEvent { type: string; thread_id?: string; item?: { type?: string; text?: string; phase?: string } }
export interface AppEvent { type: string; threadId?: string; turnId?: string; phase?: string; text?: string }
export interface AppReceipt { threadId: string; messageId: string; turnId: string; transport: string }
export interface IpcResponse { type?: string; requestId?: string; resultType?: string; method?: string; handledByClientId?: string; error?: string; result?: {clientId?: string; result?: {turn?: {id?: string}; turnId?: string}} }
