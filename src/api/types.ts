/** Tipos públicos de la API: lo que ve el consumidor de la librería. */

export type Jid = string

export interface WAMessageKey {
	remoteJid: string
	fromMe: boolean
	id: string
	participant?: string
	/** el mensaje citado, si es una respuesta */
	message?: WAMessageContent
}

export interface Contact {
	id: string
	lid?: string
	name?: string
	notify?: string
	verifiedName?: string
	imgUrl?: string | null
	status?: string
}

export interface Chat {
	id: string
	name?: string
	conversationTimestamp?: number
	unreadCount?: number
	archived?: boolean
	pinned?: number
	participants?: Array<{ id: string; lid?: string; admin?: string }>
}

export interface WAMessageContent {
	conversation?: string
	extendedTextMessage?: { text?: string; title?: string; description?: string; canonicalLink?: string; matchedText?: string; contextInfo?: ContextInfo }
	imageMessage?: MediaMessage & { caption?: string; viewOnce?: boolean }
	videoMessage?: MediaMessage & { caption?: string; seconds?: number; gifPlayback?: boolean }
	audioMessage?: MediaMessage & { seconds?: number; ptt?: boolean }
	documentMessage?: MediaMessage & { title?: string; fileName?: string; pageCount?: number }
	stickerMessage?: MediaMessage & { isAnimated?: boolean }
	locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string; url?: string }
	contactMessage?: { displayName?: string; vcard?: string }
	reactionMessage?: { key: WAMessageKey; text?: string; senderTimestampMs?: number }
	protocolMessage?: Record<string, unknown>
	editedMessage?: WAMessageContent
	[extra: string]: unknown
}

export interface MediaMessage {
	url?: string
	mimetype?: string
	fileSha256?: Buffer
	fileLength?: number | bigint
	mediaKey?: Buffer
	fileEncSha256?: Buffer
	directPath?: string
	mediaKeyTimestamp?: number | bigint
	caption?: string
	contextInfo?: ContextInfo
}

export interface ContextInfo {
	stanzaId?: string
	participant?: string
	quotedMessage?: WAMessageContent
	mentionedJid?: string[]
	forwardingScore?: number
	isForwarded?: boolean
	expiration?: number
}

export interface WAMessage {
	key: WAMessageKey
	message: WAMessageContent | undefined
	messageTimestamp: number | bigint | undefined
	pushName?: string
	status?: number
	participant?: string
	verifiedBizName?: string
	broadcast?: boolean
	starred?: boolean
	ignore?: boolean
}

export type AnyMessageContent =
	| { text: string }
	| { image: Buffer | { url: string }; caption?: string; mimetype?: string; fileName?: string }
	| { video: Buffer | { url: string }; caption?: string; mimetype?: string; seconds?: number; pptv?: boolean }
	| { audio: Buffer | { url: string }; mimetype?: string; seconds?: number; ptt?: boolean }
	| { document: Buffer | { url: string }; caption?: string; mimetype?: string; fileName?: string }
	| { sticker: Buffer | { url: string } }
	| { location: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string } }
	| { contact: { displayName: string; vcard: string } }
	| { poll: { name: string; options: string[]; selectableCount?: number } }
	| { delete: WAMessageKey }
	| { reaction: { text: string; key: WAMessageKey } }
	| { viewOnce: boolean; message: AnyMessageContent }
	| { forward: boolean; message: AnyMessageContent }
	| { contextInfo: ContextInfo }

export interface MessageInfo {
	status?: number
	message?: WAMessageContent
	[key: string]: unknown
}

export type SendMessageOptions = {
	/**jid del remitente, si es un grupo o un device concreto */
	quoted?: WAMessageKey
	mentions?: string[]
	linkPreview?: { url: string; title?: string; description?: string }
	/** marca el mensaje como "visto una vez" */
	viewOnce?: boolean
	/** reenviar: mantiene el aspecto de reenviado */
	forwarded?: boolean
	/** el mensaje se elimina tras estos segundos */
	ephemeralExpiration?: number
	/**jid de otro device al que enviar (multi-dispositivo) */
	toUser?: string
	/** device_id del destinatario */
	statusJidList?: string[]
}

export interface WASocketConfig {
	/** tu numero, solo necesario para pedir el pairing por número */
	phoneNumber?: string
	/** nombre de la sesión, para no chocar con otras en el mismo store */
	sessionId?: string
	/** token de release; si no, se usa el de por defecto */
	version?: import('../transport/version.js').WaVersion
	/** User-Agent propio del transporte */
	userAgent?: string
	/** ms entre reconexiones */
	reconnectDelayMs?: number
	maxReconnectDelayMs?: number
	/** nº máximo de reintentos antes de rendirse */
	maxReconnectAttempts?: number
	keepAliveIntervalMs?: number
	/** implementaciones alternativas */
	logger?: unknown
	store?: import('../store/types.js').BaseStore
	/** región del teléfono, para el prefijo numérico */
	countryCode?: string
	/** aggressividad del sync inicial */
	syncFullHistory?: boolean
	/** clave de presencia */
	presence?: 'available' | 'unavailable'
	/** el número se pide por SMS en vez de QR */
	agentConfig?: { agentId: string; agentName?: string; platform?: number; version?: number }
	/** número máximo de mensajes en vuelo */
	printQR?: boolean
	getMessage?: (key: WAMessageKey) => Promise<WAMessage | undefined>
	/** claves P-256 de la sesión, para el token de versión */
	token?: { key: Buffer; cert?: Buffer }
	/** número con prefijo de país, para el registro en vez de QR */
	fetchAgent?: boolean
}
