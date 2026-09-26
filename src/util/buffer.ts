import { Buffer } from 'node:buffer'

export function readUInt8(buf: Uint8Array, offset = 0): number {
	if (offset < 0 || offset >= buf.length) throw new RangeError('readUInt8 out of bounds')
	return buf[offset]!
}

export function readUInt16BE(buf: Uint8Array, offset = 0): number {
	if (offset < 0 || offset + 2 > buf.length) throw new RangeError('readUInt16BE out of bounds')
	return (buf[offset]! << 8) | buf[offset + 1]!
}

export function readUInt16LE(buf: Uint8Array, offset = 0): number {
	if (offset < 0 || offset + 2 > buf.length) throw new RangeError('readUInt16LE out of bounds')
	return (buf[offset + 1]! << 8) | buf[offset]!
}

export function readUInt24BE(buf: Uint8Array, offset = 0): number {
	if (offset < 0 || offset + 3 > buf.length) throw new RangeError('readUInt24BE out of bounds')
	return (buf[offset]! << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!
}

export function readUInt32BE(buf: Uint8Array, offset = 0): number {
	if (offset < 0 || offset + 4 > buf.length) throw new RangeError('readUInt32BE out of bounds')
	return (buf[offset]! * 0x1000000) + ((buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!)
}

export function readUInt64BE(buf: Uint8Array, offset = 0): bigint {
	if (offset < 0 || offset + 8 > buf.length) throw new RangeError('readUInt64BE out of bounds')
	return readBigUInt64BE(buf, offset)
}

export function readUInt32LE(buf: Uint8Array, offset = 0): number {
	if (offset < 0 || offset + 4 > buf.length) throw new RangeError('readUInt32LE out of bounds')
	return (buf[offset + 3]! << 24) | (buf[offset + 2]! << 16) | (buf[offset + 1]! << 8) | buf[offset]!
}

export function readBigUInt64BE(buf: Uint8Array, offset = 0): bigint {
	if (offset < 0 || offset + 8 > buf.length) throw new RangeError('readBigUInt64BE out of bounds')
	let value = 0n
	for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(buf[offset + i]!)
	return value
}

export function readBigUInt64LE(buf: Uint8Array, offset = 0): bigint {
	if (offset < 0 || offset + 8 > buf.length) throw new RangeError('readBigUInt64LE out of bounds')
	let value = 0n
	for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(buf[offset + i]!)
	return value
}

export function writeUInt8(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset >= buf.length) throw new RangeError('writeUInt8 out of bounds')
	buf[offset] = value & 0xff
}

export function writeUInt16BE(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 2 > buf.length) throw new RangeError('writeUInt16BE out of bounds')
	buf[offset] = (value >>> 8) & 0xff
	buf[offset + 1] = value & 0xff
}

export function writeUInt16LE(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 2 > buf.length) throw new RangeError('writeUInt16LE out of bounds')
	buf[offset] = value & 0xff
	buf[offset + 1] = (value >>> 8) & 0xff
}

export function writeUInt24BE(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 3 > buf.length) throw new RangeError('writeUInt24BE out of bounds')
	buf[offset] = (value >>> 16) & 0xff
	buf[offset + 1] = (value >>> 8) & 0xff
	buf[offset + 2] = value & 0xff
}

export function writeUInt32BE(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 4 > buf.length) throw new RangeError('writeUInt32BE out of bounds')
	buf[offset] = (value >>> 24) & 0xff
	buf[offset + 1] = (value >>> 16) & 0xff
	buf[offset + 2] = (value >>> 8) & 0xff
	buf[offset + 3] = value & 0xff
}

export function writeUInt32LE(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 4 > buf.length) throw new RangeError('writeUInt32LE out of bounds')
	buf[offset] = value & 0xff
	buf[offset + 1] = (value >>> 8) & 0xff
	buf[offset + 2] = (value >>> 16) & 0xff
	buf[offset + 3] = (value >>> 24) & 0xff
}

export function writeUInt64BE(value: bigint, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 8 > buf.length) throw new RangeError('writeUInt64BE out of bounds')
	let v = BigInt.asUintN(64, value)
	for (let i = 7; i >= 0; i--) {
		buf[offset + i] = Number(v & 0xffn)
		v >>= 8n
	}
}

export function writeBigUInt64LE(value: bigint, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 8 > buf.length) throw new RangeError('writeBigUInt64LE out of bounds')
	let v = BigInt.asUintN(64, value)
	for (let i = 0; i < 8; i++) {
		buf[offset + i] = Number(v & 0xffn)
		v >>= 8n
	}
}

export function writeUInt24LE(value: number, buf: Uint8Array, offset = 0): void {
	if (offset < 0 || offset + 3 > buf.length) throw new RangeError('writeUInt24LE out of bounds')
	buf[offset] = value & 0xff
	buf[offset + 1] = (value >>> 8) & 0xff
	buf[offset + 2] = (value >>> 16) & 0xff
}

export function encodeBigUInt64BE(value: bigint): Buffer {
	const buf = Buffer.alloc(8)
	writeUInt64BE(value, buf, 0)
	return buf
}

export function encodeBigUInt64LE(value: bigint): Buffer {
	const buf = Buffer.alloc(8)
	writeBigUInt64LE(value, buf, 0)
	return buf
}

export function decodeBigUInt64LE(buf: Uint8Array, offset = 0): bigint {
	return readBigUInt64LE(buf, offset)
}

/** Concatena buffers en uno solo sin copies intermedias innecesarias. */
export function concat(...bufs: Uint8Array[]): Buffer {
	return Buffer.concat(bufs.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength)))
}

export function areEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
	return diff === 0
}

export function toBuffer(data: Uint8Array | ArrayBuffer | ArrayBufferView): Buffer {
	if (Buffer.isBuffer(data)) return data
	if (data instanceof ArrayBuffer) return Buffer.from(data)
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export function toUint8Array(data: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export function base64ToBytes(b64: string): Buffer {
	return Buffer.from(b64, 'base64')
}

export function bytesToBase64(data: Uint8Array): string {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

export function base64UrlToBytes(b64url: string): Buffer {
	return Buffer.from(b64url, 'base64url')
}

export function bytesToBase64Url(data: Uint8Array): string {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64url')
}
