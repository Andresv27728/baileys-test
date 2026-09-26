/**
 * Store en memoria. Es el default porque no arrastra dependencias, pero
 * OJO: sin persistencia el ratchet se rompe en cada reinicio.
 */

import { Collections, type BaseStore, type Collection, type Transaction } from './types.ts'
import type {
	IdentityKeyId, KeyId, LidKeyStore, PreKeyId, SignalKeyPair, SignalKeyStore, SignedPreKeyId
} from '../protocol/signal/keys.ts'

type Bucket = Map<string, unknown>

export class MemoryStore implements BaseStore {
	readonly binding: BaseStore['binding'] = {}
	private data = new Map<Collection, Bucket>()
	/** prekeys aún no subidos, por usuario */
	private unuploaded = new Map<string, Set<number>>()

	private bucket(collection: Collection): Bucket {
		let b = this.data.get(collection)
		if (!b) { b = new Map(); this.data.set(collection, b) }
		return b
	}

	async initialize(): Promise<void> { /* nada que hacer */ }
	async destroy(): Promise<void> { this.data.clear() }

	async get<T>(collection: string, id: string): Promise<T | undefined> {
		return this.bucket(collection).get(id) as T | undefined
	}

	async set<T>(collection: string, id: string, value: T): Promise<void> {
		this.bucket(collection).set(id, value)
	}

	async remove(collection: string, id: string): Promise<void> {
		this.bucket(collection).delete(id)
	}

	async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
		const staged = new Map<string, { collection: Collection; key: string; value?: unknown; remove?: boolean }>()
		const tx: Transaction = {
			get: async <V>(store: BaseStore, key: string[]) => {
				const [c, k] = key as [string, string]
				const stagedEntry = staged.get(`${c}\u0000${k}`)
				if (stagedEntry) return stagedEntry.remove ? undefined : (stagedEntry.value as V)
				return store.get<V>(c, k)
			},
			set: async <V>(_store: BaseStore, key: string[], value: V) => {
				const [c, k] = key as [string, string]
				staged.set(`${c}\u0000${k}`, { collection: c, key: k, value })
			},
			remove: async (_store: BaseStore, key: string[]) => {
				const [c, k] = key as [string, string]
				staged.set(`${c}\u0000${k}`, { collection: c, key: k, remove: true })
			}
		}
		const result = await work(tx)
		for (const entry of staged.values()) {
			if (entry.remove) this.bucket(entry.collection).delete(entry.key)
			else this.bucket(entry.collection).set(entry.key, entry.value)
		}
		return result
	}

	// -----------------------------------------------------------------------
	// Signal
	// -----------------------------------------------------------------------

	signal: SignalKeyStore = {
		getIdentity: async (id: IdentityKeyId) => this.get<Buffer>(Collections.IDENTITY, identityKey(id)),
		getPreKey: async (id: PreKeyId) => this.get<SignalKeyPair>(Collections.PRE_KEYS, preKeyId(id)),
		getSignedPreKey: async (id: SignedPreKeyId) => this.get<SignalKeyPair>(Collections.SIGNED_PRE_KEYS, signedPreKeyId(id)),
		hasIdentity: async (id: IdentityKeyId) => (await this.get(Collections.IDENTITY, identityKey(id))) !== undefined,
		setIdentity: async (id: IdentityKeyId, key: Buffer) => {
			await this.set(Collections.IDENTITY, identityKey(id), key)
		},
		setPreKey: async (id: PreKeyId, key: SignalKeyPair) => {
			await this.set(Collections.PRE_KEYS, preKeyId(id), key)
			this.markUnuploaded(id.jid, id.preKeyId)
		},
		setSignedPreKey: async (id: SignedPreKeyId, key: SignalKeyPair) => {
			await this.set(Collections.SIGNED_PRE_KEYS, signedPreKeyId(id), key)
		},
		removePreKey: async (id: PreKeyId) => { await this.remove(Collections.PRE_KEYS, preKeyId(id)) },
		removeSignedPreKey: async (id: SignedPreKeyId) => { await this.remove(Collections.SIGNED_PRE_KEYS, signedPreKeyId(id)) },
		listPreKeys: async (id: KeyId, limit = 10) => {
			const out: Array<{ id: number; key: SignalKeyPair }> = []
			for (let i = 0; i < limit; i++) {
				const key = await this.get<SignalKeyPair>(Collections.PRE_KEYS, preKeyId({ ...id, preKeyId: i }))
				if (key) out.push({ id: i, key })
			}
			return out
		},
		setTrust: async (id: IdentityKeyId, verified: boolean) => {
			await this.set(`${Collections.IDENTITY}:trust`, identityKey(id), verified)
		},
		isTrusted: async (id: IdentityKeyId) => this.get<boolean>(`${Collections.IDENTITY}:trust`, identityKey(id)),
		getUnuploadedPreKeys: async (id: KeyId) => {
			const ids = [...(this.unuploaded.get(id.jid) ?? [])]
			const out: Array<{ id: number; key: SignalKeyPair }> = []
			for (const pid of ids) {
				const key = await this.get<SignalKeyPair>(Collections.PRE_KEYS, preKeyId({ ...id, preKeyId: pid }))
				if (key) out.push({ id: pid, key })
			}
			return out
		},
		markPreKeysUploaded: async (id: KeyId) => { this.unuploaded.delete(id.jid) }
	}

	lid: LidKeyStore = {
		getAccount: async (id: KeyId) => this.get<SignalKeyPair>(Collections.LID_ACCOUNT, keyId(id)),
		getDevice: async (id: KeyId & { deviceId: number }) => this.get<Buffer>(Collections.LID_DEVICE, keyId(id)),
		setAccount: async (id: KeyId, key: SignalKeyPair) => { await this.set(Collections.LID_ACCOUNT, keyId(id), key) },
		setDevice: async (id: KeyId & { deviceId: number }, key: Buffer) => { await this.set(Collections.LID_DEVICE, keyId(id), key) },
		removeDevice: async (id: KeyId & { deviceId: number }) => { await this.remove(Collections.LID_DEVICE, keyId(id)) },
		setSignedPreKey: async (id: SignedPreKeyId, key: SignalKeyPair) => { await this.set(Collections.LID_SIGNED_PRE_KEYS, signedPreKeyId(id), key) },
		getSignedPreKey: async (id: SignedPreKeyId) => this.get<SignalKeyPair>(Collections.LID_SIGNED_PRE_KEYS, signedPreKeyId(id)),
		setPreKey: async (id: PreKeyId, key: SignalKeyPair) => { await this.set(Collections.LID_PRE_KEYS, preKeyId(id), key) },
		removePreKey: async (id: PreKeyId) => { await this.remove(Collections.LID_PRE_KEYS, preKeyId(id)) },
		listPreKeys: async (id: KeyId, limit = 10) => {
			const out: Array<{ id: number; key: SignalKeyPair }> = []
			for (let i = 0; i < limit; i++) {
				const key = await this.get<SignalKeyPair>(Collections.LID_PRE_KEYS, preKeyId({ ...id, preKeyId: i }))
				if (key) out.push({ id: i, key })
			}
			return out
		}
	}

	markUnuploaded(jid: string, preKeyId: number): void {
		let set = this.unuploaded.get(jid)
		if (!set) { set = new Set(); this.unuploaded.set(jid, set) }
		set.add(preKeyId)
	}
}

export function identityKey(id: IdentityKeyId): string {
	return `${id.jid},${id.deviceId},${id.identifier}`
}

export function preKeyId(id: PreKeyId): string {
	return `${id.jid},${id.deviceId},${id.preKeyId}`
}

export function signedPreKeyId(id: SignedPreKeyId): string {
	return `${id.jid},${id.deviceId},${id.signedPreKeyId}`
}

export function keyId(id: KeyId & { deviceId?: number }): string {
	return `${id.jid},${id.deviceId ?? 0}`
}
