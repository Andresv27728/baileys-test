/**
 * Tests del codec protobuf propio.
 *
 * Lo que se comprueba aquí es que un objeto -> bytes -> objeto conserve los
 * datos y que los bytes sean los que un decodificador estándar esperaría.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { decode, defineSchema, encode, encodedSize, type ProtoObject } from '../src/proto/codec.ts'

const Scalar = defineSchema('Scalar', {
	int32: { type: 'int32', id: 1 },
	int64: { type: 'int64', id: 2 },
	uint32: { type: 'uint32', id: 3 },
	uint64: { type: 'uint64', id: 4 },
	sint32: { type: 'sint32', id: 5 },
	sint64: { type: 'sint64', id: 6 },
	bool: { type: 'bool', id: 7 },
	fixed32: { type: 'fixed32', id: 8 },
	fixed64: { type: 'fixed64', id: 9 },
	sfixed32: { type: 'sfixed32', id: 10 },
	sfixed64: { type: 'sfixed64', id: 11 },
	float: { type: 'float', id: 12 },
	double: { type: 'double', id: 13 },
	str: { type: 'string', id: 14 },
	bytes: { type: 'bytes', id: 15 },
	enumeration: { type: 'enum', id: 16 }
})

test('round-trip de escalares', () => {
	const input: ProtoObject = {
		int32: -1,
		int64: -2n,
		uint32: 3,
		uint64: 4n,
		sint32: -5,
		sint64: -6n,
		bool: true,
		fixed32: 0xdeadbeef,
		fixed64: 0x0123456789abcdefn,
		sfixed32: -2,
		sfixed64: -3n,
		float: 1.5,
		double: -2.25,
		str: 'hola ñ',
		bytes: Buffer.from([1, 2, 3, 255]),
		enumeration: 7
	}

	assert.deepEqual(decode(Scalar, encode(Scalar, input)), input)
})

test('los floats van como fixed32/fixed64, no como length-delimited', () => {
	const buf = encode(Scalar, { float: 1.5, double: 2.5 })

	// float: id 12, wire type 5 (fixed32) -> tag 0x65, luego 4 bytes
	assert.equal(buf[0], 0x65)
	assert.equal(buf.subarray(1, 5).readFloatBE(0), 1.5)

	// double: id 13, wire type 1 (fixed64) -> tag 0x69, luego 8 bytes
	assert.equal(buf[5], 0x69)
	assert.equal(buf.subarray(6, 14).readDoubleBE(0), 2.5)

	// 1+4 + 1+8 = 14 bytes: no hay varint de longitud en medio, que es
	// justo lo que fallaba cuando readDouble usaba lengthDelim().
	assert.equal(buf.length, 14)
})

test('encodedSize coincide con lo que genera encode', () => {
	const cases: ProtoObject[] = [
		{ int32: 1 },
		{ int32: 300 },
		{ int32: 1, str: 'x'.repeat(300) },
		{ bytes: Buffer.alloc(200, 7) },
		{ nested: undefined }
	]
	for (const obj of cases) {
		assert.equal(encodedSize(Scalar, obj), encode(Scalar, obj).length, JSON.stringify(obj))
	}
})

test('undefined y null se omiten; los ceros explícitos sí se escriben', () => {
	assert.equal(encode(Scalar, { int32: undefined, str: null }).length, 0)

	// Decisión del codec: si el valor está en el objeto se escribe, aunque sea
	// el cero del proto3. Es lo que espera el resto del ecosistema y nunca
	// rompe la decodificación; omitir un valor presente, sí.
	assert.equal(encode(Scalar, { int32: 0 }).length, 2)
	assert.equal(decode(Scalar, encode(Scalar, { int32: 0 })).int32, 0)
})

test('un bytes vacío sí se serializa (presencia explícita)', () => {
	const buf = encode(Scalar, { bytes: Buffer.alloc(0) })
	assert.equal(buf.length, 2)
	assert.deepEqual(decode(Scalar, buf).bytes, Buffer.alloc(0))
})

const Nested = defineSchema('Nested', {
	inner: { type: 'message', id: 1, msg: Scalar },
	others: { type: 'message', id: 2, msg: Scalar }
})

test('round-trip de mensajes anidados y repetidos', () => {
	const input: ProtoObject = {
		inner: { int32: 42, str: 'dentro' },
		others: [{ int32: 1 }, { int32: 2, str: 'segundo' }]
	}

	const out = decode(Nested, encode(Nested, input))
	assert.deepEqual(out, input)
})

test('un decodificador ignora campos desconocidos', () => {
	// El servidor puede añadir campos que este cliente no conoce; no deben
	// romper el decode.
	const conCampoExtra = Buffer.concat([encode(Scalar, { int32: 5 }), Buffer.from([0xf8, 0x3f, 0x2a])])
	assert.equal(decode(Scalar, conCampoExtra).int32, 5)
})

test('un buffer truncado lanza ProtoError en vez de devolver basura', () => {
	const completo = encode(Scalar, { str: 'hola' })
	assert.throws(() => decode(Scalar, completo.subarray(0, completo.length - 2)), /truncado|buffer/)
})

test('un varint de 64 bits con signo se interpreta bien', () => {
	// -1 en int64 son 10 bytes de varint todos con el bit alto puesto.
	const decoded = decode(Scalar, encode(Scalar, { int64: -1n }))
	assert.equal(decoded.int64, -1n)
	// Y un valor grande positivo no debe volverse negativo por desbordamiento.
	assert.equal(decode(Scalar, encode(Scalar, { uint64: 2n ** 63n })).uint64, 2n ** 63n)
})
