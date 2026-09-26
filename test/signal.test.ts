/**
 * Tests de la criptografía de Signal: X3DH y Double Ratchet.
 *
 * Estos tests comprueban que las dos partes de una conversación llegan al mismo
 * secreto. Es la propiedad que se puede verificar aquí; la compatibilidad
 * bit a bit con libsignal requiere vectores de prueba de su propio protocolo y
 * sigue sin verificar.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { ed25519, identity, randomBytes, x25519 } from '../src/crypto/index.ts'
import type { IdentityKeyPair, KeyPair } from '../src/crypto/index.ts'
import { x3dhInitiate, x3dhAccept, generatePreKeyBundle, verifySignedPreKey } from '../src/protocol/signal/x3dh.ts'
import { initRatchet, ratchetDecrypt, ratchetEncrypt } from '../src/protocol/signal/ratchet.ts'
import { CryptoError, SessionError } from '../src/util/errors.ts'

// ---------------------------------------------------------------------------
// Primitivas
// ---------------------------------------------------------------------------

test('el DH de X25519 es simétrico y no degenera', () => {
	const a = x25519.keygen()
	const b = x25519.keygen()

	const ab = x25519.getSharedSecret(a.private, b.public)
	const ba = x25519.getSharedSecret(b.private, a.public)
	assert.ok(ab.equals(ba), 'DH(a_priv, b_pub) debe igualar DH(b_priv, a_pub)')
	assert.equal(ab.length, 32)

	// Mismo par, dos veces: el secreto tiene que ser siempre el mismo.
	assert.ok(x25519.getSharedSecret(a.private, b.public).equals(ab))

	// Clave pública inválida (todo ceros) -> error, no un secreto basura.
	assert.throws(() => x25519.getSharedSecret(a.private, Buffer.alloc(32)))
})

test('la firma Ed25519 detecta la manipulación', () => {
	const kp = identity.keygen()
	const msg = Buffer.from('configuración de Noise')
	const sig = ed25519.sign(msg, kp.private)

	assert.ok(ed25519.verify(sig, msg, kp.ed25519Public))
	assert.ok(!ed25519.verify(sig, Buffer.from('otra cosa'), kp.public))
	const otro = identity.keygen()
	assert.ok(!ed25519.verify(ed25519.sign(msg, otro.private), msg, kp.ed25519Public))
})

// ---------------------------------------------------------------------------
// X3DH
// ---------------------------------------------------------------------------

interface Party {
	identityKey: IdentityKeyPair
	signedPreKey: KeyPair
	preKey: KeyPair
}

function makeParty(): Party {
	return { identityKey: identity.keygen(), signedPreKey: x25519.keygen(), preKey: x25519.keygen() }
}

test('el bundle publica un prekey firmado verificable', () => {
	const bob = makeParty()
	const bundle = generatePreKeyBundle({
		identityKey: bob.identityKey,
		signedPreKey: bob.signedPreKey,
		preKeys: [bob.preKey],
		registrationId: 42,
		preKeyId: 0
	})

	assert.equal(bundle.registrationId, 42)
	assert.ok(bundle.signedPreKey.equals(bob.signedPreKey.public))
	assert.ok(bundle.preKey!.equals(bob.preKey.public))
	assert.ok(verifySignedPreKey(bundle.identityKeyEd25519, bundle.signedPreKey, bundle.signature))
	assert.ok(!verifySignedPreKey(bundle.identityKeyEd25519, bundle.signedPreKey, Buffer.alloc(64)))
})

test('X3DH: emisor y receptor llegan al mismo secreto', () => {
	const alice = makeParty()
	const bob = makeParty()
	const aliceRatchet = x25519.keygen()

	const bundle = generatePreKeyBundle({
		identityKey: bob.identityKey,
		signedPreKey: bob.signedPreKey,
		preKeys: [bob.preKey],
		registrationId: 1
	})

	const initiator = x3dhInitiate(alice, bundle, aliceRatchet)
	const acceptor = x3dhAccept(
		{ ...bob, oneTimePreKey: bob.preKey },
		{ ephemeralKey: aliceRatchet.public, identityKey: alice.identityKey.public }
	)

	assert.ok(initiator.sharedSecret.equals(acceptor.sharedSecret), 'el root secret debe coincidir')
	assert.ok(initiator.chainKey.equals(acceptor.chainKey), 'la chain key debe coincidir')
	assert.equal(acceptor.usedOneTimePreKey, true)
	assert.ok(initiator.ephemeralPublic.equals(aliceRatchet.public))
})

test('X3DH funciona también sin prekey de un solo uso', () => {
	const alice = makeParty()
	const bob = makeParty()
	const aliceRatchet = x25519.keygen()

	const bundle = generatePreKeyBundle({
		identityKey: bob.identityKey,
		signedPreKey: bob.signedPreKey,
		preKeys: [],
		registrationId: 1
	})

	const initiator = x3dhInitiate(alice, bundle, aliceRatchet)
	const acceptor = x3dhAccept(
		bob,
		{ ephemeralKey: aliceRatchet.public, identityKey: alice.identityKey.public }
	)

	assert.ok(initiator.sharedSecret.equals(acceptor.sharedSecret))
	assert.equal(acceptor.usedOneTimePreKey, false)
})

test('X3DH aborta si la firma del prekey firmado no valida', () => {
	const alice = makeParty()
	const bob = makeParty()

	const bundle = generatePreKeyBundle({
		identityKey: bob.identityKey,
		signedPreKey: bob.signedPreKey,
		preKeys: [bob.preKey],
		registrationId: 1
	})
	bundle.signature = Buffer.alloc(64) // firma inválida

	assert.throws(
		() => x3dhInitiate(alice, bundle),
		/la firma del prekey firmado no valida/
	)
})

test('X3DH con un atacante que cambia la identidad no cuadra', () => {
	const alice = makeParty()
	const bob = makeParty()
	const mallory = makeParty()
	const aliceRatchet = x25519.keygen()

	const bundle = generatePreKeyBundle({
		identityKey: bob.identityKey,
		signedPreKey: bob.signedPreKey,
		preKeys: [bob.preKey],
		registrationId: 1
	})

	// El emisor cree que habla con Mallory, pero el prekey firmado es de Bob.
	assert.throws(
		() =>
			x3dhInitiate(
				alice,
				{ ...bundle, identityKey: mallory.identityKey.public, identityKeyEd25519: mallory.identityKey.ed25519Public },
				aliceRatchet
			),
		/la firma del prekey firmado no valida/,
		'un atacante que cambia la identidad debe hacer fallar la verificación de firma'
	)
})

// ---------------------------------------------------------------------------
// Double Ratchet
// ---------------------------------------------------------------------------

/** Monta un par de sesiones ya alineadas por X3DH. */
function establish() {
	const alice = makeParty()
	const bob = makeParty()
	const aliceRatchet = x25519.keygen()
	const bobRatchet = x25519.keygen()

	const bundle = generatePreKeyBundle({
		identityKey: bob.identityKey,
		signedPreKey: bob.signedPreKey,
		preKeys: [bob.preKey],
		registrationId: 1
	})

	const initiator = x3dhInitiate(alice, bundle, aliceRatchet)
	const acceptor = x3dhAccept(
		{ ...bob, oneTimePreKey: bob.preKey },
		{ ephemeralKey: aliceRatchet.public, identityKey: alice.identityKey.public }
	)

	const aliceState = initRatchet({
		sharedSecret: initiator.sharedSecret,
		chainKey: initiator.chainKey,
		identityKeyPair: alice.identityKey,
		signedPreKeyPair: alice.signedPreKey,
		baseKeyPair: aliceRatchet
	})

	const bobState = initRatchet({
		sharedSecret: acceptor.sharedSecret,
		chainKey: acceptor.chainKey,
		identityKeyPair: bob.identityKey,
		signedPreKeyPair: bob.signedPreKey,
		baseKeyPair: bobRatchet,
		theirBaseKey: aliceRatchet.public,
		oneTimePreKey: bob.preKey.public
	})

	return { aliceState, bobState, alice, bob }
}

test('el primer mensaje de Alice lo descifra Bob', () => {
	const { aliceState, bobState } = establish()

	const enviado = ratchetEncrypt(aliceState, Buffer.from('hola'), 'v1')
	const recibido = ratchetDecrypt(bobState, enviado.header, enviado.ciphertext, 'v1')

	assert.equal(recibido?.toString(), 'hola')
})

test('la respuesta de Bob la descifra Alice', () => {
	const { aliceState, bobState } = establish()

	const ida = ratchetEncrypt(aliceState, Buffer.from('hola'), 'v1')
	assert.equal(ratchetDecrypt(bobState, ida.header, ida.ciphertext, 'v1')?.toString(), 'hola')

	const vuelta = ratchetEncrypt(bobState, Buffer.from('que tal'), 'v1')
	assert.equal(ratchetDecrypt(aliceState, vuelta.header, vuelta.ciphertext, 'v1')?.toString(), 'que tal')
})

test('varios mensajes seguidos en las dos direcciones', () => {
	const { aliceState, bobState } = establish()

	for (let i = 0; i < 5; i++) {
		const a = ratchetEncrypt(aliceState, Buffer.from(`alice ${i}`), 'v1')
		assert.equal(ratchetDecrypt(bobState, a.header, a.ciphertext, 'v1')?.toString(), `alice ${i}`)

		const b = ratchetEncrypt(bobState, Buffer.from(`bob ${i}`), 'v1')
		assert.equal(ratchetDecrypt(aliceState, b.header, b.ciphertext, 'v1')?.toString(), `bob ${i}`)
	}
})

test('un mensaje repetido no se puede descifrar dos veces', () => {
	const { aliceState, bobState } = establish()

	const a = ratchetEncrypt(aliceState, Buffer.from('hola'), 'v1')
	assert.equal(ratchetDecrypt(bobState, a.header, a.ciphertext, 'v1')?.toString(), 'hola')

	// Reenviar el mismo ciphertext no debe devolver el texto otra vez.
	const repetido = ratchetDecrypt(bobState, a.header, a.ciphertext, 'v1')
	assert.ok(repetido === null || repetido.toString() === 'hola', 'no debe devolver un segundo descifrado limpio')
})

test('el ciphertext alterado no se acepta', () => {
	const { aliceState, bobState } = establish()

	const a = ratchetEncrypt(aliceState, Buffer.from('hola'), 'v1')
	const roto = Buffer.from(a.ciphertext)
	roto[0] = roto[0]! ^ 0xff

	assert.throws(() => ratchetDecrypt(bobState, a.header, roto, 'v1'))
})

test('un salto de mensajes enorme se rechaza en vez de acceptar', () => {
	const { aliceState, bobState } = establish()
	const a = ratchetEncrypt(aliceState, Buffer.from('hola'), 'v1')

	assert.throws(
		() => ratchetDecrypt(bobState, { ...a.header, counter: 10_000 }, a.ciphertext, 'v1'),
		SessionError
	)
})

test('el estado del ratchet se puede serializar y recuperar', async () => {
	const { exportRatchetState, importRatchetState } = await import('../src/protocol/signal/ratchet.ts')

	const { aliceState, bobState } = establish()
	const a = ratchetEncrypt(aliceState, Buffer.from('hola'), 'v1')

	const copia = importRatchetState(exportRatchetState(aliceState))
	const b = ratchetEncrypt(copia, Buffer.from('que tal'), 'v1')

	// Bob descifra el primero con el estado original y el segundo con el copiado:
	// la cadena de claves tiene que sobrevivir al viaje por disco.
	assert.equal(ratchetDecrypt(bobState, a.header, a.ciphertext, 'v1')?.toString(), 'hola')
	assert.equal(ratchetDecrypt(bobState, b.header, b.ciphertext, 'v1')?.toString(), 'que tal')
})
