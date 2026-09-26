/**
 * Codec protobuf escrito desde cero: sin `protobufjs`, sin generación de código.
 *
 * Se apoya en un sistema de tipos declarativo (`Schema`) en lugar de un
 * `.proto` compilado, porque el schema de WhatsApp es enorme y aquí sólo
 * necesitamos el subconjunto que realmente viaja por el socket.
 */

import { Buffer } from 'node:buffer'
import { concat, readBigUInt64BE, readBigUInt64LE, writeBigUInt64LE, writeUInt64BE } from '../util/buffer.ts'
import { ProtoError } from '../util/errors.ts'

export type ScalarType =
	| 'double' | 'float'
	| 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
	| 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64'
	| 'bool' | 'string' | 'bytes'

export interface FieldDef {
	/** tag del campo, obligatorio y único */
	id: number
	/** tipo escalar, `message`, `enum` o `map` */
	type: ScalarType | 'message' | 'enum' | 'map'
	/** nombre usado en el objeto JS */
	name: string
	/** el mensaje referenciado, cuando `type === 'message'` */
	msg?: Schema
	/** valor por defecto para enums, o valor 0 por defecto en el decode */
	def?: number
	/** mapa: tipo de la clave y del valor */
	keyType?: 'string' | 'int32' | 'int64' | 'uint32' | 'uint64' | 'bool'
	valType?: ScalarType | 'message' | 'enum'
	valMsg?: Schema
}

export interface Schema {
	name: string
	fields: Record<string, FieldDef>
	byId: Map<number, FieldDef>
}

const WIRE = {
	VARINT: 0,
	FIXED64: 1,
	LENGTH_DELIMITED: 2,
	START_GROUP: 3,
	END_GROUP: 4,
	FIXED32: 5
} as const

export function defineSchema(name: string, fields: Record<string, Omit<FieldDef, 'id' | 'name'> & { id?: number }>): Schema {
	let nextId = 1
	const out: Record<string, FieldDef> = {}
	for (const [fname, f] of Object.entries(fields)) {
		if (out[fname]) throw new Error(`campo duplicado "${fname}" en el mensaje ${name}`)
		const id = f.id ?? nextId
		out[fname] = { ...f, id, name: fname } as FieldDef
		nextId = Math.max(nextId, id) + 1
	}
	return { name, fields: out, byId: new Map(Object.values(out).map(f => [f.id, f])) }
}

/**
 * Crea un schema vacío y diferido, para romper ciclos de referencia
 * (`ContextInfo` <-> `Message`, `Message` <-> `MessageStub`...).
 */
export function lazySchema(name: string): Schema {
	const schema: Schema = { name, fields: {}, byId: new Map() }
	schema.fields = new Proxy({} as Record<string, FieldDef>, {
		set(target, key, value: FieldDef) {
			target[key as string] = value
			schema.byId.set(value.id, value)
			return true
		}
	})
	return schema
}

function varintSize(value: bigint): number {
	if (value < 0n) value = BigInt.asUintN(64, value)
	let n = 1
	while (value >= 0x80n) {
		value >>= 7n
		n++
	}
	return n
}

function tagSize(id: number, wire: number): number {
	return varintSize(BigInt((id << 3) | wire))
}

function wireTypeOf(field: FieldDef): number {
	switch (field.type) {
		case 'double': case 'fixed64': case 'sfixed64':
			return WIRE.FIXED64
		case 'float': case 'fixed32': case 'sfixed32':
			return WIRE.FIXED32
		case 'string': case 'bytes': case 'message': case 'map':
			return WIRE.LENGTH_DELIMITED
		default:
			return WIRE.VARINT
	}
}

/** Tamaño en bytes que ocupará un campo al serializar. */
function fieldSize(field: FieldDef, value: unknown): number {
	const wt = wireTypeOf(field)
	const header = tagSize(field.id, wt)
	if (wt === WIRE.VARINT) {
		const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0))
		return header + varintSize(v)
	}
	if (wt === WIRE.FIXED64) return header + 8
	if (wt === WIRE.FIXED32) return header + 4
	const body = field.type === 'message'
		? encode(field.msg!, value as Record<string, unknown>).length
		: field.type === 'map'
			? mapSize(field, value as Record<string, unknown>)
			: field.type === 'string'
				? Buffer.byteLength(String(value), 'utf8')
				: (value as Uint8Array).length
	return header + varintSize(BigInt(body)) + body
}

function mapSize(field: FieldDef, map: Record<string, unknown>): number {
	let total = 0
	for (const [k, v] of Object.entries(map ?? {})) {
		if (v === undefined || v === null) continue
		total += 2 + mapEntrySize(field, k, v)
	}
	return total
}

function mapEntrySize(field: FieldDef, key: unknown, value: unknown): number {
	let size = 0
	if (key !== '' && key !== undefined) size += 1 + varintSize(BigInt(0)) + keyStrSize(key)
	const v = value
	switch (field.valType) {
		case 'message':
			size += tagSize(2, WIRE.LENGTH_DELIMITED) + varintSize(BigInt(encode(field.valMsg!, v as Record<string, unknown>).length)) + encode(field.valMsg!, v as Record<string, unknown>).length
			break
		case 'string':
			size += tagSize(2, WIRE.LENGTH_DELIMITED) + varintSize(BigInt(Buffer.byteLength(String(v), 'utf8'))) + Buffer.byteLength(String(v), 'utf8')
			break
		case 'bytes':
			size += tagSize(2, WIRE.LENGTH_DELIMITED) + varintSize(BigInt((v as Uint8Array).length)) + (v as Uint8Array).length
			break
		case 'bool':
			if (v) size += tagSize(2, WIRE.VARINT) + 1
			break
		default:
			size += tagSize(2, WIRE.VARINT) + varintSize(BigInt(Math.trunc(Number(v))))
	}
	return size
}

function keyStrSize(key: unknown): number {
	const s = typeof key === 'string' ? key : String(key)
	const len = Buffer.byteLength(s, 'utf8')
	return tagSize(1, WIRE.LENGTH_DELIMITED) + varintSize(BigInt(len)) + len
}

function writeVarint(value: bigint, out: number[]): void {
	let v = BigInt.asUintN(64, value)
	while (v >= 0x80n) {
		out.push(Number(v & 0x7fn) | 0x80)
		v >>= 7n
	}
	out.push(Number(v))
}

function writeKey(id: number, wire: number, out: number[]): void {
	writeVarint(BigInt((id << 3) | wire), out)
}

function writeScalar(field: FieldDef, value: unknown, out: number[]): void {
	switch (field.type) {
		case 'double': {
			const b = Buffer.allocUnsafe(8)
			b.writeDoubleBE(Number(value), 0)
			for (const byte of b) out.push(byte)
			break
		}
		case 'float': {
			const b = Buffer.allocUnsafe(4)
			b.writeFloatBE(Number(value), 0)
			for (const byte of b) out.push(byte)
			break
		}
		case 'fixed64': case 'sfixed64': {
			const b = Buffer.allocUnsafe(8)
			if (field.type === 'sfixed64') b.writeBigInt64BE(BigInt(value as bigint | number), 0)
			else writeUInt64BE(BigInt(value as bigint | number), b, 0)
			for (const byte of b) out.push(byte)
			break
		}
		case 'fixed32': case 'sfixed32': {
			const b = Buffer.allocUnsafe(4)
			if (field.type === 'sfixed32') b.writeInt32BE(Number(value), 0)
			else b.writeUInt32BE(Number(value) >>> 0, 0)
			for (const byte of b) out.push(byte)
			break
		}
		case 'bool':
			writeVarint(value ? 1n : 0n, out)
			break
		case 'string': {
			const b = Buffer.from(String(value), 'utf8')
			writeVarint(BigInt(b.length), out)
			for (const byte of b) out.push(byte)
			break
		}
		case 'bytes': {
			const b = Buffer.isBuffer(value) ? value : Buffer.from((value as Uint8Array).buffer, (value as Uint8Array).byteOffset, (value as Uint8Array).byteLength)
			writeVarint(BigInt(b.length), out)
			for (const byte of b) out.push(byte)
			break
		}
		case 'uint64': case 'int64': case 'sint64': {
			let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)))
			if (field.type === 'int64') v = BigInt.asIntN(64, v)
			if (field.type === 'sint64') v = zigzagEncode(v)
			writeVarint(v, out)
			break
		}
		case 'sint32': {
			writeVarint(zigzagEncode(BigInt(Math.trunc(Number(value)))), out)
			break
		}
		case 'enum':
			writeVarint(BigInt(Math.trunc(Number(value))), out)
			break
		default:
			writeVarint(BigInt(Math.trunc(Number(value))), out)
	}
}

function zigzagEncode(v: bigint): bigint {
	return v < 0n ? ((-v) << 1n) - 1n : v << 1n
}

function zigzagDecode(v: bigint): bigint {
	return v % 2n === 0n ? v >> 1n : -((v + 1n) >> 1n)
}

class Reader {
	private pos = 0
	private readonly buf: Buffer

	constructor(buf: Buffer) {
		this.buf = buf
	}

	get remaining(): number { return this.buf.length - this.pos }
	get offset(): number { return this.pos }

	private need(n: number): void {
		if (this.pos + n > this.buf.length) throw new ProtoError('buffer protobuf truncado')
	}

	uint8(): number { this.need(1); return this.buf[this.pos++]! }
	varint(): bigint {
		let result = 0n
		let shift = 0n
		for (;;) {
			const b = this.uint8()
			result |= BigInt(b & 0x7f) << shift
			if ((b & 0x80) === 0) break
			shift += 7n
			if (shift > 70n) throw new ProtoError('varint demasiado largo')
		}
		return result
	}
	tag(): { id: number; wire: number } {
		const t = Number(this.varint())
		return { id: t >>> 3, wire: t & 0x07 }
	}
	fixed32(): number { this.need(4); const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v }
	fixed64(): bigint { this.need(8); const v = readBigUInt64BE(this.buf, this.pos); this.pos += 8; return v }
	/** Los `n` bytes siguientes, sin interpretar. Necesario para float/double. */
	raw(n: number): Buffer { this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b }
	lengthDelim(): Buffer { const len = Number(this.varint()); this.need(len); const b = this.buf.subarray(this.pos, this.pos + len); this.pos += len; return b }
	skip(wire: number): void {
		switch (wire) {
			case WIRE.VARINT: this.varint(); break
			case WIRE.FIXED64: this.need(8); this.pos += 8; break
			case WIRE.LENGTH_DELIMITED: this.lengthDelim(); break
			case WIRE.FIXED32: this.need(4); this.pos += 4; break
			case WIRE.START_GROUP:
				for (;;) {
					const t = this.tag()
					if (t.wire === WIRE.END_GROUP) break
					this.skip(t.wire)
				}
				break
			default: throw new ProtoError(`wire type desconocido: ${wire}`)
		}
	}
}

function readScalar(field: FieldDef, reader: Reader, wire: number): unknown {
	switch (field.type) {
		case 'double': return readDouble(reader)
		case 'float': return readFloat(reader)
		case 'fixed64': return reader.fixed64()
		case 'sfixed64': { const v = reader.fixed64(); return BigInt.asIntN(64, v) }
		case 'fixed32': return reader.fixed32()
		case 'sfixed32': return reader.fixed32() | 0
		case 'bool': return reader.varint() !== 0n
		case 'string': return reader.lengthDelim().toString('utf8')
		case 'bytes': return Buffer.from(reader.lengthDelim())
		case 'int64': return BigInt.asIntN(64, reader.varint())
		case 'uint64': return BigInt.asUintN(64, reader.varint())
		case 'sint64': return zigzagDecode(reader.varint())
		case 'sint32': return Number(zigzagDecode(reader.varint()))
		case 'enum': return Number(reader.varint())
		case 'int32': case 'uint32': {
			const v = reader.varint()
			return field.type === 'int32' ? Number(BigInt.asIntN(32, v)) : Number(BigInt.asUintN(32, v))
		}
		default:
			reader.skip(wire)
			return undefined
	}
}

function need(reader: Reader, n: number): void {
	if (reader.remaining < n) throw new ProtoError('buffer truncado')
}

function readDouble(reader: Reader): number {
	return reader.raw(8).readDoubleBE(0)
}

function readFloat(reader: Reader): number {
	return reader.raw(4).readFloatBE(0)
}

export type ProtoObject = Record<string, unknown>

/**
 * Serializa un objeto plano siguiendo el schema.
 * Los campos `undefined`/`null` se omiten (regla proto3 por defecto).
 */
export function encode(schema: Schema, obj: ProtoObject): Buffer {
	const bytes: number[] = []
	for (const [fname, value] of Object.entries(obj ?? {})) {
		if (value === undefined || value === null) continue
		const field = schema.fields[fname]
		if (!field) continue

		if (field.type === 'map') {
			const map = value as Record<string, unknown>
			for (const [k, v] of Object.entries(map ?? {})) {
				if (v === undefined || v === null) continue
				const entrySize = mapEntrySize(field, k, v)
				writeKey(field.id, WIRE.LENGTH_DELIMITED, bytes)
				writeVarint(BigInt(entrySize), bytes)
				writeMapEntry(field, k, v, bytes)
			}
			continue
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				if (item === undefined || item === null) continue
				if (field.type === 'message') {
					const sub = encode(field.msg!, item as ProtoObject)
					writeKey(field.id, WIRE.LENGTH_DELIMITED, bytes)
					writeVarint(BigInt(sub.length), bytes)
					for (const b of sub) bytes.push(b)
				} else {
					writeKey(field.id, wireTypeOf(field), bytes)
					writeScalar(field, item, bytes)
				}
			}
			continue
		}

		if (field.type === 'message') {
			const sub = encode(field.msg!, value as ProtoObject)
			writeKey(field.id, WIRE.LENGTH_DELIMITED, bytes)
			writeVarint(BigInt(sub.length), bytes)
			for (const b of sub) bytes.push(b)
		} else {
			writeKey(field.id, wireTypeOf(field), bytes)
			writeScalar(field, value, bytes)
		}
	}
	return Buffer.from(bytes)
}

function writeMapEntry(field: FieldDef, key: unknown, value: unknown, out: number[]): void {
	if (key !== '' && key !== undefined && key !== null) {
		const s = typeof key === 'string' ? key : String(key)
		writeKey(1, WIRE.LENGTH_DELIMITED, out)
		writeVarint(BigInt(Buffer.byteLength(s, 'utf8')), out)
		for (const b of Buffer.from(s, 'utf8')) out.push(b)
	}
	switch (field.valType) {
		case 'message': {
			const sub = encode(field.valMsg!, value as ProtoObject)
			writeKey(2, WIRE.LENGTH_DELIMITED, out)
			writeVarint(BigInt(sub.length), out)
			for (const b of sub) out.push(b)
			break
		}
		case 'string': {
			const b = Buffer.from(String(value), 'utf8')
			writeKey(2, WIRE.LENGTH_DELIMITED, out)
			writeVarint(BigInt(b.length), out)
			for (const byte of b) out.push(byte)
			break
		}
		case 'bytes': {
			const b = Buffer.from((value as Uint8Array).buffer, (value as Uint8Array).byteOffset, (value as Uint8Array).byteLength)
			writeKey(2, WIRE.LENGTH_DELIMITED, out)
			writeVarint(BigInt(b.length), out)
			for (const byte of b) out.push(byte)
			break
		}
		case 'bool':
			if (value) { writeKey(2, WIRE.VARINT, out); out.push(1) }
			break
		default:
			writeKey(2, WIRE.VARINT, out)
			writeVarint(BigInt(Math.trunc(Number(value))), out)
	}
}

/** Decodifica un buffer siguiendo el schema. Los campos ausentes quedan `undefined`. */
export function decode<T extends ProtoObject = ProtoObject>(schema: Schema, buf: Uint8Array): T {
	const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
	const reader = new Reader(data)
	const out: ProtoObject = {}

	while (reader.remaining > 0) {
		const { id, wire } = reader.tag()
		const field = schema.byId.get(id)
		if (!field) { reader.skip(wire); continue }

		if (field.type === 'map') {
			const entry = reader.lengthDelim()
			assignInto(out, field, readMapEntry(field, entry))
			continue
		}

		if (field.type === 'message') {
			const sub = decode(field.msg!, reader.lengthDelim())
			assignInto(out, field, sub)
			continue
		}

		const value = readScalar(field, reader, wire)
		if (value !== undefined) assignInto(out, field, value)
	}

	return out as T
}

function readMapEntry(field: FieldDef, buf: Buffer): [string, unknown] {
	const reader = new Reader(buf)
	let key = ''
	let value: unknown
	while (reader.remaining > 0) {
		const { id, wire } = reader.tag()
		if (id === 1) { key = reader.lengthDelim().toString('utf8'); continue }
		if (id === 2) {
			switch (field.valType) {
				case 'message': value = decode(field.valMsg!, reader.lengthDelim()); break
				case 'string': value = reader.lengthDelim().toString('utf8'); break
				case 'bytes': value = Buffer.from(reader.lengthDelim()); break
				case 'bool': value = reader.varint() !== 0n; break
				default: value = Number(reader.varint())
			}
			continue
		}
		reader.skip(wire)
	}
	return [key, value]
}

function assignInto(target: ProtoObject, field: FieldDef, value: unknown): void {
	const existing = target[field.name]
	if (existing === undefined) {
		target[field.name] = value
	} else if (Array.isArray(existing)) {
		existing.push(value)
	} else {
		target[field.name] = [existing, value]
	}
}

/** Calcula el tamaño serializado sin reservar memoria (útil para el framing WS). */
export function encodedSize(schema: Schema, obj: ProtoObject): number {
	let total = 0
	for (const [fname, value] of Object.entries(obj ?? {})) {
		if (value === undefined || value === null) continue
		const field = schema.fields[fname]
		if (!field) continue
		if (field.type === 'map') {
			const wt = WIRE.LENGTH_DELIMITED
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (v === undefined || v === null) continue
				total += tagSize(field.id, wt) + varintSize(BigInt(mapEntrySize(field, k, v))) + mapEntrySize(field, k, v)
			}
			continue
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item === undefined || item === null) continue
				total += fieldSize(field, item)
			}
			continue
		}
		total += fieldSize(field, value)
	}
	return total
}

export function concatBuffers(...bufs: Uint8Array[]): Buffer {
	return concat(...bufs)
}

export { readBigUInt64LE, writeBigUInt64LE }
