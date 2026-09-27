import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import {
	buildQrPayload,
	generatePairingCode,
	isValidPairingCode,
	normalizePairingCode,
	normalizePhoneNumber,
	parseQrPayload
} from '../src/socket/pairing.ts'
import { randomBytes } from '../src/crypto/primitives.ts'

test('el código de emparejamiento son 8 caracteres alfanuméricos', () => {
	for (let i = 0; i < 50; i++) {
		const code = generatePairingCode()
		assert.equal(code.length, 8, `"${code}" no mide 8`)
		assert.match(code, /^[A-Z0-9]{8}$/, `"${code}" tiene caracteres raros`)
	}
})

test('normalizar el código acepta minúsculas, guion y espacios', () => {
	assert.equal(normalizePairingCode('abcd-1234'), 'ABCD1234')
	assert.equal(normalizePairingCode('  abcd1234  '), 'ABCD1234')
	assert.equal(normalizePairingCode('ABCD-1234'), 'ABCD1234')
})

test('un código con longitud o caracteres inválidos se rechaza', () => {
	assert.throws(() => normalizePairingCode('ABC'), /8 caracteres/)
	assert.throws(() => normalizePairingCode('ABCDEFGH1'), /8 caracteres/)
	assert.throws(() => normalizePairingCode('ABCD-234!'), /8 caracteres/)
	assert.throws(() => normalizePairingCode(''), /8 caracteres/)
})

test('isValidPairingCode no lanza', () => {
	assert.equal(isValidPairingCode('ABCD1234'), true)
	assert.equal(isValidPairingCode('abcd 1234'), true)
	assert.equal(isValidPairingCode('ABC'), false)
	assert.equal(isValidPairingCode('ABCD12345'), false)
})

test('el payload del QR son 4 partes en base64url con el tamaño justo', () => {
	const payload = buildQrPayload({
		ref: randomBytes(16),
		noiseKey: randomBytes(32),
		identityKey: randomBytes(32),
		advSecretKey: randomBytes(32)
	})

	const parts = payload.split(',')
	assert.equal(parts.length, 4)
	for (const part of parts) {
		// base64url: no debe aparecer ni '+' ni '/'
		assert.doesNotMatch(part, /[+/]/)
	}
})

test('el payload del QR hace round-trip', () => {
	const original = {
		ref: randomBytes(16),
		noiseKey: randomBytes(32),
		identityKey: randomBytes(32),
		advSecretKey: randomBytes(32)
	}
	const parsed = parseQrPayload(buildQrPayload(original))

	assert.ok(parsed.ref.equals(original.ref), 'ref no cuadra')
	assert.ok(parsed.noiseKey.equals(original.noiseKey), 'noiseKey no cuadra')
	assert.ok(parsed.identityKey.equals(original.identityKey), 'identityKey no cuadra')
	assert.ok(parsed.advSecretKey.equals(original.advSecretKey), 'advSecretKey no cuadra')
})

test('un payload de QR malformado se rechaza con un motivo claro', () => {
	assert.throws(() => parseQrPayload('solo,tres'), /4 partes/)
	assert.throws(() => parseQrPayload('a,b,c,d'), /esperaba 16/)

	const wrongKey = buildQrPayload({
		ref: randomBytes(16),
		noiseKey: randomBytes(31),
		identityKey: randomBytes(32),
		advSecretKey: randomBytes(32)
	})
	assert.throws(() => parseQrPayload(wrongKey), /noiseKey/)
})

test('el teléfono se normaliza quitando lo que no es dígito', () => {
	assert.equal(normalizePhoneNumber('+34 600 11 22 33'), '+34600112233')
	assert.equal(normalizePhoneNumber('600112233'), '600112233')
	assert.equal(normalizePhoneNumber('  549 11 1234 5678 '), '5491112345678')
})

test('un teléfono con longitud rara se rechaza', () => {
	assert.throws(() => normalizePhoneNumber(''), /falta el número/)
	assert.throws(() => normalizePhoneNumber('123'), /no parece/)
	assert.throws(() => normalizePhoneNumber('1'.repeat(16)), /no parece/)
})
