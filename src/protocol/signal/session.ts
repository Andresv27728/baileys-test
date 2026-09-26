/**
 * Sesión Signal de extremo a extremo: el pegamento entre X3DH, el Double
 * Ratchet y el envelope `Cipher` que espera el servidor.
 *
 * `SignalSession` mantiene una sesión por (usuario, dispositivo). El socket
 * guarda un `SessionManager` que las indexa.
 */

import { Buffer } from 'node:buffer'
import { concat } from '../../util/buffer.ts'
import { CryptoError, NotFoundError, SessionError } from '../../util/errors.ts'
import { x25519, type Bytes, type IdentityKeyPair, type KeyPair } from '../../crypto/primitives.ts'
import { decode, encode, type ProtoObject } from '../../proto/codec.ts'
import {
	SignalMessage, PreSignalMessage, DecryptedSignalMessage, MessageKey
} from '../../proto/schema.ts'
import {
	exportRatchetState, importRatchetState, initRatchet, ratchetDecrypt, ratchetEncrypt,
	type RatchetState
} from './ratchet.ts'
import { x3dhAccept, x3dhInitiate, type PreKeyBundleRemote } from './x3dh.ts'
import type { IdentityKeyId, PreKeyId, SignalKeyPair, SignalKeyStore, SignedPreKeyId } from './keys.ts'

export const MSG_VERSION = 'v1' as const

/** Claves propias que se necesitan para cualquier cifrado. */
export interface OwnIdentity {
	/** identidad de Signal (ed25519) con su parte privada */
	identityKeyPair: IdentityKeyPair
	/** prekey firmado vigente */
	signedPreKeyPair: KeyPair
	/** registro numérico de esta sesión */
	registrationId: number
	/** prekeys de un solo uso disponibles */
	preKeys: Map<number, SignalKeyPair>
}

export interface RemoteSessionState {
	identityKey: Bytes
	baseKey: Bytes
	registrationId: number
	preKeyId?: number
	signedPreKeyId?: number
	/** prekey de un solo uso que se consumió al iniciar la sesión */
	oneTimePreKey?: Bytes
}

export class SignalSession {
	readonly id: string
	private ratchet: RatchetState
	private preKeyState?: RemoteSessionState

	constructor(id: string, ratchet: RatchetState, preKeyState?: RemoteSessionState) {
		this.id = id
		this.ratchet = ratchet
		this.preKeyState = preKeyState
	}

	/** Identidad conocida del par, para mostrarla y verificarla. */
	get theirIdentityKey(): Bytes | undefined {
		return this.preKeyState?.identityKey
	}

	export(): Record<string, unknown> {
		return {
			id: this.id,
			ratchet: exportRatchetState(this.ratchet),
			preKeyState: this.preKeyState
				? {
					identityKey: this.preKeyState.identityKey.toString('base64'),
					baseKey: this.preKeyState.baseKey.toString('base64'),
					registrationId: this.preKeyState.registrationId,
					preKeyId: this.preKeyState.preKeyId,
					signedPreKeyId: this.preKeyState.signedPreKeyId,
					oneTimePreKey: this.preKeyState.oneTimePreKey?.toString('base64')
				}
				: undefined
		}
	}

	static import(raw: Record<string, unknown>): SignalSession {
		const ratchet = importRatchetState((raw.ratchet ?? {}) as Record<string, unknown>)
		const pks = raw.preKeyState as Record<string, unknown> | undefined
		const preKeyState: RemoteSessionState | undefined = pks
			? {
				identityKey: Buffer.from(String(pks.identityKey), 'base64'),
				baseKey: Buffer.from(String(pks.baseKey), 'base64'),
				registrationId: Number(pks.registrationId ?? 0),
				preKeyId: pks.preKeyId !== undefined ? Number(pks.preKeyId) : undefined,
				signedPreKeyId: pks.signedPreKeyId !== undefined ? Number(pks.signedPreKeyId) : undefined,
				oneTimePreKey: typeof pks.oneTimePreKey === 'string' ? Buffer.from(pks.oneTimePreKey, 'base64') : undefined
			}
			: undefined
		return new SignalSession(String(raw.id), ratchet, preKeyState)
	}

	// -----------------------------------------------------------------------
	// Lado emisor
	// -----------------------------------------------------------------------

	/**
	 * Cifra `plaintext` con el ratchet y devuelve el `SignalProtocolMessage`
	 * listo para meter en el nodo `msg` con tipo `ciphertext`.
	 */
	encrypt(plaintext: Bytes): { ciphertext: string; signalMessage: ProtoObject } {
		const { ciphertext, header } = ratchetEncrypt(this.ratchet, plaintext, MSG_VERSION)
		const signalMessage = encode(SignalMessage, {
			ratchetKey: header.ratchetKey,
			counter: header.counter,
			previousCounter: header.previousCounter,
			ciphertext
		} as ProtoObject)
		return { ciphertext: signalMessage.toString('base64'), signalMessage: decode(SignalMessage, signalMessage) }
	}

	/**
	 * Cifra el primer mensaje de una sesión nueva. El resultado es un
	 * `PreSignalMessage` (no se ratchetea todavía, se encapsula en X3DH).
	 */
	encryptFirst(plaintext: Bytes, remote: PreKeyBundleRemote): {
		ciphertext: string
		presignal: ProtoObject
		ephemeralPublic: Bytes
	} {
		const ephemeral = x25519.keygen()
		const x3dh = x3dhInitiate(
			{ identityKey: this.ratchet.identityKeyPair, signedPreKey: this.ratchet.signedPreKeyPair },
			remote,
			ephemeral
		)

		// Con la chain key derivada de X3DH se inicializa el ratchet
		this.ratchet = initRatchet({
			sharedSecret: x3dh.sharedSecret,
			chainKey: x3dh.chainKey,
			identityKeyPair: this.ratchet.identityKeyPair,
			signedPreKeyPair: this.ratchet.signedPreKeyPair
			// theirBaseKey se deja sin conocer: la clave de ratchet del peer aún no
			// nos la ha enseñado, y poner aquí nuestra propia efímera haría que el
			// primer DH ratchet mezclara una clave que el otro lado no tiene.
		})
		this.preKeyState = {
			identityKey: remote.identityKey,
			baseKey: x3dh.ephemeralPublic,
			registrationId: remote.registrationId,
			preKeyId: remote.preKeyId,
			signedPreKeyId: remote.signedPreKeyId,
			oneTimePreKey: remote.preKey
		}

		const { ciphertext, header } = ratchetEncrypt(this.ratchet, plaintext, MSG_VERSION)
		const signalMessage = encode(SignalMessage, {
			ratchetKey: header.ratchetKey,
			counter: header.counter,
			previousCounter: header.previousCounter,
			ciphertext
		} as ProtoObject)

		const presignal = encode(PreSignalMessage, {
			registrationId: remote.registrationId,
			preKeyId: remote.preKeyId,
			signedPreKeyId: remote.signedPreKeyId,
			baseKey: x3dh.ephemeralPublic,
			identityKey: this.ratchet.identityKeyPair.public,
			message: new Uint8Array(signalMessage)
		} as ProtoObject)

		return {
			ciphertext: presignal.toString('base64'),
			presignal: decode(PreSignalMessage, presignal),
			ephemeralPublic: x3dh.ephemeralPublic
		}
	}

	// -----------------------------------------------------------------------
	// Lado receptor
	// -----------------------------------------------------------------------

	/**
	 * Descifra un `SignalMessage` ya pasado por el ratchet.
	 * Devuelve `null` si es un duplicado que ya se había procesado.
	 */
	decrypt(signalMsg: ProtoObject): Bytes | null {
		const parsed = decode(SignalMessage, signalMsg as never)
		const ratchetKey = parsed.ratchetKey as Bytes
		const counter = Number(parsed.counter ?? 0)
		const previousCounter = Number(parsed.previousCounter ?? 0)
		const ciphertext = parsed.ciphertext as Bytes
		if (!ratchetKey || !ciphertext) throw new SessionError('SignalMessage incompleto')
		return ratchetDecrypt(
			this.ratchet,
			{ ratchetKey, counter, previousCounter },
			ciphertext,
			MSG_VERSION
		)
	}

	/**
	 * Procesa el primer mensaje de una sesión entrante.
	 * Devuelve el plaintext y el `DecryptedSignalMessage` que hay que
	 * devolverle al servidor para confirmar la entrega.
	 */
	decryptFirst(params: {
		presignal: ProtoObject
		messageKeyBytes: Bytes
		ownIdentity: OwnIdentity
		store: SignalKeyStore
		remoteIdentityId: IdentityKeyId
	}): { plaintext: Bytes; decryptedMessage: string; remote: RemoteSessionState } {
		const pre = decode(PreSignalMessage, params.presignal as never)
		const remoteIdentityKey = pre.identityKey as Bytes
		const senderBaseKey = pre.baseKey as Bytes
		const usedPreKeyId = Number(pre.preKeyId ?? 0)
		const signedPreKeyId = Number(pre.signedPreKeyId ?? 1)

		if (!remoteIdentityKey || !senderBaseKey) {
			throw new CryptoError('PreSignalMessage sin identidad o baseKey')
		}

		// X3DH necesita el prekey de un solo uso que el emisor consumió
		const oneTime = params.ownIdentity.preKeys.get(usedPreKeyId)
		const ownSigned = params.ownIdentity.signedPreKeyPair

		const accepted = x3dhAccept(
			{
				identityKey: params.ownIdentity.identityKeyPair,
				signedPreKey: ownSigned,
				oneTimePreKey: oneTime
			},
			{ ephemeralKey: senderBaseKey, identityKey: remoteIdentityKey }
		)

		// Los prekeys son de un solo uso: se consumen al_descifrar_
		if (oneTime) {
			params.ownIdentity.preKeys.delete(usedPreKeyId)
			void params.store.removePreKey({
				jid: params.remoteIdentityId.jid,
				deviceId: params.remoteIdentityId.deviceId,
				preKeyId: usedPreKeyId
			} satisfies PreKeyId)
		}

		const ratchet = initRatchet({
			sharedSecret: accepted.sharedSecret,
			chainKey: accepted.chainKey,
			identityKeyPair: params.ownIdentity.identityKeyPair,
			signedPreKeyPair: ownSigned,
			baseKeyPair: x25519.keygen(),
			theirBaseKey: senderBaseKey
		})
		const session = new SignalSession(this.id, ratchet)

		const signalMsg = decode(SignalMessage, pre.message as Bytes)
		const plaintext = session.decrypt(signalMsg)
		if (!plaintext) throw new SessionError('no se pudo descifrar el primer mensaje')

		this.ratchet = ratchet
		this.preKeyState = {
			identityKey: remoteIdentityKey,
			baseKey: senderBaseKey,
			registrationId: Number(pre.registrationId ?? 0),
			preKeyId: usedPreKeyId,
			signedPreKeyId,
			oneTimePreKey: oneTime?.public
		}

		// El `DecryptedSignalMessage` viaja al servidor como base64 dentro de
		// un nodo `msg` de tipo `ciphertext`, para confirmar la entrega.
		const decryptedMessage = encode(DecryptedSignalMessage, {
			registrationId: Number(pre.registrationId ?? 0),
			key: decode(MessageKey, params.messageKeyBytes)
		} as ProtoObject).toString('base64')

		return {
			plaintext,
			decryptedMessage,
			remote: this.preKeyState
		}
	}

	/** Identidad del par tal y como se conoce ahora. */
	remote(): RemoteSessionState | undefined {
		return this.preKeyState
	}
}

// -----------------------------------------------------------------------

/** Índice de sesiones por (jid, device). */
export class SessionManager {
	private sessions = new Map<string, SignalSession>()

	static sessionId(jid: string, deviceId = 0): string {
		return `${jid}.${deviceId}`
	}

	get(jid: string, deviceId = 0): SignalSession {
		const id = SessionManager.sessionId(jid, deviceId)
		let session = this.sessions.get(id)
		if (!session) throw new NotFoundError(`no hay sesión con ${id}`)
		return session
	}

	has(jid: string, deviceId = 0): boolean {
		return this.sessions.has(SessionManager.sessionId(jid, deviceId))
	}

	set(jid: string, deviceId: number, session: SignalSession): void {
		this.sessions.set(SessionManager.sessionId(jid, deviceId), session)
	}

	remove(jid: string, deviceId = 0): void {
		this.sessions.delete(SessionManager.sessionId(jid, deviceId))
	}

	list(): SignalSession[] {
		return [...this.sessions.values()]
	}

	clear(): void {
		this.sessions.clear()
	}

	export(): Array<Record<string, unknown>> {
		return this.list().map(s => s.export())
	}

	import(raw: Array<Record<string, unknown>>): void {
		for (const entry of raw) {
			const session = SignalSession.import(entry)
			this.sessions.set(session.id, session)
		}
	}
}

export { concat }
export type { RatchetState, PreKeyBundleRemote, IdentityKeyId, SignedPreKeyId, SignalKeyStore }