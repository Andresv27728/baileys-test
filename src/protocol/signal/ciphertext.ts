/**
 * La envoltura `Cipher` de WhatsApp.
 *
 * Cada mensaje que sale por el socket va en un nodo `cipher` cuyo contenido es
 * un protobuf con dos campos:
 *
 *   ciphertext           -> dispositivo del remitente (1:1) o del grupo
 *   deviceIdentityCiphertext -> identidad de la cuenta
 *
 * El primer byte del plaintext descifrado dice qué va dentro: si es 0x01 es un
 * `SignalProtocolMessage`, si es 0x02 un `PendingNotification`. Ese byte
 * selector es lo que permite multiplexar tipos sobre el mismo canal.
 */

import { Buffer } from 'node:buffer'
import { concat } from '../../util/buffer.ts'
import { CryptoError } from '../../util/errors.ts'
import { chacha, hkdf, randomBytes, NONCE_LENGTH, TAG_LENGTH, type Bytes } from '../../crypto/primitives.ts'
import { decode, encode, type ProtoObject } from '../../proto/codec.ts'
import {
	Ciphertext, SignalProtocolMessage, DecryptedSignalMessage, MessageKey,
	DeviceIdentityMessage, DecryptedMessage, PreSignalMessage, SignalMessage
} from '../../proto/schema.ts'

/** Selectores de tipo dentro del plaintext de un `Cipher`. */
export const CipherType = {
	SIGNAL_PROTOCOL: 0x01,
	PENDING_NOTIFICATION: 0x02
} as const

/**
 * Cifra el contenido de un nodo `cipher` con una clave de sesión.
 * Devuelve el base64 ya listo para el campo `ciphertext`.
 */
export function encryptCipherMessage(
	data: Bytes,
	iv: Bytes,
	key: Bytes,
	type: 0 | 1 | 2
): string {
	const generatedIv = iv && iv.length === 16 ? iv : randomBytes(16)
	const generatedKey = key.length === 32 ? key : hkdf(key, 32, Buffer.alloc(32))
	const ciphertext = chacha.encrypt(generatedKey, generatedIv.subarray(0, NONCE_LENGTH), data)
	const result = encode(Ciphertext, {
		iv: generatedIv,
		ciphertext
	})
	// El selector de tipo va fuera del protobuf: es 1 byte al principio del
	// payload que el servidor espera encontrar.
	return concat(Buffer.from([type]), result).toString('base64')
}

/** Descifra un `Cipher` de WhatsApp con una clave precompartida. */
export function decryptCipherMessage(
	encData: Bytes,
	expectedType: 0 | 1 | 2,
	key: Bytes,
	iv?: Bytes
): { data: Bytes; iv: Bytes; key: Bytes } {
	const type = encData[0]
	if (type !== expectedType) {
		throw new CryptoError(`tipo de cipher inesperado: ${type} != ${expectedType}`)
	}
	const payload = encData.subarray(1)
	const { iv: ctIv, ciphertext } = decode<{ iv: Bytes; ciphertext: Bytes }>(Ciphertext, payload)

	const generatedKey = key.length === 32 ? key : hkdf(key, 32, Buffer.alloc(32))
	const finalIv = iv && iv.length === 16 ? iv : ctIv
	const plaintext = chacha.decrypt(generatedKey, finalIv.subarray(0, NONCE_LENGTH), ciphertext)
	return { data: plaintext, iv: ctIv, key: generatedKey }
}

/** Serializa un `SignalProtocolMessage` al base64 que espera el nodo. */
export function encodeSignalProtocol(msg: ProtoObject): string {
	return encode(SignalProtocolMessage, msg).toString('base64')
}

export function decodeSignalProtocol(b64: string): ProtoObject {
	return decode(SignalProtocolMessage, Buffer.from(b64, 'base64'))
}

/** Envuelve un `DecryptedSignalMessage` en su `Ciphertext` + base64. */
export function encodeDecryptedSignalMessage(
	msg: ProtoObject & { registrationId: number; ciphertext: { iv: Bytes; ciphertext: Bytes } }
): string {
	return encode(DecryptedSignalMessage, msg as ProtoObject).toString('base64')
}

export function encodeMessageKey(key: { remoteJid: string; fromMe?: boolean; id: string; participant?: string }): string {
	return encode(MessageKey, key as ProtoObject).toString('base64')
}

export function encodeDeviceIdentityMessage(payload: ProtoObject): string {
	return encode(DeviceIdentityMessage, payload as ProtoObject).toString('base64')
}

export function encodeDecryptedMessage(payload: ProtoObject): string {
	return encode(DecryptedMessage, payload as ProtoObject).toString('base64')
}

export function encodePreSignalMessage(payload: ProtoObject): string {
	return encode(PreSignalMessage, payload as ProtoObject).toString('base64')
}

export function encodeSignalMessage(payload: ProtoObject): string {
	return encode(SignalMessage, payload as ProtoObject).toString('base64')
}

export { NONCE_LENGTH, TAG_LENGTH }
