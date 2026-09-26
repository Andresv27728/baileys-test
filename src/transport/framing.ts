/**
 * Framing de los frames del WebSocket de WhatsApp.
 *
 * Cada frame empieza con una cabecera de longitud:
 *
 *   uint16 BE   longitud del payload; 0 significa "la real está en Ext"
 *   uint8       flag: 0x00 sin Ext | 0x01 Ext de 16 bits | 0x02 Ext de 32 bits
 *   [Ext]       longitud real del payload, 16 o 32 bits big-endian
 *   payload
 *
 * Ojo con dos detalles que se confunden fácil:
 *
 *  1. El flag NO indica compresión, solo el tamaño del campo de longitud.
 *     Los payloads de más de 64 KiB no caben en el uint16, de ahí Ext.
 *  2. La compresión va aparte: el primer byte del payload es un byte de
 *     compresión (0x00 = sin comprimir, 0x01..0x04 = nivel de zlib) y el
 *     resto es el cuerpo comprimido.
 *
 * Este formato está escrito según la especificación pública del protocolo;
 * falta contrastarlo contra tráfico real del servidor.
 */

import { Buffer } from 'node:buffer'
import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib'
import { readUInt16BE, readUInt8, readUInt32BE, writeUInt16BE, writeUInt8, writeUInt32BE, concat } from '../util/buffer.ts'
import { ProtoError } from '../util/errors.ts'

/** La longitud no cabe en 16 bits: hay que mirar Ext. */
export const MAX_SMALL = 0xffff

/** Por debajo de este tamaño no merece la pena comprimir. */
export const COMPRESS_THRESHOLD = 0x2000

export const FLAG_NO_EXT = 0x00
export const FLAG_EXT16 = 0x01
export const FLAG_EXT32 = 0x02

/** Byte que precede al cuerpo dentro del payload. */
export const COMPRESSION_NONE = 0x00
export const COMPRESSION_DEFLATE = 0x01

export interface FrameHeader {
	/** bytes que ocupa la cabecera */
	headerSize: number
	/** longitud del payload announced en la cabecera */
	payloadSize: number
	/** el payloadlen real vino en Ext porque no cabía en el uint16 */
	extended: boolean
}

export interface Frame {
	payload: Buffer
	/** longitud total del frame en el buffer, cabecera incluida */
	consumed: number
}

/** Lee la cabecera y devuelve dónde empieza el payload. */
export function readFrameHeader(buf: Uint8Array): FrameHeader {
	if (buf.length < 3) throw new ProtoError('frame demasiado corto para tener cabecera')

	const short = readUInt16BE(buf, 0)
	const flag = readUInt8(buf, 2)

	switch (flag) {
		case FLAG_NO_EXT:
			return { headerSize: 3, payloadSize: short, extended: false }

		case FLAG_EXT16: {
			if (buf.length < 5) throw new ProtoError('frame con Ext de 16 bits incompleto')
			return { headerSize: 5, payloadSize: readUInt16BE(buf, 3), extended: true }
		}

		case FLAG_EXT32: {
			if (buf.length < 7) throw new ProtoError('frame con Ext de 32 bits incompleto')
			return { headerSize: 7, payloadSize: readUInt32BE(buf, 3), extended: true }
		}

		default:
			throw new ProtoError(`flag de frame desconocido: 0x${flag.toString(16)}`)
	}
}

/** Empaqueta un payload (ya serializado y sin byte de compresión) en un frame. */
export function buildFrame(
	payload: Buffer,
	{ forceExtended = false, forceCompressed = false }: { forceExtended?: boolean; forceCompressed?: boolean } = {}
): Buffer {
	const needsExt = forceExtended || payload.length > MAX_SMALL
	const body = buildPayload(payload, forceCompressed)

	if (needsExt && payload.length > 0xffff) {
		const head = Buffer.alloc(7)
		writeUInt16BE(0, head, 0)
		writeUInt8(FLAG_EXT32, head, 2)
		writeUInt32BE(body.length, head, 3)
		return concat(head, body)
	}

	if (needsExt) {
		const head = Buffer.alloc(5)
		writeUInt16BE(0, head, 0)
		writeUInt8(FLAG_EXT16, head, 2)
		writeUInt16BE(body.length, head, 3)
		return concat(head, body)
	}

	const head = Buffer.alloc(3)
	writeUInt16BE(body.length, head, 0)
	writeUInt8(FLAG_NO_EXT, head, 2)
	return concat(head, body)
}

/**
 * Añade el byte de compresión delante del cuerpo.
 * `forceCompressed` evita la comprobación de si comprimir mejora el tamaño,
 * que es lo que necesita el handshake.
 */
function buildPayload(payload: Buffer, forceCompressed: boolean): Buffer {
	if (payload.length <= COMPRESS_THRESHOLD && !forceCompressed) {
		return concat(Buffer.from([COMPRESSION_NONE]), payload)
	}

	const deflated = deflateSync(payload, { level: zlibConstants.Z_DEFAULT_COMPRESSION })
	if (!forceCompressed && deflated.length >= payload.length) {
		// comprimir no ayudó: mejor mandar el original sin comprimir
		return concat(Buffer.from([COMPRESSION_NONE]), payload)
	}
	return concat(Buffer.from([COMPRESSION_DEFLATE]), deflated)
}

/** Quita el byte de compresión y descomprime si hace falta. */
export function parsePayload(payload: Buffer): Buffer {
	if (payload.length === 0) return payload

	const compression = payload[0]
	const body = payload.subarray(1)

	switch (compression) {
		case COMPRESSION_NONE:
			return body
		case COMPRESSION_DEFLATE:
			try {
				return inflateSync(body)
			} catch (err) {
				throw new ProtoError(`payload comprimido ilegible: ${(err as Error).message}`)
			}
		default:
			throw new ProtoError(`byte de compresión desconocido: 0x${compression!.toString(16)}`)
	}
}

/**
 * Extrae el frame `index` (0-based) del buffer.
 * `sliceFrame` da el payload tal cual; `parsePayload` lo descomprime.
 */
export function sliceFrame(buffer: Buffer, index = 0): Frame {
	let offset = 0
	for (let i = 0; i < index; i++) {
		const { headerSize, payloadSize } = readFrameHeader(buffer.subarray(offset))
		offset += headerSize + payloadSize
	}

	const { headerSize, payloadSize } = readFrameHeader(buffer.subarray(offset))
	const start = offset + headerSize
	if (buffer.length < start + payloadSize) {
		throw new ProtoError(`frame ${index} incompleto: faltan ${start + payloadSize - buffer.length} bytes`)
	}

	return { payload: buffer.subarray(start, start + payloadSize), consumed: start + payloadSize }
}
