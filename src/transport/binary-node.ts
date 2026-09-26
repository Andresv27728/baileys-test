/**
 * Nodo binario de WhatsApp (`WABinaryNode`).
 *
 * Es la unidad de contenido que viaja dentro de los frames del WebSocket.
 * Un nodo es conceptualmente un array JSON `[tag, attrs, ...content]`, pero
 * serializado en binario para ahorrar ancho de banda:
 *
 *   uint16 BE  longitud total de la región [3, 3+len)
 *   uint8      0x00
 *   string     tag
 *   content    uno o más elementos
 *
 * Cada elemento del content lleva un byte de tipo:
 *   0x00  string   -> uint16 BE longitud + UTF-8
 *   0x01  binary   -> uint16 BE longitud + bytes
 *   0x02  nodo     -> recursión (nodo WA anidado)
 */

import { Buffer } from 'node:buffer'
import { concat, readUInt16BE, readUInt8, writeUInt16BE } from '../util/buffer.ts'
import { ProtoError } from '../util/errors.ts'

export const ELEMENT_STRING = 0x00
export const ELEMENT_BINARY = 0x01
export const ELEMENT_NODE = 0x02

export type NodeContent = string | Buffer | BinaryNode
export type NodeTag = string

export class BinaryNode {
	readonly tag: NodeTag
	readonly attrs: Record<string, string | undefined>
	readonly content: NodeContent[]

	constructor(tag: NodeTag, attrs: Record<string, string | undefined> = {}, content: NodeContent[] = []) {
		this.tag = tag
		this.attrs = attrs
		this.content = content
	}

	get(key: string): string | undefined {
		return this.attrs[key]
	}

	/** Primer elemento que sea string, útil para `to`/`from`/`participant`. */
	stringAt(index: number): string | undefined {
		const item = this.content[index]
		return typeof item === 'string' ? item : undefined
	}

	binaryAt(index: number): Buffer | undefined {
		const item = this.content[index]
		return Buffer.isBuffer(item) ? item : undefined
	}

	/** Nodos hijos: elementos de tipo 0x02. */
	get nodes(): BinaryNode[] {
		return this.content.filter((c): c is BinaryNode => c instanceof BinaryNode)
	}

	toJSON(): [string, Record<string, unknown>, ...unknown[]] {
		return [
			this.tag,
			this.attrs,
			...this.content.map(c => (c instanceof BinaryNode ? c.toJSON() : c.toString('utf8')))
		]
	}

	encode(): Buffer {
		const parts: Buffer[] = []
		parts.push(writeString(this.tag))

		// Los attrs viajan como un string JSON con valores string o null.
		const jsonAttrs: Record<string, string | null> = {}
		for (const [k, v] of Object.entries(this.attrs)) jsonAttrs[k] = v ?? null
		parts.push(encodeElementString(JSON.stringify(jsonAttrs)))

		for (const item of this.content) {
			if (typeof item === 'string') parts.push(encodeElementString(item))
			else if (Buffer.isBuffer(item)) parts.push(encodeElementBinary(item))
			else parts.push(encodeNode(item))
		}

		const body = concat(...parts)
		const head = Buffer.alloc(3)
		writeUInt16BE(body.length, head, 0)
		head[2] = 0
		return concat(head, body)
	}

	static decode(buf: Uint8Array): BinaryNode {
		const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
		if (data.length < 3) throw new ProtoError('nodo binario demasiado corto')

		const total = readUInt16BE(data, 0)
		if (total === 0) throw new ProtoError('nodo binario con longitud 0')
		if (3 + total > data.length) {
			throw new ProtoError(`nodo truncado: declara ${total} bytes, hay ${data.length - 3}`)
		}

		let offset = 3
		const limit = 3 + total
		const tag = readString(data, offset)
		offset += 2 + tag.length

		// attrs: el primer elemento string del content es siempre el JSON
		const attrs = readAttrs(data, offset)
		offset += 2 + attrs.byteLength

		const content: NodeContent[] = []
		while (offset < limit) {
			const type = readUInt8(data, offset)
			offset++
			switch (type) {
				case ELEMENT_STRING: {
					const s = readString(data, offset)
					offset += 2 + s.length
					content.push(s)
					break
				}
				case ELEMENT_BINARY: {
					const len = readUInt16BE(data, offset)
					offset += 2
					if (offset + len > limit) throw new ProtoError('elemento binario truncado')
					content.push(data.subarray(offset, offset + len))
					offset += len
					break
				}
				case ELEMENT_NODE: {
					const len = readUInt16BE(data, offset)
					offset += 2
					if (offset + len > limit) throw new ProtoError('nodo anidado truncado')
					content.push(BinaryNode.decode(data.subarray(offset, offset + len)))
					offset += len
					break
				}
				default:
					throw new ProtoError(`tipo de elemento desconocido: 0x${type.toString(16)}`)
			}
		}

		return new BinaryNode(tag, attrs.value, content)
	}
}

function readAttrs(data: Buffer, offset: number): { value: Record<string, string | undefined>; byteLength: number } {
	const len = readUInt16BE(data, offset)
	const json = data.subarray(offset + 2, offset + 2 + len).toString('utf8')
	let value: Record<string, string | undefined> = {}
	if (json.length > 0) {
		try {
			value = JSON.parse(json) as Record<string, string | undefined>
		} catch {
			value = {}
		}
	}
	return { value, byteLength: len }
}

function readString(data: Buffer, offset: number): string {
	const len = readUInt16BE(data, offset)
	if (offset + 2 + len > data.length) throw new ProtoError('string truncado')
	return data.subarray(offset + 2, offset + 2 + len).toString('utf8')
}

function writeString(s: string): Buffer {
	const b = Buffer.from(s, 'utf8')
	const head = Buffer.alloc(2)
	writeUInt16BE(b.length, head, 0)
	return concat(head, b)
}

function encodeElementString(s: string): Buffer {
	return concat(Buffer.from([ELEMENT_STRING]), writeString(s))
}

function encodeElementBinary(b: Buffer): Buffer {
	const head = Buffer.alloc(2)
	writeUInt16BE(b.length, head, 0)
	return concat(Buffer.from([ELEMENT_BINARY]), head, b)
}

function encodeNode(node: BinaryNode): Buffer {
	const body = node.encode()
	const head = Buffer.alloc(2)
	writeUInt16BE(body.length, head, 0)
	return concat(Buffer.from([ELEMENT_NODE]), head, body)
}

/** Convierte la forma array-JSON que usa el cliente web a `BinaryNode`. */
export function nodeFromJson(input: unknown): BinaryNode {
	if (input instanceof BinaryNode) return input
	if (!Array.isArray(input) || input.length < 1) throw new ProtoError('nodo JSON inválido')
	const [tag, attrs, ...rest] = input as [string, Record<string, unknown>, ...unknown[]]
	const content: NodeContent[] = []
	for (const item of rest) {
		if (item === null || item === undefined) continue
		if (Array.isArray(item)) content.push(nodeFromJson(item))
		else if (typeof item === 'string') content.push(item)
		else if (item instanceof Uint8Array) content.push(Buffer.from(item))
		else content.push(Buffer.from(JSON.stringify(item), 'utf8'))
	}
	const cleanAttrs: Record<string, string | undefined> = {}
	for (const [k, v] of Object.entries(attrs ?? {})) {
		cleanAttrs[k] = v === null || v === undefined ? undefined : String(v)
	}
	return new BinaryNode(tag, cleanAttrs, content)
}
