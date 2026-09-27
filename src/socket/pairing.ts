/**
 * Emparejamiento de un dispositivo nuevo.
 *
 * WhatsApp admite dos vías para vincular una sesión con una cuenta:
 *
 *   1. **QR**: el cliente muestra un código y el móvil lo escanea desde
 *      *Ajustes → Dispositivos vinculados*. El QR caduca rápido, así que hay
 *      que regenerarlo cada `QR_REFRESH_MS`.
 *
 *   2. **Código de 8 caracteres**: se introduce el número de teléfono, el
 *      móvil recibe el código por SMS o notificación, y el usuario lo teclea
 *      en el cliente. El servidor lo valida contra el `ref` de esta sesión.
 *
 * Las dos terminan en el mismo sitio: el servidor manda `pair-success` con la
 * identidad de la cuenta y desde ahí la sesión queda online.
 */

import { Buffer } from 'node:buffer'
import { ConnectionError, SessionError } from '../util/errors.ts'
import { bytesToBase64Url } from '../util/buffer.ts'
import { randomBytes } from '../crypto/primitives.ts'
import type { Bytes } from '../crypto/primitives.ts'

/** Caducidad del QR. WhatsApp lo rota cada ~20 s y caduca a los ~60 s. */
export const QR_REFRESH_MS = 20_000
/** Cuánto esperamos un `pair-success` antes de dar el pairing por fallido. */
export const PAIRING_TIMEOUT_MS = 120_000

/**
 * Formato del código de 8 caracteres.
 *
 * WhatsApp usa 8 caracteres alfanuméricos en mayúsculas. Se aceptan también
 * minúsculas y el guion que بعض clientes muestran como separador, porque el
 * usuario lo teclea a mano y es fácil equivocarse.
 */
const CODE_LENGTH = 8
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const CODE_INPUT = /^[A-Za-z0-9]{8}$/

/** Estado del emparejamiento por código, para poder cancelarlo. */
export type PairingState =
	| { kind: 'idle' }
	| { kind: 'awaiting-qr'; ref: string; expiresAt: number }
	| { kind: 'awaiting-code'; ref: string; phone: string }
	| { kind: 'paired' }

/**
 * Valida y normaliza un código de 8 caracteres.
 *
 * Devuelve el código en mayúsculas y sin separadores, que es la forma que
 * espera el servidor. Lanza `SessionError` con un mensaje que se puede enseñar
 * al usuario tal cual si el formato no cuadra.
 */
export function normalizePairingCode(input: string): string {
	const cleaned = input.toUpperCase().replace(/[\s-]/g, '')
	if (!CODE_INPUT.test(cleaned)) {
		throw new SessionError(
			`el código debe tener ${CODE_LENGTH} caracteres alfanuméricos (se admiten mayúsculas, minúsculas y guion)`
		)
	}
	return cleaned
}

/** Comprueba si un código tiene la forma correcta, sin lanzar. */
export function isValidPairingCode(input: string): boolean {
	return CODE_INPUT.test(input.toUpperCase().replace(/[\s-]/g, ''))
}

/**
 * Genera un código de 8 caracteres con el alfabeto de WhatsApp.
 *
 * Se usa para pruebas y para el flujo en el que el propio cliente genera el
 * código (emparejamiento manual, en el que el móvil lo teclea).
 */
export function generatePairingCode(): string {
	let out = ''
	for (let i = 0; i < CODE_LENGTH; i++) {
		out += CODE_ALPHABET[randomBytes(1)[0]! % CODE_ALPHABET.length]
	}
	return out
}

/**
 * Compone el contenido que se codifica en el QR.
 *
 * El móvil necesita cuatro cosas para completar el vínculo:
 *   - `ref`: identificador de este intento de emparejamiento
 *   - la clave de Noise pública del cliente
 *   - la clave de identidad pública (X25519) del cliente
 *   - la clave secreta avanzada que se pactará con la cuenta
 *
 * Se codifica como CSV en base64url, que es lo que espera el lector.
 */
export function buildQrPayload(params: {
	ref: Bytes
	noiseKey: Bytes
	identityKey: Bytes
	advSecretKey: Bytes
}): string {
	const parts = [
		params.ref,
		params.noiseKey,
		params.identityKey,
		params.advSecretKey
	].map(bytesToBase64Url)
	return parts.join(',')
}

/** Valida que un payload de QR tenga las cuatro partes con el tamaño justo. */
export function parseQrPayload(payload: string): {
	ref: Buffer
	noiseKey: Buffer
	identityKey: Buffer
	advSecretKey: Buffer
} {
	const parts = payload.split(',')
	if (parts.length !== 4) {
		throw new ConnectionError(`el QR debe tener 4 partes, tiene ${parts.length}`)
	}
	const ref = Buffer.from(parts[0]!, 'base64url')
	const noiseKey = Buffer.from(parts[1]!, 'base64url')
	const identityKey = Buffer.from(parts[2]!, 'base64url')
	const advSecretKey = Buffer.from(parts[3]!, 'base64url')

	const expected: Array<[string, Buffer, number]> = [
		['ref', ref, 16],
		['noiseKey', noiseKey, 32],
		['identityKey', identityKey, 32],
		['advSecretKey', advSecretKey, 32]
	]
	for (const [name, value, size] of expected) {
		if (value.length !== size) {
			throw new ConnectionError(`la parte ${name} del QR mide ${value.length} bytes, esperaba ${size}`)
		}
	}
	return { ref, noiseKey, identityKey, advSecretKey }
}

/**
 * Normaliza un número de teléfono al formato que espera el servidor.
 *
 * Se quita todo lo que no sea dígito. El signo más inicial se conserva porque
 * WhatsApp lo acepta, pero solo como prefijo, nunca entre medias.
 */
export function normalizePhoneNumber(input: string): string {
	const trimmed = input.trim()
	if (!trimmed) throw new SessionError('falta el número de teléfono')

	const plus = trimmed.startsWith('+')
	const digits = trimmed.replace(/\D/g, '')
	if (digits.length < 5 || digits.length > 15) {
		throw new SessionError(`"${trimmed}" no parece un número de teléfono válido`)
	}
	return plus ? `+${digits}` : digits
}
