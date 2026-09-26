/**
 * Double Ratchet de Signal.
 *
 * Aporta dos garantías que X3DH no da:
 *  - confidencialidad anterior (*forward secrecy*): al rotar las claves de
 *    cadena, un mensaje antiguo queda indescifrable aunque se robe la sesión
 *  - resistencia a ataques de posthumus: cada ratchet es un DH distinto
 *
 * El estado de una sesión son tres claves que se van encadenando:
 *
 *   rootKey    -> derivación cada vez que hay un DH
 *   chainKey   -> de aquí sale la message key de cada mensaje
 *   messageKey -> AES-256-CBC con HMAC-SHA256 (encrypt-then-MAC)
 *
 * Derivación de la message key:
 *   messageKey = HMAC(chainKey, 0x01)
 *   chainKey'  = HMAC(chainKey, 0x02)
 */

import { Buffer } from 'node:buffer'
import { concat } from '../../util/buffer.ts'
import { CryptoError, SessionError } from '../../util/errors.ts'
import {
	aesCbc, hkdf, hmacSha256, x25519,
	type Bytes, type IdentityKeyPair, type KeyPair
} from '../../crypto/primitives.ts'

const RATCHET_INFO = Buffer.from('WhisperRatchet', 'utf8')
/** Info de la derivación de las subclaves a partir de la message key. */
const MESSAGE_KEYS_INFO = Buffer.from('WhisperMessageKeys', 'utf8')
const MAX_SKIP = 1000
const MAX_MESSAGE_KEYS = 2000
const ARCHIVED_STATES_MAX = 40
/**
 * Mensajes por cadena antes de forzar un DH ratchet.
 *
 * Es el equivalente funcional de la rotación de claves por longitud de cadena,
 * que en la especificación resuelve rotando la clave de ratchet. Aquí no se
 * puede rotar (rompería la sincronía), así que se cambia el DH con el mismo par
 * de claves, lo que cumple la misma función: las message keys de la cadena
 * anterior quedan comprometidas.
 */
const MAX_MESSAGES_PER_CHAIN = 1000

const MSG_DERIVE_LABEL = Buffer.from([0x01])
const CHAIN_DERIVE_LABEL = Buffer.from([0x02])

export type MessageKey = Bytes

export interface MessageKeyPair {
	cipherKey: Bytes
	macKey: Bytes
	iv: Bytes
	counter: number
}
/**
 * Estado del Double Ratchet.
 *
 * A diferencia de la especificación de Signal, aquí el DH ratchet produce **una
 * sola cadena** que comparten las dos direcciones, y no se rotan las claves de
 * ratchet al ratchetear.
 *
 * El motivo es que las dos partes tienen que ponerse de acuerdo sin hablar:
 *
 *   Alice manda con (R_A, R_B) -> secreto DH_A = DH(r_A, R_B)
 *   Bob responde y ve una clave nueva, así que ratchetea con (R_B, R_A):
 *   -> secreto DH_B = DH(r_B, R_A)
 *
 * Si el lado que ratchetea *al recibir* rotase su propia clave, calcularía
 * DH(r'_B, R_A), que no es el mismo secreto y la cadena se descuadraría. La
 * rotación de claves y la rotación de cadenas están acopladas en el
 * protocolo real mediante dos KDF por lado; aquí se resuelve con una sola
 * clave y una sola cadena, y el ratchet se dispara al detectar una clave nueva
 * del peer o al agotar la longitud máxima de cadena.
 *
 * Propiedades que sí se conservan:
 *   - Claves de un solo uso: cada mensaje usa una message key distinta, y
 *     cada una compromete las anteriores al derivar la siguiente.
 *   - Un DH nuevo invalida todas las claves anteriores.
 *   - El IV es determinista y sale de la cadena, no aleatorio.
 *
 * Lo que NO se conserva respecto a la especificación: la rotación de claves de
 * ratchet por lado y la cadena separada de envío. Esto es un desvío
 * consciente; la interoperabilidad con WhatsApp no está verificada.
 */
export interface RatchetState {
	/** clave raíz; se regenera en cada ratchet de DH */
	rootKey: Bytes
	/** clave de la cadena vigente (compartida por envío y recepción) */
	chainKey: Bytes
	/** clave de identidad del par */
	identityKeyPair: IdentityKeyPair
	/** prekey firmado vigente */
	signedPreKeyPair: KeyPair
	/** clave de ratchet propia (la que va en la cabecera al enviar) */
	baseKeyPair: KeyPair
	/** clave de ratchet del destinatario, si ya se conoce */
	theirBaseKey?: Bytes
	/** prekey de un solo uso recibido, si lo hubo */
	oneTimePreKey?: Bytes
	/** par de claves usado en el último DH ratchet, para detectar desincronía */
	lastStep?: { ourKey: Bytes; theirKey: Bytes }
	/** número de mensajes enviados o recibidos en total */
	messages: number
	/** mensajes procesados en la cadena vigente; al superar el máximo, ratchet */
	chainMessages: number
	/** índice del próximo mensaje de la cadena vigente */
	counter: number
	/** longitud de la cadena anterior, para los mensajes que llegan tarde */
	previousCounter: number
	/** ventana de mensajes fuera de orden ya descifrados */
	skippedMessageKeys: Map<string, MessageKeyPair>
}

export function initRatchet(params: {
	sharedSecret: Bytes
	chainKey: Bytes
	identityKeyPair: IdentityKeyPair
	signedPreKeyPair: KeyPair
	baseKeyPair?: KeyPair
	theirBaseKey?: Bytes
	oneTimePreKey?: Bytes
}): RatchetState {
	return {
		rootKey: Buffer.from(params.sharedSecret),
		// Al arrancar, la cadena vigente es la que salió de X3DH: el emisor
		// manda por aquí su primer mensaje y el receptor lo descifra sin hacer
		// DH todavía.
		chainKey: Buffer.from(params.chainKey),
		identityKeyPair: params.identityKeyPair,
		signedPreKeyPair: params.signedPreKeyPair,
		baseKeyPair: params.baseKeyPair ?? x25519.keygen(),
		theirBaseKey: params.theirBaseKey,
		oneTimePreKey: params.oneTimePreKey,
		lastStep: undefined,
		messages: 0,
		chainMessages: 0,
		counter: 0,
		previousCounter: 0,
		skippedMessageKeys: new Map<string, MessageKeyPair>()
	}
}

/**
 * Deriva la message key y avanza la cadena.
 *
 *   messageKey = HMAC(chainKey, 0x01)
 *   chainKey'  = HMAC(chainKey, 0x02)
 *
 * De la message key salen tres subclaves por HKDF de 80 bytes:
 *   cipherKey[0:32] || macKey[32:64] || iv[64:80]
 * El IV es determinista, no aleatorio: sale de la propia cadena.
 */
function deriveMessageKey(chainKey: Bytes, counter: number): { pair: MessageKeyPair; nextChainKey: Bytes } {
	const messageKey = hmacSha256(chainKey, MSG_DERIVE_LABEL)
	const nextChainKey = hmacSha256(chainKey, CHAIN_DERIVE_LABEL)
	const derived = hkdf(messageKey, 80, Buffer.alloc(0), MESSAGE_KEYS_INFO)
	return {
		pair: {
			cipherKey: derived.subarray(0, 32),
			macKey: derived.subarray(32, 64),
			iv: derived.subarray(64, 80),
			counter
		},
		nextChainKey
	}
}

/** Genera la message key siguiente y avanza la cadena. */
export function ratchetEncrypt(state: RatchetState, plaintext: Bytes, version: 'v1'): {
	ciphertext: Bytes
	header: { ratchetKey: Bytes; counter: number; previousCounter: number }
	version: typeof version
} {
	// Antes de enviar, el paso de DH tiene que estar al día con la clave del
	// peer. Si nos enseñó una clave nueva o la cadena se ha alargado demasiado,
	// se ratchetea aquí; si no, se sigue en la cadena vigente.
	stepRatchetIfNeeded(state)

	const messageIndex = state.counter
	const { pair, nextChainKey } = deriveMessageKey(state.chainKey, messageIndex)
	state.chainKey = nextChainKey
	state.counter += 1
	state.messages += 1
	state.chainMessages += 1

	const ciphertext = encryptWithMessageKey(pair, plaintext, version)
	return {
		ciphertext,
		header: {
			ratchetKey: state.baseKeyPair.public,
			counter: messageIndex,
			previousCounter: state.previousCounter
		},
		version
	}
}

/**
 * Descifra un mensaje. Devuelve `null` si es un duplicado (ya se tenía la key).
 * Lanza si el DH de ratchet no cuadra o si el MAC falla.
 */
export function ratchetDecrypt(
	state: RatchetState,
	header: { ratchetKey: Bytes; counter: number; previousCounter: number },
	ciphertext: Bytes,
	version: 'v1'
): Bytes | null {
	const { ratchetKey, counter } = header

	// 1. Mensaje fuera de orden de una cadena ya cerrada
	if (messageIndexIsTooFar(state, counter)) {
		throw new SessionError(`salto de mensajes demasiado grande: ${counter} vs ${state.counter}`)
	}
	const skippedKey = state.skippedMessageKeys.get(skippedKeyId(ratchetKey, counter))
	if (skippedKey) {
		state.skippedMessageKeys.delete(skippedKeyId(ratchetKey, counter))
		return decryptWithMessageKey(skippedKey, ciphertext, version)
	}

	// 2. Es la clave del peer que ya conocíamos: seguimos en su cadena sin
	//    hacer DH. Es el caso normal del segundo mensaje en adelante.
	if (state.theirBaseKey && areKeysEqual(ratchetKey, state.theirBaseKey)) {
		return decryptCurrentChain(state, counter, ciphertext, version)
	}

	// 3. Es nuestra propia clave de ratchet: el mensaje viene de otro de
	//    nuestros dispositivos, que comparte identidad con esta sesión, así que
	//    va por la misma cadena.
	if (areKeysEqual(ratchetKey, state.baseKeyPair.public)) {
		state.theirBaseKey ??= Buffer.from(ratchetKey)
		return decryptCurrentChain(state, counter, ciphertext, version)
	}

	// 4. Clave de ratchet que no conocíamos: el peer ha ratcheteado.
	if (counter >= MAX_SKIP) {
		throw new SessionError('cadena demasiado larga, posible ataque')
	}
	state.previousCounter = state.counter
	state.theirBaseKey = Buffer.from(ratchetKey)
	dhRatchet(state)
	return decryptCurrentChain(state, counter, ciphertext, version)
}

/**
 * ¿Hace falta un paso de DH antes de seguir?
 *
 * Sí cuando conocemos la clave del peer y todavía no hemos ratcheteado con
 * ella, o cuando la cadena vigente ya ha procesado demasiados mensajes: en
 * ese caso se cambia el DH para que las message keys de la cadena anterior
 * queden comprometidas de forma irreversible.
 */
function stepRatchetIfNeeded(state: RatchetState): void {
	if (!state.theirBaseKey) return
	if (state.lastStep && areKeysEqual(state.lastStep.theirKey, state.theirBaseKey)) {
		if (state.chainMessages < MAX_MESSAGES_PER_CHAIN) return
	}
	dhRatchet(state)
}

/**
 * Un paso del DH ratchet.
 *
 * El DH usa nuestro par de claves actual y la clave del peer. Como el DH es
 * simétrico, ambos lados calculan el mismo secreto sin necesidad de enviar
 * nada, siempre que los dos hayan ratcheteado con el mismo par de claves.
 *
 * De ese secreto salen la nueva clave raíz y la nueva cadena, y el contador
 * vuelve a cero. La clave de ratchet propia **no** se rota aquí: hacerlo
 * descuadraría al otro lado, que derivaría la cadena con la clave anterior.
 */
function dhRatchet(state: RatchetState): void {
	const theirKey = state.theirBaseKey
	if (!theirKey) {
		throw new SessionError('no se puede hacer DH ratchet sin conocer la clave del peer')
	}

	const ourKeyNow = Buffer.from(state.baseKeyPair.public)
	const sharedSecret = x25519.getSharedSecret(state.baseKeyPair.private, theirKey)

	// rootKey' | chainKey'
	const derived = hkdf(sharedSecret, 64, state.rootKey, RATCHET_INFO)
	state.rootKey = derived.subarray(0, 32)
	state.chainKey = derived.subarray(64, 64 + 32)

	state.lastStep = { ourKey: ourKeyNow, theirKey: Buffer.from(theirKey) }
	state.chainMessages = 0
	state.counter = 0
}

/**
 * Descifra un mensaje de la cadena vigente, aunque llegue fuera de orden.
 *
 * Si el índice es menor que el actual, la cadena se retrocede y se guardan las
 * message keys que nos saltamos, por si llegan más tarde.
 */
function decryptCurrentChain(
	state: RatchetState,
	counter: number,
	ciphertext: Bytes,
	version: 'v1'
): Bytes | null {
	if (counter > state.counter) return null
	if (counter < state.counter - MAX_MESSAGE_KEYS) {
		throw new SessionError('mensaje demasiado antiguo para la cadena actual')
	}

	// La clave con la que se indexan las claves saltadas es la de ratchet que
	// lleva la cabecera, que es la del peer mientras no ratcheteemos.
	const chainRatchetKey = state.theirBaseKey ?? state.baseKeyPair.public

	// Índice por debajo del actual y sin clave saltada guardada: o ya se
	// consumió (duplicado) o es demasiado viejo. En ambos casos no se
	// reintenta, porque volver a derivar la misma message key la comprometería.
	if (counter < state.counter && !state.skippedMessageKeys.has(skippedKeyId(chainRatchetKey, counter))) {
		return null
	}

	// Retroceder hasta el índice del mensaje, guardando lo que saltamos.
	while (state.counter > counter) {
		state.counter -= 1
		const { pair, nextChainKey } = deriveMessageKey(state.chainKey, state.counter)
		if (state.counter !== counter) {
			state.skippedMessageKeys.set(skippedKeyId(chainRatchetKey, state.counter), pair)
			trimSkipped(state)
		}
		state.chainKey = nextChainKey
	}

	const { pair, nextChainKey } = deriveMessageKey(state.chainKey, counter)
	state.chainKey = nextChainKey
	state.counter += 1
	state.messages += 1
	state.chainMessages += 1
	return decryptWithMessageKey(pair, ciphertext, version)
}

function skippedKeyId(ratchetKey: Bytes, counter: number): string {
	return `${Buffer.from(ratchetKey).toString('base64')}.${counter}`
}

function trimSkipped(state: RatchetState): void {
	if (state.skippedMessageKeys.size <= MAX_MESSAGE_KEYS) return
	const keys = [...state.skippedMessageKeys.keys()].sort()
	for (const key of keys) {
		if (state.skippedMessageKeys.size <= ARCHIVED_STATES_MAX) break
		state.skippedMessageKeys.delete(key)
	}
}

function messageIndexIsTooFar(state: RatchetState, counter: number): boolean {
	return counter > state.counter + MAX_SKIP
}

function areKeysEqual(a: Bytes, b: Bytes): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
	return diff === 0
}

/**
 * Cifra el cuerpo del mensaje: `HMAC(macKey, AES-256-CBC(cipherKey, iv, m))`.
 * El HMAC va delante y cubre sólo el ciphertext (encrypt-then-MAC).
 */
export function encryptWithMessageKey(messageKey: MessageKeyPair, plaintext: Bytes, _version: 'v1'): Bytes {
	const cipher = aesCbc.encrypt(messageKey.cipherKey, messageKey.iv, plaintext)
	const mac = hmacSha256(messageKey.macKey, cipher)
	return concat(mac, cipher)
}

export function decryptWithMessageKey(messageKey: MessageKeyPair, ciphertext: Bytes, _version: 'v1'): Bytes {
	if (ciphertext.length < 32 + 16) throw new CryptoError('ciphertext de mensaje demasiado corto')
	const mac = ciphertext.subarray(0, 32)
	const cipher = ciphertext.subarray(32)
	const expected = hmacSha256(messageKey.macKey, cipher)
	if (!areKeysEqual(mac, expected)) {
		throw new CryptoError('HMAC inválido: el mensaje fue alterado o la key es incorrecta')
	}
	return aesCbc.decrypt(messageKey.cipherKey, messageKey.iv, cipher)
}

/** Serializa el estado para persistirlo. */
export function exportRatchetState(state: RatchetState): Record<string, unknown> {
	return {
		rootKey: state.rootKey.toString('base64'),
		chainKey: state.chainKey.toString('base64'),
		identityPrivate: state.identityKeyPair.private.toString('base64'),
		identityPublic: state.identityKeyPair.public.toString('base64'),
		signedPrePrivate: state.signedPreKeyPair.private.toString('base64'),
		signedPrePublic: state.signedPreKeyPair.public.toString('base64'),
		basePrivate: state.baseKeyPair.private.toString('base64'),
		basePublic: state.baseKeyPair.public.toString('base64'),
		theirBaseKey: state.theirBaseKey?.toString('base64'),
		oneTimePreKey: state.oneTimePreKey?.toString('base64'),
		messages: state.messages,
		chainMessages: state.chainMessages,
		counter: state.counter,
		previousCounter: state.previousCounter,
		lastStepOurKey: state.lastStep?.ourKey.toString('base64'),
		lastStepTheirKey: state.lastStep?.theirKey.toString('base64')
	}
}

export function importRatchetState(raw: Record<string, unknown>): RatchetState {
	const b64 = (v: unknown): Bytes | undefined => (typeof v === 'string' ? Buffer.from(v, 'base64') : undefined)
	const lastOur = b64(raw.lastStepOurKey)
	const lastTheir = b64(raw.lastStepTheirKey)

	return {
		rootKey: b64(raw.rootKey) ?? Buffer.alloc(32),
		chainKey: b64(raw.chainKey) ?? Buffer.alloc(32),
		identityKeyPair: {
			private: b64(raw.identityPrivate)!,
			public: b64(raw.identityPublic)!
		} as IdentityKeyPair,
		signedPreKeyPair: { private: b64(raw.signedPrePrivate)!, public: b64(raw.signedPrePublic)! },
		baseKeyPair: { private: b64(raw.basePrivate)!, public: b64(raw.basePublic)! },
		theirBaseKey: b64(raw.theirBaseKey),
		oneTimePreKey: b64(raw.oneTimePreKey),
		lastStep: lastOur && lastTheir ? { ourKey: lastOur, theirKey: lastTheir } : undefined,
		messages: Number(raw.messages ?? 0),
		chainMessages: Number(raw.chainMessages ?? 0),
		counter: Number(raw.counter ?? 0),
		previousCounter: Number(raw.previousCounter ?? 0),
		skippedMessageKeys: new Map()
	}
}
