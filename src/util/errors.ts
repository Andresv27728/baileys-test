export class WasaError extends Error {
	readonly code: string
	readonly data?: unknown

	constructor(message: string, code = 'WASA_ERROR', data?: unknown) {
		super(message)
		this.name = 'WasaError'
		this.code = code
		this.data = data
	}
}

export class ConnectionError extends WasaError {
	constructor(message: string, data?: unknown) {
		super(message, 'CONNECTION_ERROR', data)
		this.name = 'ConnectionError'
	}
}

export class SessionError extends WasaError {
	constructor(message: string, data?: unknown) {
		super(message, 'SESSION_ERROR', data)
		this.name = 'SessionError'
	}
}

export class HandshakeError extends WasaError {
	constructor(message: string, data?: unknown) {
		super(message, 'HANDSHAKE_ERROR', data)
		this.name = 'HandshakeError'
	}
}

export class CryptoError extends WasaError {
	constructor(message: string, data?: unknown) {
		super(message, 'CRYPTO_ERROR', data)
		this.name = 'CryptoError'
	}
}

export class ProtoError extends WasaError {
	constructor(message: string, data?: unknown) {
		super(message, 'PROTO_ERROR', data)
		this.name = 'ProtoError'
	}
}

export class InvalidJidError extends WasaError {
	constructor(jid: string) {
		super(`jid inválido: ${jid}`, 'INVALID_JID', jid)
		this.name = 'InvalidJidError'
	}
}

export class NotFoundError extends WasaError {
	constructor(message: string) {
		super(message, 'NOT_FOUND')
		this.name = 'NotFoundError'
	}
}

export function isWasaError(err: unknown): err is WasaError {
	return err instanceof WasaError
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message
	if (typeof err === 'string') return err
	try {
		return JSON.stringify(err)
	} catch {
		return String(err)
	}
}

export class Deferred<T = void> {
	promise: Promise<T>
	resolve!: (value: T | PromiseLike<T>) => void
	reject!: (reason?: unknown) => void

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve
			this.reject = reject
		})
	}
}

export class Lock {
	private queue: Array<() => void> = []
	private locked = false

	async acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true
			return
		}
		await new Promise<void>(resolve => this.queue.push(resolve))
	}

	release(): void {
		const next = this.queue.shift()
		if (next) next()
		else this.locked = false
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await fn()
		} finally {
			this.release()
		}
	}
}
