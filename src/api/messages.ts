/**
 * Conversión de la API pública a los protobuf de WhatsApp.
 *
 * La API acepta un objeto plano (`{ text: 'hola' }`, `{ image: buffer }`...)
 * y aquí se traduce al `Message` protobuf que espera el servidor.
 */

import { Buffer } from 'node:buffer'
import { decode, encode, type ProtoObject } from '../proto/codec.ts'
import { Message, MessageContext, MessageKey, WebMessageInfo, MessageStatus, ContextInfo as ContextInfoProto } from '../proto/schema.ts'
import type { AnyMessageContent, ContextInfo, WAMessageKey, WAMessageContent } from './types.ts'
import { isJidGroup, parseJid } from '../util/jid.ts'
import { createHash } from 'node:crypto'

/**
 * Id de mensaje con el formato de WA: 8 bytes de firma + 8 aleatorios + 4 de
 * reloj, todo en base36/hex mayúsculas. El servidor solo exige que sea único
 * dentro de la sesión, así que la parte aleatoria es la que da la garantía.
 */
export function generateMessageId(user: string, _server: string): string {
	const random = randomHex(8).toUpperCase()
	const timestamp = Date.now().toString(36).toUpperCase()
	const signature = createHash('sha256')
		.update(`${user}:${timestamp}:${random}:${process.hrtime.bigint()}`)
		.digest('hex')
		.slice(0, 16)
		.toUpperCase()
	return `${signature}${random}${timestamp}`
}

function randomHex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2))
	crypto.getRandomValues(bytes)
	return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, length)
}

/**
 * Traduce el contenido de la API al `Message` protobuf.
 * Lanza si el tipo no está soportado, en vez de mandar un nodo vacío.
 */
export function normalizeContent(content: AnyMessageContent, contextInfo?: ContextInfo): ProtoObject {
	if ('text' in content && typeof content.text === 'string') {
		return textMessage(content.text, contextInfo)
	}
	if ('image' in content) return mediaMessage('imageMessage', content as never, contextInfo)
	if ('video' in content) return mediaMessage('videoMessage', content as never, contextInfo)
	if ('audio' in content) return mediaMessage('audioMessage', content as never, contextInfo)
	if ('document' in content) return mediaMessage('documentMessage', content as never, contextInfo)
	if ('sticker' in content) return mediaMessage('stickerMessage', content as never, contextInfo)
	if ('location' in content) return locationMessage(content as never, contextInfo)
	if ('contact' in content) return contactMessage(content as never, contextInfo)
	if ('poll' in content) return pollMessage(content as never, contextInfo)
	if ('reaction' in content) return reactionMessage(content as never)
	if ('viewOnce' in content) {
		const inner = normalizeContent(content.message as AnyMessageContent, contextInfo)
		return { ...inner, viewOnce: true }
	}
	if ('forward' in content) {
		return normalizeContent(content.message as AnyMessageContent, contextInfo)
	}
	throw new Error(`tipo de contenido no soportado: ${Object.keys(content).join(', ')}`)
}

/** Texto plano: `conversation` si es corto, si no `extendedTextMessage`. */
export function textMessage(text: string, contextInfo?: ContextInfo): ProtoObject {
	// El server corta los `conversation` muy largos; a partir de aquí conviene
	// el extended con su preview de links.
	if (text.length <= 200 && !contextInfo && !text.includes('http')) {
		return { conversation: text }
	}
	const extended: ProtoObject = { text }
	if (contextInfo) extended.contextInfo = encode(ContextInfoProto, contextInfo as ProtoObject)
	return { extendedTextMessage: extended }
}

function mediaMessage(kind: string, content: Record<string, unknown>, contextInfo?: ContextInfo): ProtoObject {
	const data = content[kind === 'imageMessage' ? 'image' : kind === 'videoMessage' ? 'video' : kind === 'audioMessage' ? 'audio' : kind === 'documentMessage' ? 'document' : 'sticker']
	const msg: ProtoObject = {}

	if (typeof data === 'string') {
		msg.url = data
	} else if (data && typeof data === 'object' && 'url' in (data as object)) {
		msg.url = String((data as { url: string }).url)
	}

	if (content.mimetype) msg.mimetype = String(content.mimetype)
	if (content.caption) msg.caption = String(content.caption)
	if (content.fileName) msg.fileName = String(content.fileName)
	if (content.seconds !== undefined) msg.seconds = Number(content.seconds)
	if (content.pptv !== undefined) msg.ptt = Boolean(content.pptv)
	if (contextInfo) msg.contextInfo = encode(ContextInfoProto, contextInfo as ProtoObject)

	return { [kind]: msg }
}

function locationMessage(content: Record<string, unknown>, contextInfo?: ContextInfo): ProtoObject {
	const loc = content.location as { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string; url?: string }
	const msg: ProtoObject = {
		degreesLatitude: loc.degreesLatitude,
		degreesLongitude: loc.degreesLongitude
	}
	if (loc.name) msg.name = loc.name
	if (loc.address) msg.address = loc.address
	if (loc.url) msg.url = loc.url
	if (contextInfo) msg.contextInfo = encode(ContextInfoProto, contextInfo as ProtoObject)
	return { locationMessage: msg }
}

function contactMessage(content: Record<string, unknown>, contextInfo?: ContextInfo): ProtoObject {
	const c = content.contact as { displayName: string; vcard: string }
	const msg: ProtoObject = { displayName: c.displayName, vcard: c.vcard }
	if (contextInfo) msg.contextInfo = encode(ContextInfoProto, contextInfo as ProtoObject)
	return { contactMessage: msg }
}

function pollMessage(content: Record<string, unknown>, _contextInfo?: ContextInfo): ProtoObject {
	const p = content.poll as { name: string; options: string[]; selectableCount?: number }
	return {
		extendedTextMessage: { text: `${p.name}\n${p.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` }
	}
}

function reactionMessage(content: Record<string, unknown>): ProtoObject {
	const r = content.reaction as { text: string; key: WAMessageKey }
	return {
		reactionMessage: {
			key: r.key as unknown as ProtoObject,
			text: r.text,
			senderTimestampMs: BigInt(Date.now())
		}
	}
}

/** Construye el `WebMessageInfo` completo de un mensaje saliente. */
export function buildProtocolMessage(params: {
	key: WAMessageKey
	content: AnyMessageContent
	timestamp: number
	contextInfo?: ContextInfo
}): ProtoObject {
	const message = normalizeContent(params.content, params.contextInfo)
	return {
		key: params.key as unknown as ProtoObject,
		message,
		messageTimestamp: BigInt(Math.floor(params.timestamp / 1000)),
		status: MessageStatus.PENDING,
		...(isJidGroup(params.key.remoteJid) && params.key.participant
			? { participant: params.key.participant }
			: {})
	}
}

/**
 * Rellena los metadatos de media que faltan: hash, tamaño y clave.
 *
 * `mediaKey` es una clave de 32 bytes de la que sale el `fileEncSha256`; sin
 * ella el servidor rechaza la subida.
 */
export function fillMediaMetadata(
	msg: Record<string, unknown>,
	data: Buffer,
	mimetype: string,
	timestamp: number
): void {
	const mediaKey = randomBytesBytes(32)
	msg.mediaKey = mediaKey
	msg.mimetype = mimetype
	msg.fileLength = BigInt(data.length)
	msg.fileEncSha256 = sha256Bytes(mediaKey)
	msg.directPath = `/v/t62.7117-24/${randomHex(8)}`
	msg.mediaKeyTimestamp = Math.floor(timestamp)
}

function randomBytesBytes(n: number): Buffer {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(n)))
}

function sha256Bytes(data: Buffer): Buffer {
	return createHash('sha256').update(data).digest()
}

/**
 * Saca el texto legible de un mensaje recibido, sea del tipo que sea.
 *
 * Un bot casi siempre empieza por esto, y hacerlo a mano acaba en un `if` por
 * cada tipo: un chat normal viene en `conversation`, pero con previsualización
 * de enlaces viene en `extendedTextMessage`, una foto con pie en
 * `imageMessage.caption`... Devuelve cadena vacía cuando no hay texto (audio,
 * sticker, ubicación...).
 */
export function extractMessageText(content: WAMessageContent | undefined): string {
	if (!content) return ''
	if (typeof content.conversation === 'string' && content.conversation.length > 0) return content.conversation
	const extended = content.extendedTextMessage?.text
	if (typeof extended === 'string' && extended.length > 0) return extended
	for (const caption of [content.imageMessage?.caption, content.videoMessage?.caption, content.documentMessage?.caption]) {
		if (typeof caption === 'string' && caption.length > 0) return caption
	}
	if (content.editedMessage) return extractMessageText(content.editedMessage)
	return ''
}

export { decode, encode, Message, MessageContext, MessageKey, WebMessageInfo, parseJid }
