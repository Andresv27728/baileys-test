/**
 * Contrato de persistencia.
 *
 * Todo el estado criptográfico (claves de Signal, sesiones, prekeys) tiene que
 * sobrevivir a un reinicio. Si se pierde, el Double Ratchet se desincroniza y
 * los mensajes que lleguen en desorden dejan de descifrarse.
 */

import type { SignalKeyPair, SignalKeyStore, LidKeyStore, IdentityKeyId, PreKeyId, SignedPreKeyId, KeyId } from '../protocol/signal/keys.ts'

export type Transaction = {
	/** Lee del store */
	get<T>(store: BaseStore, key: string[]): Promise<T | undefined>
	set<T>(store: BaseStore, key: string[], value: T): Promise<void>
	remove(store: BaseStore, key: string[]): Promise<void>
}

export interface BaseStore {
	transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>
	binding: { account?: string; me?: { id?: string; lid?: string } }
	get<T>(collection: string, id: string): Promise<T | undefined>
	set<T>(collection: string, id: string, value: T): Promise<void>
	remove(collection: string, id: string): Promise<void>
	initialize(): Promise<void>
	destroy(): Promise<void>
	/** store de claves de Signal del protocolo clásico */
	signal: SignalKeyStore
	/** store de claves LID (identidad de cuenta) */
	lid: LidKeyStore
}

export type Collection = string

/** Colecciones que usa el socket. */
export const Collections = {
	IDENTITY: 'identity',
	PRE_KEYS: 'preKeys',
	SIGNED_PRE_KEYS: 'signedPreKeys',
	LID_ACCOUNT: 'lid-account',
	LID_DEVICE: 'lid-device',
	LID_PRE_KEYS: 'lid-preKeys',
	LID_SIGNED_PRE_KEYS: 'lid-signedPreKeys',
	SESSIONS: 'signal-sessions',
	APP_STATE: 'app-state',
	SENDER_KEYS: 'sender-keys',
	REGISTRATION: 'registration',
	PROCESSED: 'processed',
	MEDIA: 'media'
} as const

export interface SignalStoreBundle {
	signal: SignalKeyStore
	lid: LidKeyStore
	/** prekeys que aún no se han subido al servidor */
	unuploadedPreKeys(): Promise<Record<string, number[]>>
	markPreKeysUploaded(): Promise<void>
}

export type { SignalKeyPair, SignalKeyStore, LidKeyStore, IdentityKeyId, PreKeyId, SignedPreKeyId, KeyId }
