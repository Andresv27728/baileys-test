/**
 * Transporte WebSocket contra `web.whatsapp.com`.
 *
 * Se apoya en `ws` (Node) con fallback a la WebSocket global si existe.
 * Los frames son binarios; el primer byte de cada mensaje indica si el
 * contenido es texto (JSON) o binario.
 */

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { ConnectionError } from '../util/errors.ts'
import { DEFAULT_URL, buildQuery, type WaVersion } from './version.ts'
import { BinaryNode, nodeFromJson } from './binary-node.ts'
import { buildFrame, parsePayload, readFrameHeader, type FrameHeader } from './framing.ts'

export type RawMessage = { isBinary: boolean; data: Buffer }

export interface TransportOptions {
	version: WaVersion
	/** ms antes de considerar el handshake perdido */
	handshakeTimeout?: number
	/** cabeceras extra del WebSocket */
	headers?: Record<string, string>
	logger?: { debug: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }
}

export declare interface WaTransport {
	on(event: 'open', listener: () => void): this
	on(event: 'close', listener: () => void): this
	on(event: 'error', listener: (err: Error) => void): this
	on(event: 'message', listener: (msg: RawMessage) => void): this
	off(event: string, listener: (...args: never[]) => void): this
	send(data: Buffer | string, cb?: (err?: Error) => void): void
	close(code?: number, reason?: string): void
	isOpen(): boolean
}

export class Transport extends EventEmitter {
	private ws: WebSocket | null = null
	private closedByUs = false
	private connected = false
	readonly url: string

	private readonly opts: TransportOptions

	constructor(opts: TransportOptions) {
		super()
		this.opts = opts
		this.url = DEFAULT_URL + buildQuery(opts.version)
	}

	connect(): Promise<boolean> {
		return new Promise((resolve, reject) => {
			let settled = false
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				try { this.ws?.terminate() } catch { /* noop */ }
				reject(new ConnectionError(`timeout de ${this.opts.handshakeTimeout ?? 20000}ms conectando a WhatsApp`))
			}, this.opts.handshakeTimeout ?? 20000)

			const ws = new WebSocket(this.url, {
				origin: 'https://web.whatsapp.com',
				timeout: 0,
				perMessageDeflate: false,
				headers: {
					'User-Agent': this.opts.version.userAgent,
					...(this.opts.headers ?? {})
				}
			})
			this.ws = ws

			ws.binaryType = 'nodebuffer'

			ws.on('open', () => {
				clearTimeout(timer)
				this.connected = true
				this.closedByUs = false
				this.opts.logger?.info?.({ url: this.url }, 'websocket abierto')
				this.emit('open')
				if (!settled) { settled = true; resolve(true) }
			})

			ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
				let buf: Buffer
				if (Array.isArray(data)) buf = Buffer.concat(data)
				else if (data instanceof ArrayBuffer) buf = Buffer.from(data)
				else buf = data as Buffer
				this.emit('message', { isBinary, data: buf })
			})

			ws.on('error', (err: Error) => {
				if (settled) { this.emit('error', err); return }
				settled = true
				clearTimeout(timer)
				reject(new ConnectionError(err.message, err))
			})

			ws.on('close', () => {
				clearTimeout(timer)
				this.connected = false
				this.ws = null
				if (!settled) {
					settled = true
					reject(new ConnectionError('el servidor cerró la conexión durante el handshake'))
					return
				}
				this.emit('close')
			})
		})
	}

	send(data: Buffer | string, cb?: (err?: Error) => void): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			cb?.(new ConnectionError('el websocket no está abierto'))
			return
		}
		try {
			this.ws.send(data, cb)
		} catch (err) {
			cb?.(err as Error)
		}
	}

	/** Envía un nodo binario ya serializado, applying framing + compresión. */
	sendNode(node: BinaryNode | Buffer, cb?: (err?: Error) => void): void {
		const payload = Buffer.isBuffer(node) ? node : node.encode()
		this.send(buildFrame(payload), cb)
	}

	isOpen(): boolean {
		return this.connected && this.ws?.readyState === WebSocket.OPEN
	}

	close(code = 1000, reason = 'logout'): void {
		this.closedByUs = true
		this.connected = false
		try { this.ws?.close(code, reason) } catch { /* noop */ }
		try { this.ws?.terminate() } catch { /* noop */ }
		this.ws = null
	}

	get closedByUser(): boolean {
		return this.closedByUs
	}
}

/**
 * Lee todos los frames que haya en el buffer. El WebSocket puede empaquetar
 * varios frames en un solo mensaje binario.
 *
 * Un frame a medias no es un error: se espera a que llegue el resto.
 */
export function* parseFrames(buffer: Buffer): Generator<Buffer> {
	let offset = 0
	while (offset < buffer.length) {
		const remaining = buffer.subarray(offset)
		let header: FrameHeader
		try {
			header = readFrameHeader(remaining)
		} catch {
			return
		}
		if (header.headerSize + header.payloadSize > remaining.length) return

		const payload = remaining.subarray(header.headerSize, header.headerSize + header.payloadSize)
		offset += header.headerSize + header.payloadSize
		yield parsePayload(payload)
	}
}

/** Convierte un mensaje crudo del WebSocket en un `BinaryNode`, o `null`. */
export function parseIncoming(isBinary: boolean, data: Buffer): BinaryNode | null {
	if (!isBinary) {
		// Formato texto: JSON legacy
		try {
			const parsed = JSON.parse(data.toString('utf8')) as unknown
			return Array.isArray(parsed) ? nodeFromJson(parsed) : null
		} catch {
			return null
		}
	}
	// Formato binario: cada mensaje puede traer varios frames
	const frames = [...parseFrames(data)]
	if (frames.length === 0) {
		// Algunos clientes reciben el nodo sin framing
		try {
			return BinaryNode.decode(data)
		} catch {
			return null
		}
	}
	// Solo se procesa el primero: el resto son duplicados de fanout
	for (const frame of frames) {
		try {
			return BinaryNode.decode(frame)
		} catch {
			continue
		}
	}
	return null
}
