/**
 * Tests del framing del WebSocket.
 *
 * El formato importa mucho: si la cabecera se lee mal, no hay forma de
 * distinguir un nodo de otro y todo falla en silencio. Estos tests fijan el
 * layout byte a byte para que un cambio accidental se note.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'

import {
	COMPRESSION_DEFLATE,
	COMPRESSION_NONE,
	FLAG_EXT16,
	FLAG_EXT32,
	FLAG_NO_EXT,
	MAX_SMALL,
	buildFrame,
	parsePayload,
	readFrameHeader,
	sliceFrame
} from '../src/transport/framing.ts'
import { parseFrames } from '../src/transport/websocket.ts'

test('un payload pequeño va con cabecera de 3 bytes y sin comprimir', () => {
	const payload = Buffer.from('hola')
	const frame = buildFrame(payload)

	// longitud en los 2 primeros bytes = payload (4) + byte de compresión (1)
	assert.equal(frame[0], 0x00)
	assert.equal(frame[1], 0x05)
	assert.equal(frame[2], FLAG_NO_EXT)
	assert.equal(frame[3], COMPRESSION_NONE)
	assert.equal(frame.subarray(4).toString(), 'hola')
	assert.equal(frame.length, 8)
})

test('la longitud de la cabecera cuenta el byte de compresión', () => {
	const frame = buildFrame(Buffer.alloc(100))
	const { headerSize, payloadSize } = readFrameHeader(frame)

	assert.equal(headerSize, 3)
	assert.equal(payloadSize, 101)
	assert.equal(frame.length, 3 + 101)
})

test('un payload grande se comprime y se marca con el byte de compresión', () => {
	// Muy repetitivo para que comprimir de verdad ahorre.
	const payload = Buffer.alloc(20000, 0x41)
	const frame = buildFrame(payload)

	assert.equal(frame[2], FLAG_NO_EXT)
	assert.equal(frame[3], COMPRESSION_DEFLATE)
	assert.ok(parsePayload(frame.subarray(3)).equals(payload))
	// y la longitud anunciada es la del cuerpo comprimido, no la del original
	assert.ok(readFrameHeader(frame).payloadSize < payload.length)
})

test('comprimir solo si mejora: si no, se manda plano', () => {
	// Datos realmente incompresibles: sin ellos deflate siempre 'gana'.
	const payload = randomBytes(9000)

	const frame = buildFrame(payload)
	assert.equal(frame[3], COMPRESSION_NONE, 'debería haber renunciado a comprimir')
	assert.ok(parsePayload(frame.subarray(3)).equals(payload))
})

test('forceCompressed comprime aunque el tamaño no lo pida', () => {
	const payload = Buffer.from('x'.repeat(50))
	const frame = buildFrame(payload, { forceCompressed: true })

	assert.equal(frame[3], COMPRESSION_DEFLATE)
	assert.ok(parsePayload(frame.subarray(3)).equals(payload))
})

test('un payload de más de 64 KiB usa Ext de 32 bits', () => {
	// Incompresible a propósito: así la longitud del cuerpo es la del payload.
	const payload = randomBytes(MAX_SMALL + 1)
	const frame = buildFrame(payload)

	assert.equal(frame[2], FLAG_EXT32)
	assert.equal(readFrame16(frame), 0, 'la longitud de 16 bits debe ser 0 para marcar Ext')
	assert.equal(readUInt32(frame, 3), payload.length + 1, 'Ext lleva la longitud del cuerpo tal cual va en el cable')
	assert.ok(parsePayload(frame.subarray(7)).equals(payload))
})

test('forceExtended usa Ext de 16 bits aunque no haga falta', () => {
	const frame = buildFrame(Buffer.from('corto'), { forceExtended: true })

	assert.equal(frame[2], FLAG_EXT16)
	assert.equal(readFrame16(frame), 0)
	assert.equal(frame.readUInt16BE(3), 6)
	assert.equal(parsePayload(frame.subarray(5)).toString(), 'corto')
})

test('round-trip de payloads de todos los tamaños', () => {
	const sizes = [0, 1, 255, 8191, 8192, 8193, 65534, 65535, 65536, 200000]
	for (const size of sizes) {
		const payload = Buffer.alloc(size, size & 0xff)
		const frame = buildFrame(payload)
		const { headerSize, payloadSize } = readFrameHeader(frame)

		assert.equal(payloadSize, frame.length - headerSize, `tamaño=${size}`)
		assert.deepEqual(parsePayload(frame.subarray(headerSize)), payload, `tamaño=${size}`)
	}
})

test('un byte de compresión desconocido es un error, no un payload', () => {
	assert.throws(
		() => parsePayload(Buffer.from([0x07, 1, 2, 3])),
		/compresión desconocido/
	)
})

test('un payload comprimido corrupto lanza en vez de devolver basura', () => {
	const roto = Buffer.concat([
		Buffer.from([COMPRESSION_DEFLATE]),
		deflateSync(Buffer.alloc(1000)).subarray(0, 5)
	])
	assert.throws(() => parsePayload(roto), /comprimido ilegible/)
})

test('varios frames en un mismo buffer se separan bien', () => {
	const a = buildFrame(Buffer.from('primero'))
	const b = buildFrame(Buffer.alloc(20000, 0x43))
	const juntos = Buffer.concat([a, b])

	const frames = [...parseFrames(juntos)]
	assert.equal(frames.length, 2)
	assert.equal(frames[0]!.toString(), 'primero')
	assert.equal(frames[1]!.length, 20000)
})

test('un frame a medias se queda esperando, no se lee corrupto', () => {
	const completo = buildFrame(Buffer.alloc(5000, 0x44))
	const truncado = completo.subarray(0, 2000)

	assert.equal([...parseFrames(truncado)].length, 0, 'no debe yield nada hasta tener el frame entero')

	// Y al llegar el resto sí se lee.
	assert.equal([...parseFrames(completo)].length, 1)
})

test('sliceFrame localiza el nth frame y dice cuánto consumió', () => {
	const primero = buildFrame(Buffer.from('uno'))
	const segundo = buildFrame(Buffer.from('dos'))
	const tercero = buildFrame(Buffer.from('tres'))
	const buffer = Buffer.concat([primero, segundo, tercero])

	assert.equal(parsePayload(sliceFrame(buffer, 0).payload).toString(), 'uno')
	assert.equal(sliceFrame(buffer, 0).consumed, primero.length)

	assert.equal(parsePayload(sliceFrame(buffer, 1).payload).toString(), 'dos')
	assert.equal(sliceFrame(buffer, 1).consumed, primero.length + segundo.length)

	assert.equal(parsePayload(sliceFrame(buffer, 2).payload).toString(), 'tres')
	assert.equal(sliceFrame(buffer, 2).consumed, buffer.length)
})

test('una cabecera incompleta no se interpreta', () => {
	assert.throws(() => readFrameHeader(Buffer.alloc(2)), /demasiado corto/)
	assert.throws(() => readFrameHeader(Buffer.from([0, 0, FLAG_EXT32, 0, 0])), /32 bits incompleto/)
	assert.throws(() => readFrameHeader(Buffer.from([0, 0, 0x09, 0, 0])), /flag de frame desconocido/)
})

function readFrame16(buf: Buffer): number {
	return buf.readUInt16BE(0)
}

function readUInt32(buf: Buffer, offset: number): number {
	return buf.readUInt32BE(offset)
}
