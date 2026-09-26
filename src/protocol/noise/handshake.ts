/**
 * Handshake de Noise que usa WhatsApp.
 *
 * No es Noise estándar: es una variante con los mismos primitives
 * (X25519 + HKDF-SHA256 + ChaCha20-Poly1305) pero con nombres y orden propios.
 *
 *   fase 0  cliente -> servidor
 *          El cliente manda `hash(hash(clave estática) + ephemeral)`, firmado
 *          con Ed25519, junto al `hash` y la `firma`. El servidor valida que
 *          conoce la clave estática de esta sesión.
 *
 *   fase 1  servidor -> cliente
 *          `hash(efemérica del servidor)`, `firma` y `efemérica del cliente`
 *          (eco). El cliente comprueba la firma con la clave pública del
 *          servidor que viene embebida en el bundle de la web.
 *
 *   fase 2  cliente -> servidor
 *          Finaliza: se mezclan los secretos y sale `hashHandshake`.
 *
 *   fase 3  servidor -> cliente (serverFinish)
 *          El servidor confirma el emparejamiento; en el registro por QR es
 *          donde llega el `ref` del teléfono.
 */

import { Buffer } from 'node:buffer'
import { concat } from '../../util/buffer.ts'
import { HandshakeError } from '../../util/errors.ts'
import {
	chacha, ed25519, hkdf, hmacSha256, randomBytes, sha256, x25519,
	KEY_LENGTH, NONCE_LENGTH, TAG_LENGTH, type Bytes, type KeyPair
} from '../../crypto/primitives.ts'

const WA_NOISE = Buffer.from('WA_NOISE_V1', 'utf8')

/** Claves de sesión derivadas del handshake, con sus nonces y la ventana de claves. */
export class NoiseSession {
	/** clave de lectura (cliente -> servidor) */
	readonly readKey: Bytes
	/** clave de escritura (servidor -> cliente) */
	readonly writeKey: Bytes
	/** nonce de lectura, se incrementa por mensaje */
	readonly readCounter: Bytes
	/** nonce de escritura, se incrementa por mensaje */
	readonly writeCounter: Bytes
	/** hash del handshake, se encadena al siguiente mensaje */
	readonly hash: Bytes

	constructor(
		readKey: Bytes,
		writeKey: Bytes,
		readCounter: Bytes,
		writeCounter: Bytes,
		hash: Bytes
	) {
		this.readKey = readKey
		this.writeKey = writeKey
		this.readCounter = readCounter
		this.writeCounter = writeCounter
		this.hash = hash
	}
}

/**
 * Estado mutable del handshake. Se mantiene separado de la sesión porque el
 * handshake puede reintentarse sin perder las claves estáticas.
 */
export class HandshakeState {
	/** clave estática de largo plazo de este cliente */
	readonly noiseKey: KeyPair
	/** clave efímera del handshake actual */
	ephemeral: KeyPair
	/** bytes dehello, se regeneran en cada reconexión */
	dehello: Bytes
	hashHandshake: Bytes

	constructor(noiseKey?: KeyPair) {
		this.noiseKey = noiseKey ?? x25519.keygen()
		this.ephemeral = x25519.keygen()
		this.dehello = randomBytes(32)
		this.hashHandshake = sha256(Buffer.from('Noise_INIT', 'utf8'))
	}

	/** Regenera lo que depende de cada intento de conexión. */
	reset(dehello: Bytes): void {
		this.ephemeral = x25519.keygen()
		this.dehello = dehello
		this.hashHandshake = sha256(Buffer.from('Noise_INIT', 'utf8'))
	}
}

export interface HandshakeHello {
	hash: Bytes
	signature: Bytes
	ephemeral: Bytes
}

export interface ServerKeyMaterial {
	/** clave pública estática del servidor, con la que se verifica la firma */
	staticKey: Bytes
	/** hash de la clave estática que el servidor espera recibir */
	staticHash: Bytes
}

/**
 * Genera el primer mensaje del cliente (`clientHello`).
 *
 * `staticHash` es el hash SHA-256 de la clave estática compartida con el
 * servidor. Se construye como `sha256(sha256(derived))` porque WA lo hace
 * en dos rondas.
 */
export function createClientHello(
	state: HandshakeState,
	staticKey: Bytes,
	identityKey?: KeyPair
): { hello: HandshakeHello; derived: Bytes } {
	const derived = hkdf(state.noiseKey.private, 64, Buffer.alloc(32), WA_NOISE)
	const staticHash = sha256(sha256(derived))
	const hash = sha256(concat(staticHash, state.ephemeral.public))
	const signature = ed25519.sign(hash, (identityKey ?? state.noiseKey).private)
	return {
		hello: { hash, signature, ephemeral: state.ephemeral.public },
		derived
	}
}

export interface VerifiedServerHello {
	ephemeral: Bytes
	derived: Bytes
}

/** Valida el `serverHello` y devuelve la clave derivada de la sesión. */
export function processServerHello(
	hello: HandshakeHello,
	serverStaticKey: Bytes
): VerifiedServerHello {
	const verify = ed25519.verify(hello.signature, hello.hash, serverStaticKey)
	if (!verify) {
		throw new HandshakeError('la firma del serverHello no valida contra la clave del servidor')
	}
	const derived = x25519.getSharedSecret(serverStaticKey, hello.ephemeral)
	return { ephemeral: hello.ephemeral, derived }
}

/**
 * Cierra el handshake. `derived` es el secreto de la fase 0->1; aquí se mezcla
 * con la efímera del cliente y se deriva el par de claves de sesión.
 */
export function finishHandshake(
	state: HandshakeState,
	derived: Bytes,
	serverEphemeral: Bytes
): NoiseSession {
	const shared = x25519.getSharedSecret(state.ephemeral.private, serverEphemeral)
	const keys = hkdf(shared, 64, derived, WA_NOISE)
	return new NoiseSession(
		keys.subarray(0, KEY_LENGTH),   // readKey
		keys.subarray(KEY_LENGTH, 64),  // writeKey
		Buffer.alloc(NONCE_LENGTH),      // readCounter
		Buffer.alloc(NONCE_LENGTH),      // writeCounter
		state.hashHandshake
	)
}

/**
 * Cifra un payload con la clave de escritura.
 *
 * Cada mensaje lleva su propio nonce derivado del contador, de forma que
 * nunca se repite un par (clave, nonce) ni siquiera tras reconectar.
 */
export function encryptMessage(session: NoiseSession, plaintext: Bytes, aad: Bytes = Buffer.alloc(0)): Bytes {
	incrementCounter(session.writeCounter)
	const nonce = deriveNonce(session.writeCounter, session.hash)
	const cipher = chacha.encrypt(session.writeKey, nonce, plaintext, aad)
	// El nonce viaja explícito porque se incrementa por mensaje
	return concat(cipher, session.writeCounter)
}

export function decryptMessage(session: NoiseSession, payload: Bytes, aad: Bytes = Buffer.alloc(0)): Bytes {
	if (payload.length < NONCE_LENGTH + TAG_LENGTH) {
		throw new HandshakeError('payload de sesión demasiado corto')
	}
	const cipher = payload.subarray(0, payload.length - NONCE_LENGTH)
	const counter = Buffer.from(payload.subarray(payload.length - NONCE_LENGTH))
	// Se restaura el contador para poder derivar el mismo nonce
	const prevCounter = decrementCounter(counter)
	const nonce = deriveNonce(counter, session.hash)
	const plaintext = chacha.decrypt(session.readKey, nonce, cipher, aad)
	// El contador de lectura pasa al valor recibido
	session.readCounter.set(counter)
	void prevCounter
	return plaintext
}

function incrementCounter(counter: Bytes): void {
	for (let i = counter.length - 1; i >= 0; i--) {
		counter[i] = (counter[i]! + 1) & 0xff
		if (counter[i] !== 0) break
	}
}

function decrementCounter(counter: Bytes): Bytes {
	const out = Buffer.from(counter)
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i]! !== 0) { out[i] = out[i]! - 1; break }
		out[i] = 0xff
	}
	return out
}

function deriveNonce(counter: Bytes, hash: Bytes): Bytes {
	return hmacSha256(concat(hash, counter), Buffer.alloc(0)).subarray(0, NONCE_LENGTH)
}

/**
 * Token de versión que WhatsApp espera en el cliente.
 *
 * El servidor valida la firma P-256 con la clave pública que publica el bundle
 * web, así que hace falta un par de claves persistente por sesión.
 *
 * NOTA: el layout exacto de los offsets de este request es la parte del
 * protocolo que menos documentación tiene. La estructura de 68 bytes con
 * longitudes en los offsets 37-41 es una lectura del tráfico y está marcada
 * como tal; hay que contrastarla con una captura real antes de darla por buena.
 * Está aislado en esta función a propósito para poder corregirlo sin tocar el
 * resto del handshake.
 */
export function buildWaTokenRequest(
	privateKeyDer: Bytes,
	platform: number,
	version: number,
	flags: number,
	bk: string,
	iat: number,
	exp: number
): Bytes {
	const header = Buffer.alloc(68)
	header.writeUInt8(0x22, 0) // indicador: request
	header.writeUInt32LE(platform, 8)
	header.writeUInt32LE(version, 12)
	header.writeUInt32LE(flags, 16)
	header.writeUInt32LE(iat, 20)
	header.writeUInt32LE(exp, 24)
	header.writeUInt8(33, 37) // longitud de la pubkey
	header.writeUInt8(Math.min(privateKeyDer.length, 0xff), 38)
	header.writeUInt8(0x04, 39) // P-256 sin compresión

	return hkdf(
		concat(header, Buffer.from(bk, 'base64')),
		80,
		Buffer.from('salt_wa', 'utf8'),
		Buffer.from('info_wa', 'utf8')
	)
}
