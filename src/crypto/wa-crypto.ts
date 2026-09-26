import { Buffer } from 'node:buffer'
import { concat } from '../util/buffer.ts'
import { CryptoError } from '../util/errors.ts'
import { chacha, hmacSha256, randomBytes, KEY_LENGTH, TAG_LENGTH, NONCE_LENGTH, type Bytes } from './primitives.ts'

/**
 * Capa de cifrado propia de WhatsApp (la "app crypto"), distinta del handshake.
 *
 * Hay dos convenciones que conviven:
 *  - la legacy, derivada de WebCrypto (`WebCryptoHkdf` + ChaCha20-Poly1305)
 *  - la de libsignal, que concatena `ciphertext || nonce` y separa el tipo
 *
 * El prefijo numérico que acompaña a los blobs cifrados dice cuál de las dos
 * es: los legacy llevan `12 + 16 = 28`; los de libsignal añaden el byte de tipo.
 */

export const NOISE_INFO = Buffer.from('WhatsApp Noise Protocol', 'utf8')
export const LEGACY_OVERHEAD = NONCE_LENGTH + TAG_LENGTH // 28

/** HKDF tal y como lo implementa WebCrypto: salt nulo => HMAC(ikm, 32 ceros). */
export function waHkdf(ikm: Bytes, length: number, info?: Bytes, salt?: Bytes): Bytes {
	const saltKey = salt && salt.length > 0 ? salt : null
	if (saltKey) {
		const prk = hmacSha256(saltKey, ikm)
		return expand(prk, info, length)
	}
	const prk = hmacSha256(ikm, Buffer.alloc(32))
	return expand(prk, info, length)
}

function expand(prk: Bytes, info: Bytes | undefined, length: number): Bytes {
	if (length <= 32) {
		return hmacSha256(prk, concat(info ?? Buffer.alloc(0), Buffer.from([0x01])))
	}
	const blocks: Bytes[] = []
	let prev: Bytes = Buffer.alloc(0)
	let counter = 1
	let remaining = length
	while (remaining > 0) {
		prev = hmacSha256(prk, concat(prev, info ?? Buffer.alloc(0), Buffer.from([counter])))
		blocks.push(prev)
		remaining -= prev.length
		counter++
	}
	return concat(...blocks).subarray(0, length)
}

/** Cifra con clave derivada de `encKey`. Devuelve cipher, nonce y longitud total. */
export function encryptWithAD(encKey: Bytes, data: Bytes, aad: Bytes): { cipher: Buffer; nonce: Buffer; len: number } {
	const key = waHkdf(encKey, KEY_LENGTH, NOISE_INFO)
	const nonce = randomBytes(NONCE_LENGTH)
	return { cipher: chacha.encrypt(key, nonce, data, aad), nonce, len: NONCE_LENGTH + TAG_LENGTH }
}

export function decryptWithAD(encKey: Bytes, data: Bytes, aad: Bytes, len: number): Buffer {
	const key = waHkdf(encKey, KEY_LENGTH, NOISE_INFO)
	const nonce = data.subarray(0, NONCE_LENGTH)
	const ciphertext = data.subarray(NONCE_LENGTH, len)
	return chacha.decrypt(key, nonce, ciphertext, aad)
}

/** Variante libsignal: el resultado ya trae `ciphertext || nonce`. */
export function libsignalEncryptWithAD(data: Bytes, key: Bytes, aad: Bytes, type: number): Buffer {
	const nonce = randomBytes(NONCE_LENGTH)
	const ciphertext = chacha.encrypt(key, nonce, data, aad)
	return concat(ciphertext, nonce, Buffer.from([type]))
}

export function libsignalDecryptWithAD(data: Bytes, key: Bytes, aad: Bytes, type: number): Buffer {
	if (data.length < NONCE_LENGTH + 1) throw new CryptoError('ciphertext demasiado corto')
	const typeByte = data[data.length - 1]
	if (typeByte !== type) throw new CryptoError(`tipo de ciphertext inesperado: ${typeByte} != ${type}`)
	const nonce = data.subarray(data.length - NONCE_LENGTH - 1, data.length - 1)
	const ciphertext = data.subarray(0, data.length - NONCE_LENGTH - 1)
	return chacha.decrypt(key, nonce, ciphertext, aad)
}

/**
 * Auth blob: envuelve las claves de los nodos deNoise.
 * `type` 0 = legacy (clave derivada con HKDF), 1 = clave cruda.
 */
export function encryptAuth(
	encKey: Bytes,
	data: Bytes,
	type: 0 | 1,
	auth: { type: 'INIT' | 'SYMKEY'; mac: Bytes } = { type: 'INIT', mac: randomBytes(16) }
): Bytes {
	const bmac = hmacSha256(encKey, concat(data, Buffer.from([type])))
	const bauth = hmacSha256(bmac, concat(auth.mac, Buffer.from([auth.type === 'INIT' ? 1 : 2])))
	const aad = concat(Buffer.from([auth.type === 'INIT' ? 1 : 2]), bauth.subarray(0, 32))
	const payload = concat(data, bmac.subarray(0, 16))
	const key = type === 0 ? waHkdf(encKey, KEY_LENGTH, NOISE_INFO) : encKey
	const nonce = randomBytes(NONCE_LENGTH)
	return concat(chacha.encrypt(key, nonce, payload, aad), nonce, Buffer.from([type]))
}

export function decryptAuth(encKey: Bytes, data: Bytes): Bytes {
	const type = data[data.length - 1] as 0 | 1
	const key = type === 0 ? waHkdf(encKey, KEY_LENGTH, NOISE_INFO) : encKey
	const nonce = data.subarray(0, NONCE_LENGTH)
	const ciphertext = data.subarray(NONCE_LENGTH, data.length - 1)
	try {
		return chacha.decrypt(key, nonce, ciphertext)
	} catch (err) {
		throw new CryptoError('fallo al descifrar auth blob', err)
	}
}

/** Rellena un buffer a múltiplo de `blockSize` con bytes aleatorios. */
export function padRandom(buf: Buffer, blockSize = 16): Buffer {
	const rem = buf.length % blockSize
	if (rem === 0) return buf
	return concat(buf, randomBytes(blockSize - rem))
}
