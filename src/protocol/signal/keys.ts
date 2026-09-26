/**
 * Stores de claves de Signal.
 *
 * WhatsApp usa dos stores paralelos:
 *  - `SignalKeyStore`: identidad, prekeys y signed prekey del protocolo
 *    Signal clásico (lo que usan los contactos 1:1)
 *  - `LidSignalStore`: identidad de cuenta y prekeys del sistema LID, que es
 *    lo que se usa para grupos y para los chats con "device identity"
 */

export const SignalKeyType = {
	IDENTITY: 'IDENTITY',
	PRE_KEY: 'PRE_KEY',
	SIGNED_PRE_KEY: 'SIGNED_PRE_KEY'
} as const

export const LIDKeyType = {
	ACCOUNT: 'ACCOUNT',
	DEVICE: 'DEVICE',
	DEVICE_PREFIX: 'DEVICE_PREFIX',
	DEVICE_IDENTITY: 'DEVICE_IDENTITY',
	SIGNED_PRE_KEY: 'SIGNED_PRE_KEY',
	PRE_KEY: 'PRE_KEY'
} as const

export type SignalKeyId = string

export interface KeyId {
	/** jid del usuario, p.ej. "12345@s.whatsapp.net" */
	jid: SignalKeyId
	/** número de dispositivo, 0 si no aplica */
	deviceId: number
}

export type IdentityKeyId = KeyId & { identifier: number }

export interface PreKeyId extends KeyId {
	preKeyId: number
}

export interface SignedPreKeyId extends KeyId {
	signedPreKeyId: number
}

export interface SignalKeyPair {
	public: Buffer
	private: Buffer
}

export type SignalKeyMap = Map<string, SignalKeyPair>

export interface PreKeyBundle {
	registrationId: number
	preKeyId: number
	signedPreKeyId: number
	signedPreKey: Buffer
	signature: Buffer
	identityKey: Buffer
	/** opcional: prekey de un solo uso asociado */
	preKey?: Buffer
}

export interface SignalKeyStore {
	getIdentity(id: IdentityKeyId): Promise<Buffer | undefined>
	getPreKey(id: PreKeyId): Promise<SignalKeyPair | undefined>
	getSignedPreKey(id: SignedPreKeyId): Promise<SignalKeyPair | undefined>
	hasIdentity(id: IdentityKeyId): Promise<boolean>

	setIdentity(id: IdentityKeyId, key: Buffer): Promise<void>
	setPreKey(id: PreKeyId, key: SignalKeyPair): Promise<void>
	setSignedPreKey(id: SignedPreKeyId, key: SignalKeyPair): Promise<void>

	/** marca un prekey como consumido (los prekeys son de un solo uso) */
	removePreKey(id: PreKeyId): Promise<void>
	removeSignedPreKey(id: SignedPreKeyId): Promise<void>

	/** devuelve los prekeys con su id, para publicar el bundle */
	listPreKeys(id: KeyId, limit?: number): Promise<Array<{ id: number; key: SignalKeyPair }>>

	/** marca una identidad como verificada por el usuario (toast) */
	setTrust(id: IdentityKeyId, verified: boolean): Promise<void>
	isTrusted(id: IdentityKeyId): Promise<boolean | undefined>

	/** prekeys pendientes de subir al servidor */
	getUnuploadedPreKeys(id: KeyId): Promise<Array<{ id: number; key: SignalKeyPair }>>
	markPreKeysUploaded(id: KeyId): Promise<void>
}

export interface LidKeyStore {
	getAccount(id: KeyId): Promise<SignalKeyPair | undefined>
	getDevice(id: KeyId & { deviceId: number }): Promise<Buffer | undefined>
	setAccount(id: KeyId, key: SignalKeyPair): Promise<void>
	setDevice(id: KeyId & { deviceId: number }, key: Buffer): Promise<void>
	removeDevice(id: KeyId & { deviceId: number }): Promise<void>
	setSignedPreKey(id: SignedPreKeyId, key: SignalKeyPair): Promise<void>
	getSignedPreKey(id: SignedPreKeyId): Promise<SignalKeyPair | undefined>
	listPreKeys(id: KeyId, limit?: number): Promise<Array<{ id: number; key: SignalKeyPair }>>
	setPreKey(id: PreKeyId, key: SignalKeyPair): Promise<void>
	removePreKey(id: PreKeyId): Promise<void>
}

export function identityKeyId(jid: string, deviceId = 0): IdentityKeyId {
	return { identifier: 0, jid, deviceId }
}

export function preKeyId(jid: string, deviceId: number, preKeyId: number): PreKeyId {
	return { jid, deviceId, preKeyId }
}

export function signedPreKeyId(jid: string, deviceId: number, signedPreKeyId: number): SignedPreKeyId {
	return { jid, deviceId, signedPreKeyId }
}
