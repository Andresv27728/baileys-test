/**
 * X3DH: Triple Diffie-Hellman de Signal.
 *
 * Establece el secreto compartido usando el prekey firmado del destinatario,
 * de modo que el primer mensaje ya viaja cifrado sin una ronda previa.
 *
 * Lado emisor (`x3dhInitiate`):
 *   DH1 = DH(IK_a, SPK_b)
 *   DH2 = DH(EK_a, IK_b)
 *   DH3 = DH(EK_a, SPK_b)
 *   DH4 = DH(EK_a, OPK_b)
 *
 * Lado receptor (`x3dhAccept`) computa exactamente los mismos cuatro valores
 * invirtiendo el orden de los operandos en cada par. El orden de concatenación
 * `F || DH1 || DH2 || DH3 || DH4` es fijo: cambiarlo rompe la compatibilidad.
 */

import { Buffer } from 'node:buffer'
import { concat } from '../../util/buffer.ts'
import { CryptoError } from '../../util/errors.ts'
import {
	ed25519, hkdf, x25519, KEY_LENGTH,
	type Bytes, type IdentityKeyPair, type KeyPair
} from '../../crypto/primitives.ts'

const X3DH_INFO = Buffer.from('WhisperRatchet', 'utf8')
export const ROOT_KEY_LENGTH = 32
export const CHAIN_KEY_LENGTH = 32

export interface PreKeyBundleRemote {
	registrationId: number
	preKeyId: number
	signedPreKeyId: number
	signedPreKey: Bytes
	signature: Bytes
	/** pública de la identidad en forma Montgomery, la que se usa para el DH */
	identityKey: Bytes
	/** pública de la misma identidad en forma Ed25519, para validar la firma */
	identityKeyEd25519: Bytes
	/** prekey de un solo uso; si falta se usan 32 ceros como DH4 */
	preKey?: Bytes
}

export interface InitiateResult {
	/** secret raíz que inicializa el Double Ratchet */
	sharedSecret: Bytes
	/** cadena de mensajes inicial */
	chainKey: Bytes
	/** clave efímera del emisor, viaja en el PreSignalMessage */
	ephemeralPublic: Buffer
	/** identidad del emisor en Montgomery, la que se usa para el DH */
	identityKey: Buffer
	/** la misma identidad en Ed25519, para que el receptor valide la firma */
	identityKeyEd25519: Buffer
	/** prekey de un solo uso consumido, para borrarlo del store */
	consumedPreKeyId: number
}

export interface AcceptResult {
	sharedSecret: Bytes
	chainKey: Bytes
	/** id del prekey consumido, para borrarlo del store */
	consumedPreKeyId: number
	usedOneTimePreKey: boolean
}

/**
 * Verifica que el prekey firmado lo firmó la identidad que se dice.
 * Sin esta comprobación un atacante podría inyectar su propio SPK y hacer MITM.
 */
export function verifySignedPreKey(identityKeyEd25519: Bytes, signedPreKey: Bytes, signature: Bytes): boolean {
	return ed25519.verify(signature, signedPreKey, identityKeyEd25519)
}

/** Lado emisor. */
export function x3dhInitiate(
	own: { identityKey: IdentityKeyPair; signedPreKey: KeyPair },
	remote: PreKeyBundleRemote,
	ephemeral: KeyPair = x25519.keygen()
): InitiateResult {
	if (!verifySignedPreKey(remote.identityKeyEd25519, remote.signedPreKey, remote.signature)) {
		throw new CryptoError('la firma del prekey firmado no valida contra la identidad del destinatario')
	}

	const IK = own.identityKey.private
	const SPK = own.signedPreKey.private
	const EK = ephemeral.private

	const F = remote.preKey ? Buffer.alloc(0) : Buffer.alloc(KEY_LENGTH)
	const material = concat(
		F,
		x25519.getSharedSecret(IK, remote.signedPreKey),   // DH1 = DH(IK_a, SPK_b)
		x25519.getSharedSecret(EK, remote.identityKey),     // DH2 = DH(EK_a, IK_b)
		x25519.getSharedSecret(EK, remote.signedPreKey),    // DH3 = DH(EK_a, SPK_b)
		remote.preKey
			? x25519.getSharedSecret(EK, remote.preKey)     // DH4 = DH(EK_a, OPK_b)
			: Buffer.alloc(KEY_LENGTH)
	)

	const sharedSecret = hkdf(material, ROOT_KEY_LENGTH)
	const chainKey = hkdf(sharedSecret, CHAIN_KEY_LENGTH, Buffer.alloc(0), X3DH_INFO)

	return {
		sharedSecret,
		chainKey,
		ephemeralPublic: ephemeral.public,
		identityKey: own.identityKey.public,
		identityKeyEd25519: own.identityKey.ed25519Public,
		consumedPreKeyId: remote.preKeyId
	}
}

/**
 * Lado receptor.
 * `own` son las claves propias; `remote` las del emisor que venían en el
 * PreSignalMessage (su clave efímera y su identidad).
 */
export function x3dhAccept(
	own: {
		identityKey: IdentityKeyPair
		signedPreKey: KeyPair
		/** prekey de un solo uso cuyo id indica el emisor */
		oneTimePreKey?: KeyPair
	},
	remote: { ephemeralKey: Bytes; identityKey: Bytes }
): AcceptResult {
	const IK = own.identityKey.private
	const SPK = own.signedPreKey.private
	const EK = remote.ephemeralKey
	const IKb = remote.identityKey

	const F = own.oneTimePreKey ? Buffer.alloc(0) : Buffer.alloc(KEY_LENGTH)
	const material = concat(
		F,
		x25519.getSharedSecret(SPK, IKb),                            // DH1
		x25519.getSharedSecret(IK, EK),                              // DH2
		x25519.getSharedSecret(SPK, EK),                             // DH3
		own.oneTimePreKey
			? x25519.getSharedSecret(own.oneTimePreKey.private, EK)   // DH4
			: Buffer.alloc(KEY_LENGTH)
	)

	const sharedSecret = hkdf(material, ROOT_KEY_LENGTH)
	const chainKey = hkdf(sharedSecret, CHAIN_KEY_LENGTH, Buffer.alloc(0), X3DH_INFO)

	return {
		sharedSecret,
		chainKey,
		consumedPreKeyId: 0,
		usedOneTimePreKey: Boolean(own.oneTimePreKey)
	}
}

/** Monta el bundle propio que se publica en el servidor. */
export function generatePreKeyBundle(params: {
	identityKey: IdentityKeyPair
	signedPreKey: KeyPair
	preKeys: KeyPair[]
	registrationId: number
	preKeyId?: number
	signedPreKeyId?: number
}): {
	registrationId: number
	preKeyId: number
	signedPreKeyId: number
	signedPreKey: Buffer
	signature: Buffer
	identityKey: Buffer
	identityKeyEd25519: Buffer
	/** ausente si el pool de prekeys está agotado; X3DH lo permite */
	preKey?: Buffer
} {
	const preKeyId = params.preKeyId ?? 0
	const preKey = params.preKeys[preKeyId]

	return {
		registrationId: params.registrationId,
		preKeyId,
		signedPreKeyId: params.signedPreKeyId ?? 1,
		signedPreKey: params.signedPreKey.public,
		signature: ed25519.sign(params.signedPreKey.public, params.identityKey.private),
		identityKey: params.identityKey.public,
		identityKeyEd25519: params.identityKey.ed25519Public,
		// Un bundle sin prekey de un solo uso es válido: el receptor pone 32
		// ceros como DH4. Pasa cuando el pool se agota.
		preKey: preKey?.public
	}
}
