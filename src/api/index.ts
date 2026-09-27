/**
 * Superficie pública de la API.
 *
 * Reexporta el cliente, los tipos y los helpers de mensaje, de forma que
 * quien importe la librería no tenga que conocer la estructura interna de
 * carpetas (`socket/`, `protocol/`, `store/`).
 */

export { WaSocket } from '../socket/client.ts'
export { MessageQueue } from '../socket/events.ts'
export {
	PAIRING_TIMEOUT_MS,
	QR_REFRESH_MS,
	buildQrPayload,
	generatePairingCode,
	isValidPairingCode,
	normalizePairingCode,
	normalizePhoneNumber,
	parseQrPayload
} from '../socket/pairing.ts'
export type { PairingState } from '../socket/pairing.ts'

export {
	generateMessageId,
	normalizeContent,
	textMessage,
	buildProtocolMessage,
	fillMediaMetadata,
	decode,
	encode,
	parseJid
} from './messages.ts'

export {
	Message,
	MessageContext,
	MessageKey,
	MessageStatus,
	WebMessageInfo
} from '../proto/schema.ts'

export type {
	AnyMessageContent,
	Chat,
	Contact,
	ContextInfo,
	Jid,
	MediaMessage,
	MessageInfo,
	SendMessageOptions,
	WAMessage,
	WAMessageContent,
	WAMessageKey,
	WASocketConfig
} from './types.ts'

export type {
	ConnectionState,
	ConnectionUpdate,
	Listener,
	MessagesUpdate,
	MessagesUpsert,
	MessageReceiptDkimFailure,
	WAMessageAck,
	WaEventName,
	WaEvents
} from '../socket/events.ts'

export { MemoryStore } from '../store/memory.ts'
export { SqliteStore } from '../store/sqlite.ts'
export type { BaseStore } from '../store/types.ts'

export {
	ConnectionError,
	CryptoError,
	HandshakeError,
	InvalidJidError,
	ProtoError,
	SessionError,
	errorMessage
} from '../util/errors.ts'
