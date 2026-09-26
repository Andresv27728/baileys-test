/**
 * Fábrica de las claves propias de Signal.
 *
 * Al arrancar hay que tener listos: identidad, prekey firmado y un pool de
 * prekeys de un solo uso. El `registrationId` es un número aleatorio que
 * identifica este dispositivo frente al resto de sesiones del mismo usuario.
 */

import { Buffer } from 'node:buffer'
import {
	identity, p256, randomBytes, x25519,
	type Bytes, type IdentityKeyPair, type KeyPair
} from '../crypto/primitives.ts'
import { Collections } from './types.ts'
import type { BaseStore } from './types.ts'
import type { OwnIdentity } from '../protocol/signal/session.ts'
import { identityKey, keyId, preKeyId, signedPreKeyId } from './memory.ts'

/** Cuántos prekeys de un solo uso se mantienen publicados. */
export const PRE_KEY_COUNT = 10
export const PRE_KEY_START = 1
export const PRE_KEY_MAX = PRE_KEY_START + PRE_KEY_COUNT

export interface Registration {
	noiseKey: KeyPair
	/** par P-256 para el token de versión */
	registrationP256: { publicKey: Buffer; privateKey: Buffer }
	signedPreKeyId: number
	/** identidad propia de Signal */
	identity: { public: Buffer; private: Buffer }
	registrationId: number
	advancedSecretKey: Buffer
	/** id de esta sesión tal y como lo ve el servidor */
	sessionId: string
	/** el servidor ya nos tiene registrado */
	registered: boolean
	pairingCode?: string
	me?: { id: string; lid?: string; name?: string }
	platform: number
	webInfo: { platform: number; webSubPlatform: number }
	deviceProps: { os: string; platformType: number; requireFullSync: boolean }
}

const REGISTRATION_ID = Collections.REGISTRATION

/** Crea (o recupera) el registro de esta sesión. */
export async function initAuthState(store: BaseStore, opts: { platform: number; webSubPlatform: number }): Promise<Registration> {
	await store.initialize()
	const existing = await store.get<Registration>(REGISTRATION_ID, 'creds')
	if (existing) return existing

	const creds: Registration = {
		noiseKey: x25519.keygen(),
		registrationP256: p256.generateKeyPair(),
		signedPreKeyId: 1,
		identity: { public: Buffer.alloc(32), private: randomBytes(32) },
		registrationId: randomBytes(2).readUInt16BE(0) + 1,
		advancedSecretKey: randomBytes(32),
		sessionId: randomBytes(16).toString('hex'),
		registered: false,
		platform: opts.platform,
		webInfo: { platform: opts.platform, webSubPlatform: opts.webSubPlatform },
		deviceProps: { os: 'Wasa', platformType: opts.platform, requireFullSync: true }
	}
	// Del mismo seed salen las dos públicas de identidad: la X25519 (la que se
	// publica como `identityKey`) y la Ed25519 (la que verifica las firmas de
	// los prekeys). `identity.derivePublic` es la única fuente de verdad para no
	// acabar publicando una clave donde se espera la otra.
	creds.identity.public = identity.derivePublic(creds.identity.private).public

	await store.set(REGISTRATION_ID, 'creds', creds)
	await store.set(Collections.REGISTRATION, 'pairing', { ref: randomBytes(16).toString('base64') })
	return creds
}

export async function saveRegistration(store: BaseStore, creds: Registration): Promise<void> {
	await store.set(REGISTRATION_ID, 'creds', creds)
}

/**
 * Carga las claves propias de Signal desde el store y rellena el pool de
 * prekeys. Si no hay, genera todo desde cero.
 */
export async function loadOrCreateOwnIdentity(store: BaseStore, creds: Registration): Promise<OwnIdentity> {
	const meId = creds.me?.id ?? '0@s.whatsapp.net'
	const keyScope = { jid: meId, deviceId: 0 }

	// identidad: la pública se deriva de la privada en las dos representaciones
	let identityPair = await store.get<IdentityKeyPair>(Collections.PRE_KEYS, 'own-identity')
	if (!identityPair) {
		identityPair = identity.derivePublic(creds.identity.private)
		await store.set(Collections.PRE_KEYS, 'own-identity', identityPair)
	} else {
		// una sesión vieja puede no tener la ed25519Public guardada
		identityPair = identity.derivePublic(identityPair.private)
	}

	// prekey firmado
	const spkId = { ...keyScope, signedPreKeyId: creds.signedPreKeyId }
	let signedPreKey = await store.get<{ public: Bytes; private: Bytes }>(Collections.SIGNED_PRE_KEYS, signedPreKeyId(spkId))
	if (!signedPreKey) {
		signedPreKey = x25519.keygen()
		await store.set(Collections.SIGNED_PRE_KEYS, signedPreKeyId(spkId), signedPreKey)
	}

	// pool de prekeys de un solo uso
	const preKeys = new Map<number, { public: Bytes; private: Bytes }>()
	for (let i = PRE_KEY_START; i < PRE_KEY_MAX; i++) {
		const id = { ...keyScope, preKeyId: i }
		const existing = await store.get<{ public: Bytes; private: Bytes }>(Collections.PRE_KEYS, preKeyId(id))
		if (existing) { preKeys.set(i, existing); continue }
		const fresh = x25519.keygen()
		preKeys.set(i, fresh)
		await store.set(Collections.PRE_KEYS, preKeyId(id), fresh)
	}

	// la identidad de Signal se publica en su propia colección
	await store.set(Collections.IDENTITY, identityKey({ ...keyScope, identifier: 0 }), identityPair.public)

	return {
		identityKeyPair: identityPair,
		signedPreKeyPair: signedPreKey as unknown as KeyPair,
		registrationId: creds.registrationId,
		preKeys
	}
}

/** Marca la sesión como registrada y guarda el número vinculado. */
export async function markRegistered(
	store: BaseStore,
	creds: Registration,
	me: { id: string; lid?: string; name?: string }
): Promise<Registration> {
	const next: Registration = { ...creds, registered: true, me }
	await saveRegistration(store, next)
	return next
}

/** Identidades de las cuentas propias: msisdn (`id`) y LID (`lid`). */
export async function storeSelfIdentity(store: BaseStore, creds: Registration): Promise<void> {
	if (!creds.me) return
	await store.set(Collections.LID_ACCOUNT, keyId({ jid: creds.me.id, deviceId: 0 }), creds.identity)
	if (creds.me.lid) {
		await store.set(Collections.LID_ACCOUNT, keyId({ jid: creds.me.lid, deviceId: 0 }), creds.identity)
	}
}
