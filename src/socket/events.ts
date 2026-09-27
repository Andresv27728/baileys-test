/**
 * Emisor de eventos tipado.
 *
 * `WaSocket` es un `EventEmitter` normal, pero los nombres y las cargas útil
 * están declarados aquí para que el consumidor de la librería no tenga que
 * usar `any`.
 */

import type { Buffer } from 'node:buffer'
import type { BinaryNode } from '../transport/binary-node.ts'
import type { WAMessage, WAMessageContent, Contact } from '../api/types.ts'
import type { Registration } from '../store/signal-store.ts'

export type ConnectionState = 'closed' | 'connecting' | 'open' | 'syncing' | 'online'

export interface ConnectionUpdate {
	state: ConnectionState
	/** presente si `state === 'closed'` */
	statusCode?: number
	/** ms hasta el próximo intento, si estamos reintentando */
	retryIn?: number
	isNewLogin?: boolean
	qr?: string
	/** el número de teléfono, una vez emparejado */
	me?: { id: string; lid?: string; name?: string }
}

export interface WAMessageKey {
	remoteJid: string
	fromMe: boolean
	id: string
	participant?: string
}

export interface MessagesUpsert {
	messages: WAMessage[]
	type: 'append' | 'notify'
	requestId?: string
}

export interface MessagesUpdate {
	updates: Array<{ key: WAMessageKey; update: { status?: number; message?: WAMessageContent } }>
}

export interface MessageReceiptDkimFailure {
	ids: string[]
	recipientJid: string
	participantJid?: string
}

export interface WAMessageAck {
	jid: string
	participant: string | undefined
	messageId: string | undefined
	receipt: WAMessageKey
	error: Error | undefined
}

export interface WaEvents {
	'connection.update': (u: ConnectionUpdate) => void
	'creds.update': (creds: Partial<Registration>) => void
	'messaging-history.set': (d: { chats: Array<{ conversationTimestamp: number; id: string }>; messages: WAMessage[]; contact: Contact; progress: number | null }) => void
	'messages.upsert': (d: MessagesUpsert) => void
	'messages.update': (d: MessagesUpdate) => void
	'messages.delete': (d: WAMessageKey & { fromMe?: boolean } | WAMessageKey[]) => void
	'message-receipt.update': (d: Record<string, string>) => void
	'message-receipt.update.bulk': (d: { before: number; receipts: Array<{ key: WAMessageKey; receipt: string }> }) => void
	'messages.reaction': (d: { key: WAMessageKey; reaction: string }) => void
	'message-receipt.dkim-failure': (d: MessageReceiptDkimFailure) => void
	'presence.update': (d: { jid: string; status: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused' }) => void
	'contacts.upsert': (contacts: Contact[]) => void
	'contact.update': (d: { id: string; lid?: string; name?: string }) => void
	'chats.update': (d: Array<{ id: string; unreadCount?: number; conversationTimestamp?: number; archived?: boolean; pinned?: number; name?: string; unreadMentions?: number }>) => void
	'chats.delete': (d: string | string[]) => void
	'groups.update': (d: Array<{ id: string; subject?: string; participants?: string[]; desc?: string }>) => void
	'group-participants.update': (d: { id: string; participants: string[]; action: 'add' | 'remove' | 'promote' | 'demote' }) => void
	'blocklist.set': (d: { blocklist: string[] }) => void
	'blocklist.update': (d: { blocklist: string[]; actor: string }) => void
	'call': (d: { id: string; from: string; status: string; isVideo: boolean; isGroup: boolean }) => void
	'media.update': (d: { key: WAMessageKey; update: { status: 'PENDING' | 'SERVER_ACK' | 'SUCCESS' | 'ERROR' } }) => void
	'logout': (d: { reason: string; message?: string }) => void
	/** el emparejamiento por QR puede empezar o se ha rechazado */
	'pairing.update': (d: { kind: 'awaiting-qr' | 'awaiting-code' | 'paired' | 'idle'; qr?: string; ref?: string; phone?: string; reason?: string }) => void
	'debug': (d: { level: 'trace' | 'debug'; message: string; data?: unknown; node?: BinaryNode | Buffer }) => void
	'stream.error': (e: Error & { code?: string; stream?: string }) => void
}

export type WaEventName = keyof WaEvents

export type Listener<T> = (payload: T) => void

/** Colas de mensajes salientes: mantiene el orden de salida. */
export class MessageQueue {
	private queue: Array<() => Promise<void>> = []
	private running = false
	private maxRetries = 5

	private readonly onError: (err: Error) => void

	constructor(onError: (err: Error) => void) {
		this.onError = onError
	}

	push(task: () => Promise<void>): void {
		this.queue.push(task)
		void this.process()
	}

	private async process(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			while (this.queue.length > 0) {
				const task = this.queue.shift()!
				let lastError: Error | null = null
				for (let attempt = 0; attempt < this.maxRetries; attempt++) {
					try {
						await task()
						lastError = null
						break
					} catch (err) {
						lastError = err as Error
						const wait = Math.min(2 ** attempt * 1000, 15000)
						await new Promise(r => setTimeout(r, wait))
					}
				}
				if (lastError) this.onError(lastError)
			}
		} finally {
			this.running = false
		}
	}

	get size(): number {
		return this.queue.length
	}
}
