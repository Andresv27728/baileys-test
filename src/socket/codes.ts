/**
 * Códigos de desconexión de WhatsApp.
 *
 * No todos los códigos son "desconexión": 401 y 440 significan que hay que
 * rehacerse el registro, así que el socket debe distinguished.
 */

import { Buffer } from 'node:buffer'
import { decode, defineSchema } from '../proto/codec.ts'
import { WebMessageInfo } from '../proto/schema.ts'

/** Códigos que exigen volver a vincular el dispositivo. */
export const ReloginReason = {
	/** sesión cerrada desde el teléfono */
	LoggedOut: 401,
	/** dispositivo desvinculado */
	Unpaired: 411,
	/** la sesión guardada ya no vale */
	BadSession: 428,
	/** otro dispositivo tomó el mismo número */
	Conflict: 440,
	/** versionado de dispositivo incompatible */
	MultiDeviceMismatch: 411,
	/** el servidor nos vetó */
	Forbidden: 403,
	/** caída transitoria del servidor */
	ServiceUnavailable: 503
} as const

export const LoggedOutReason = ReloginReason.LoggedOut
export const ConnectionUpdate = {
	Connecting: 'connecting',
	Open: 'open',
	Syncing: 'syncing',
	Online: 'online',
	Close: 'close',
	ConnectionLost: 'connection_lost'
} as const

export function isReloginCode(code: number | undefined): boolean {
	if (code === undefined) return false
	return (
		code === ReloginReason.LoggedOut ||
		code === ReloginReason.Unpaired ||
		code === ReloginReason.BadSession ||
		code === ReloginReason.Conflict ||
		code === ReloginReason.Forbidden ||
		code === ReloginReason.MultiDeviceMismatch
	)
}

export function isFatalDisconnectCode(code: number | undefined): boolean {
	return code === ReloginReason.LoggedOut
}

export function isConnectionClosed(code: number | undefined): boolean {
	return code !== undefined && code >= 400 && code < 500
}

export function getStatusCodeForSocketError(err: unknown): number | undefined {
	const e = err as { output?: { statusCode?: number }; statusCode?: number; code?: string | number }
	if (typeof e?.output?.statusCode === 'number') return e.output.statusCode
	if (typeof e?.statusCode === 'number') return e.statusCode
	if (e?.code === 428 || e?.code === 'ECONNABORTED') return ReloginReason.BadSession
	if (e?.code === 440) return ReloginReason.Conflict
	if (e?.code === 401) return ReloginReason.LoggedOut
	return undefined
}

/** Interpreta el cuerpo de un nodo `conflict` o `disconnect`. */
export const StreamErrorSchema = defineSchema('StreamError', {
	statusCode: { type: 'uint32' },
	message: { type: 'string' },
	reason: { type: 'string' }
})

export function parseStreamError(data: Buffer): { statusCode?: number; message?: string; reason?: string } {
	try {
		return decode<{ statusCode?: number; message?: string; reason?: string }>(StreamErrorSchema, data)
	} catch {
		return {}
	}
}

/** Extrae el número de teléfono de un nodo `stream: error`. */
export function extractDisconnectReason(msg: { tag: string; attrs: Record<string, string | undefined>; binary?: Buffer }): number | undefined {
	if (msg.attrs.reason) {
		const parsed = parseStreamError(Buffer.from(msg.attrs.reason, 'base64'))
		if (parsed.statusCode !== undefined) return parsed.statusCode
	}
	if (msg.tag === 'conflict') return ReloginReason.Conflict
	if (msg.tag === 'replaced') return ReloginReason.Conflict
	if (msg.tag === 'blocklist') return ReloginReason.Forbidden
	return undefined
}

export type { WebMessageInfo }
