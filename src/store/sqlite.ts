/**
 * Store persistente sobre `node:sqlite` (built-in de Node, sin dependencias).
 *
 * Guardar `Buffer` en SQLite exige una representación: aquí se usa base64 en
 * columnas TEXT. Para el volumen de claves de Signal da igual; si algún día
 * hay millones de filas, el paso natural es BLOB.
 *
 * El esquema es genérico: una tabla por colección, clave primaria textual.
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Collections, type BaseStore, type Collection, type Transaction } from './types.ts'
import { identityKey, keyId, preKeyId, signedPreKeyId } from './memory.ts'
import type {
	IdentityKeyId, KeyId, LidKeyStore, PreKeyId, SignalKeyPair, SignalKeyStore, SignedPreKeyId
} from '../protocol/signal/keys.ts'

const ALL_COLLECTIONS: Collection[] = [
	Collections.IDENTITY,
	Collections.PRE_KEYS,
	Collections.SIGNED_PRE_KEYS,
	Collections.LID_ACCOUNT,
	Collections.LID_DEVICE,
	Collections.LID_PRE_KEYS,
	Collections.LID_SIGNED_PRE_KEYS,
	Collections.SESSIONS,
	Collections.APP_STATE,
	Collections.SENDER_KEYS,
	Collections.REGISTRATION,
	Collections.PROCESSED,
	Collections.MEDIA,
	`${Collections.IDENTITY}:trust`
]

export interface SqliteStoreOptions {
	/** ruta del fichero; si se omite, guarda en `<dir>/store.sqlite` */
	file?: string
	/** directorio donde vive el store */
	dir?: string
}

export class SqliteStore implements BaseStore {
	readonly binding: BaseStore['binding'] = {}
	private db: DatabaseSync | null = null
	private readonly file: string
	private staging: Map<string, { collection: string; key: string; value?: unknown; remove?: boolean }> = new Map()

	constructor(opts: SqliteStoreOptions = {}) {
		const dir = opts.dir ?? join(process.cwd(), '.wasa')
		mkdirSync(dir, { recursive: true })
		this.file = opts.file ?? join(dir, 'store.sqlite')
	}

	initialize(): Promise<void> {
		if (this.db) return Promise.resolve()
		this.db = new DatabaseSync(this.file)
		this.db.exec('PRAGMA journal_mode = WAL')
		this.db.exec('PRAGMA synchronous = NORMAL')
		for (const c of ALL_COLLECTIONS) {
			this.db.exec(`CREATE TABLE IF NOT EXISTS "${c}" (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
		}
		return Promise.resolve()
	}

	destroy(): Promise<void> {
		if (this.db) {
			this.db.close()
			this.db = null
		}
		return Promise.resolve()
	}

	private requireDb(): DatabaseSync {
		if (!this.db) throw new Error('SqliteStore sin initialize()')
		return this.db
	}

	async get<T>(collection: string, id: string): Promise<T | undefined> {
		const db = this.requireDb()
		const row = db.prepare(`SELECT v FROM "${collection}" WHERE k = ?`).get(id) as { v: string } | undefined
		return row ? (JSON.parse(row.v, reviver) as T) : undefined
	}

	async set<T>(collection: string, id: string, value: T): Promise<void> {
		const db = this.requireDb()
		db.prepare(`INSERT INTO "${collection}" (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
			.run(id, JSON.stringify(value, replacer))
	}

	async remove(collection: string, id: string): Promise<void> {
		this.requireDb().prepare(`DELETE FROM "${collection}" WHERE k = ?`).run(id)
	}

	async listKeys(collection: string): Promise<string[]> {
		const rows = this.requireDb().prepare(`SELECT k FROM "${collection}"`).all() as Array<{ k: string }>
		return rows.map(r => r.k)
	}

	async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
		this.staging.clear()
		const tx: Transaction = {
			get: async <V>(_store: BaseStore, key: string[]) => {
				const [c, k] = key as [string, string]
				const s = this.staging.get(`${c}\u0000${k}`)
				if (s) return s.remove ? undefined : (s.value as V)
				return this.get<V>(c, k)
			},
			set: async <V>(_store: BaseStore, key: string[], value: V) => {
				const [c, k] = key as [string, string]
				this.staging.set(`${c}\u0000${k}`, { collection: c, key: k, value })
			},
			remove: async (_store: BaseStore, key: string[]) => {
				const [c, k] = key as [string, string]
				this.staging.set(`${c}\u0000${k}`, { collection: c, key: k, remove: true })
			}
		}
		const result = await work(tx)
		// un solo commit: o se escriben todos los cambios, o ninguno
		const db = this.requireDb()
		db.exec('BEGIN')
		try {
			for (const s of this.staging.values()) {
				if (s.remove) {
					db.prepare(`DELETE FROM "${s.collection}" WHERE k = ?`).run(s.key)
				} else {
					db.prepare(`INSERT INTO "${s.collection}" (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
						.run(s.key, JSON.stringify(s.value, replacer))
				}
			}
			db.exec('COMMIT')
		} catch (err) {
			db.exec('ROLLBACK')
			throw err
		} finally {
			this.staging.clear()
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
		setIdentity: async (id: IdentityKeyId, key: Buffer) => { await this.set(Collections.IDENTITY, identityKey(id), key) },
		setPreKey: async (id: PreKeyId, key: SignalKeyPair) => { await this.set(Collections.PRE_KEYS, preKeyId(id), key) },
		setSignedPreKey: async (id: SignedPreKeyId, key: SignalKeyPair) => { await this.set(Collections.SIGNED_PRE_KEYS, signedPreKeyId(id), key) },
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
			// la "carga pendiente" se deduce del propio store: lo que exista
			// y no esté marcado como subido
			const uploaded = new Set(await this.get<number[]>(Collections.REGISTRATION, `uploaded:${id.jid}`) ?? [])
			const out: Array<{ id: number; key: SignalKeyPair }> = []
			for (let i = 0; i < 10; i++) {
				if (uploaded.has(i)) continue
				const key = await this.get<SignalKeyPair>(Collections.PRE_KEYS, preKeyId({ ...id, preKeyId: i }))
				if (key) out.push({ id: i, key })
			}
			return out
		},
		markPreKeysUploaded: async (id: KeyId) => {
			const ids = (await this.get<number[]>(Collections.REGISTRATION, `uploaded:${id.jid}`) ?? [])
			const all = new Set<number>(ids)
			for (let i = 0; i < 10; i++) {
				if (await this.get(Collections.PRE_KEYS, preKeyId({ ...id, preKeyId: i }))) all.add(i)
			}
			await this.set(Collections.REGISTRATION, `uploaded:${id.jid}`, [...all])
		}
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

	// -----------------------------------------------------------------------
	// Export / import para backup
	// -----------------------------------------------------------------------

	async exportAll(): Promise<Record<string, Record<string, unknown>>> {
		const out: Record<string, Record<string, unknown>> = {}
		for (const c of ALL_COLLECTIONS) {
			const keys = await this.listKeys(c)
			if (keys.length === 0) continue
			out[c] = {}
			for (const k of keys) out[c]![k] = (await this.get(c, k)) ?? null
		}
		return out
	}

	async importAll(data: Record<string, Record<string, unknown>>): Promise<void> {
		for (const [c, entries] of Object.entries(data)) {
			if (!ALL_COLLECTIONS.includes(c as Collection)) continue
			for (const [k, v] of Object.entries(entries)) {
				await this.set(c, k, v)
			}
		}
	}

	async exportToFile(path: string): Promise<void> {
		const data = await this.exportAll()
		mkdirSync(dirname(path), { recursive: true })
		const tmp = `${path}.tmp`
		writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
		renameSync(tmp, path)
	}

	async importFromFile(path: string): Promise<void> {
		if (!existsSync(path)) return
		await this.importAll(JSON.parse(readFileSync(path, 'utf8'), reviver) as Record<string, Record<string, unknown>>)
	}
}

/** `Buffer` no es JSON-serializable de forma útil: se guarda en base64. */
function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { $b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
	}
	return value
}

/** Inversa del `replacer`: reconstruye los Buffer serializados. */
function reviver(_key: string, value: unknown): unknown {
	if (value && typeof value === 'object' && typeof (value as { $b64?: unknown }).$b64 === 'string') {
		return Buffer.from((value as { $b64: string }).$b64, 'base64')
	}
	return value
}
