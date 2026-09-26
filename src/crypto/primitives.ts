import { x25519 as x25519Curve, ed25519 as ed25519Curve } from '@noble/curves/ed25519'
import { hkdf as nobleHkdf, extract as nobleExtract, expand as nobleExpand } from '@noble/hashes/hkdf'
import { hmac as nobleHmac } from '@noble/hashes/hmac'
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { gcm, cbc } from '@noble/ciphers/aes'
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils'
import {
	createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify,
	generateKeyPairSync, createHash as nodeCreateHash, createHmac as nodeCreateHmac
} from 'node:crypto'
import { bytesToBase64Url, base64UrlToBytes } from '../util/buffer.ts'

/**
 * Alias de bytes. Es `Buffer` y no `Uint8Array` a propósito: el protocolo usa
 * `toString('base64')` y `subarray` en casi todas las conversiones, y Buffer las
 * trae de serie. Lo que entra siempre es un `Buffer` también.
 */
export type Bytes = Buffer

export const KEY_LENGTH = 32
export const SIG_LENGTH = 64
export const TAG_LENGTH = 16
export const IV_LENGTH = 16
export const NONCE_LENGTH = 12

export interface KeyPair {
	public: Buffer
	private: Buffer
}

function toU8(key: Bytes, name: string, expectedLength = KEY_LENGTH): Uint8Array {
	if (key.length !== expectedLength) {
		throw new Error(`${name} debe tener ${expectedLength} bytes, recibió ${key.length}`)
	}
	return new Uint8Array(key.buffer, key.byteOffset, key.byteLength)
}

export function randomBytes(length: number): Buffer {
	return Buffer.from(nobleRandomBytes(length))
}

/** X25519: Diffie-Hellman sobre la curva de Montgomery. Base de Noise y Signal. */
export const x25519 = {
	keygen: (): KeyPair => {
		const priv = randomBytes(KEY_LENGTH)
		return { public: Buffer.from(x25519Curve.getPublicKey(priv)), private: priv }
	},
	getPublicKey(privateKey: Bytes): Buffer {
		return Buffer.from(x25519Curve.getPublicKey(toU8(privateKey, 'la clave privada')))
	},
	getSharedSecret(privateKey: Bytes, publicKey: Bytes): Buffer {
		return Buffer.from(x25519Curve.getSharedSecret(toU8(privateKey, 'la clave privada'), toU8(publicKey, 'la pubkey')))
	},
	scalarMult(scalar: Bytes, point: Bytes): Buffer {
		return Buffer.from(x25519Curve.scalarMult(scalar, point))
	},
	scalarMultBase(scalar: Bytes): Buffer {
		return Buffer.from(x25519Curve.scalarMultBase(scalar))
	}
}

export const ed25519 = {
	getPublicKey(privateKey: Bytes): Buffer {
		return Buffer.from(ed25519Curve.getPublicKey(toU8(privateKey, 'la clave privada')))
	},
	sign(message: Bytes, privateKey: Bytes): Buffer {
		return Buffer.from(ed25519Curve.sign(message, toU8(privateKey, 'la clave privada')))
	},
	verify(signature: Bytes, message: Bytes, publicKey: Bytes): boolean {
		try {
			return ed25519Curve.verify(signature, message, toU8(publicKey, 'la pubkey'))
		} catch {
			return false
		}
	}
}

/**
 * Clave de identidad de Signal: un solo escalar para dos usos.
 *
 * El escalar privado de 32 bytes sirve tanto para firmar (Ed25519) como para el
 * Diffie-Hellman (X25519), porque ambas curvas aplican el mismo clamp. Las
 * públicas, en cambio, son puntos distintos: cada curva tiene su base y su
 * representación, y no hay conversión exacta entre ellas (la forma de
 * Montgomery pierde el bit de signo de la coordenada x).
 *
 * Por eso el par lleva las dos públicas y el bundle publica las dos:
 *   - `public` (X25519) para el DH de X3DH.
 *   - `ed25519Public` para validar la firma del prekey firmado.
 *
 * Derivar la pública de una curva con la clave de la otra daría un DH
 * distinto en cada lado y el secreto nunca cuadraría.
 */
export interface IdentityKeyPair extends KeyPair {
	/** pública en forma Ed25519, para verificar firmas */
	ed25519Public: Buffer
}

export const identity = {
	keygen(): IdentityKeyPair {
		return identity.derivePublic(randomBytes(KEY_LENGTH))
	},

	/** Deriva las dos públicas de un escalar privado. */
	derivePublic(priv: Bytes): IdentityKeyPair {
		return {
			public: Buffer.from(x25519Curve.getPublicKey(toU8(priv, 'la clave privada'))),
			private: Buffer.from(priv),
			ed25519Public: Buffer.from(ed25519Curve.getPublicKey(toU8(priv, 'la clave privada')))
		}
	}
}

export function generateKeyPair(): KeyPair {
	return x25519.keygen()
}

export function sha256(data: Bytes): Bytes {
	return Buffer.from(nobleSha256(data))
}

export function sha512(data: Bytes): Bytes {
	return Buffer.from(nobleSha512(data))
}

export function sha384(data: Bytes): Buffer {
	return Buffer.from(nodeCreateHash('sha384').update(data).digest())
}

export function hmacSha256(key: Bytes, data: Bytes): Bytes {
	return Buffer.from(nobleHmac(nobleSha256, key, data))
}

export function hmacSha512(key: Bytes, data: Bytes): Buffer {
	return Buffer.from(nobleHmac(nobleSha512, key, data))
}

export function hmacSha384(key: Bytes, data: Bytes): Buffer {
	return Buffer.from(nodeCreateHmac('sha384', key).update(data).digest())
}

export function sha256B64Url(data: Bytes): string {
	return bytesToBase64Url(sha256(data))
}

/** HKDF-SHA256 completo (extract + expand). */
export function hkdf(ikm: Bytes, length: number, salt: Bytes | null = null, info: Bytes | null = null): Bytes {
	return Buffer.from(nobleHkdf(nobleSha256, ikm, salt ?? undefined, info ?? undefined, length))
}

export function hkdfExtract(salt: Bytes, ikm: Bytes): Buffer {
	return Buffer.from(nobleExtract(nobleSha256, ikm, salt))
}

export function hkdfExpand(prk: Bytes, info: Bytes, length: number): Buffer {
	return Buffer.from(nobleExpand(nobleSha256, prk, info, length))
}

/** ChaCha20-Poly1305 AEAD: el cifrado de Noise handshake y de sesión. */
export const chacha = {
	encrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Buffer {
		return Buffer.from(chacha20poly1305(toU8(key, 'la clave'), toU8(nonce, 'el nonce'), aad).encrypt(plaintext))
	},
	decrypt(key: Bytes, nonce: Bytes, ciphertext: Bytes, aad?: Bytes): Buffer {
		return Buffer.from(chacha20poly1305(toU8(key, 'la clave'), toU8(nonce, 'el nonce'), aad).decrypt(ciphertext))
	}
}

export const aesGcm = {
	encrypt(key: Bytes, iv: Bytes, plaintext: Bytes, aad?: Bytes): Buffer {
		return Buffer.from(gcm(toU8(key, 'la clave'), toU8(iv, 'el iv', IV_LENGTH), aad).encrypt(plaintext))
	},
	decrypt(key: Bytes, iv: Bytes, ciphertext: Bytes, aad?: Bytes): Buffer {
		return Buffer.from(gcm(toU8(key, 'la clave'), toU8(iv, 'el iv', IV_LENGTH), aad).decrypt(ciphertext))
	}
}

/**
 * AES-256-CBC. Lo usa Signal para el cuerpo del mensaje; la integridad la
 * aporta un HMAC-SHA256 aparte (patrón encrypt-then-MAC).
 */
export const aesCbc = {
	encrypt(key: Bytes, iv: Bytes, plaintext: Bytes): Buffer {
		return Buffer.from(cbc(toU8(key, 'la clave'), toU8(iv, 'el iv', IV_LENGTH)).encrypt(plaintext))
	},
	decrypt(key: Bytes, iv: Bytes, ciphertext: Bytes): Buffer {
		return Buffer.from(cbc(toU8(key, 'la clave'), toU8(iv, 'el iv', IV_LENGTH)).decrypt(ciphertext))
	}
}

/** Firma P-256 / SHA-256: usada por el token de versión de WhatsApp. */
export const p256 = {
	generateKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
		const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
		return {
			publicKey: publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
			privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
		}
	},
	sign(privateKeyDer: Bytes, data: Bytes): Buffer {
		return nodeSign('sha256', Buffer.from(data), createPrivateKey({ key: Buffer.from(privateKeyDer), format: 'der', type: 'pkcs8' }))
	},
	verify(publicKeyDer: Bytes, signature: Bytes, data: Bytes): boolean {
		try {
			const key = createPublicKey({ key: Buffer.from(publicKeyDer), format: 'der', type: 'spki' })
			return nodeVerify('sha256', Buffer.from(data), key, Buffer.from(signature))
		} catch {
			return false
		}
	}
}

/** SHA-512 truncado, que es como WA deriva algunas claves de 32 bytes. */
export function sha512_256(data: Bytes): Buffer {
	return Buffer.from(nobleSha512(data).subarray(0, 32))
}

export const nodeHash = { sha256: (d: Bytes) => nodeCreateHash('sha256').update(d).digest() }
export const nodeHmac = { sha256: (k: Bytes, d: Bytes) => nodeCreateHmac('sha256', k).update(d).digest() }

export { base64UrlToBytes, bytesToBase64Url }
