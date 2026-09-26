/**
 * Temporizadores de la conexión: keepalive, reconexión y expiración de QR.
 *
 * Se agrupan aquí para poder cancelarlos todos de golpe al hacer logout, que
 * si no deja timers colgados y el proceso no termina.
 */

import type { ConnectionState } from './events.ts'

export interface TimersConfig {
	keepAliveIntervalMs: number
	receivedPendingNotifications: boolean
}

export class Timers {
	private keepAlive: NodeJS.Timeout | null = null
	private reconnect: NodeJS.Timeout | null = null
	private pingTimeout: NodeJS.Timeout | null = null
	private attempts = 0
	private lastDisconnectAt = 0
	/** true mientras estamos reconectando: evita reconexiones duplicadas */
	private reconnecting = false

	private readonly onKeepAlive: () => void
	private readonly onReconnect: () => void
	private readonly onTimeout: (state: ConnectionState) => void
	private readonly config: TimersConfig

	// Campos explícitos en vez de parameter properties: el strip-only de Node no
	// las soporta (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
	constructor(
		onKeepAlive: () => void,
		onReconnect: () => void,
		onTimeout: (state: ConnectionState) => void,
		config: TimersConfig
	) {
		this.onKeepAlive = onKeepAlive
		this.onReconnect = onReconnect
		this.onTimeout = onTimeout
		this.config = config
	}

	startKeepAlive(): void {
		this.stopKeepAlive()
		this.keepAlive = setInterval(() => this.onKeepAlive(), this.config.keepAliveIntervalMs)
		this.keepAlive.unref?.()
	}

	stopKeepAlive(): void {
		if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null }
	}

	/** Registra un ping y programa el timeout si no llega el pong. */
	trackPing(id: string, ms = 15000): void {
		this.clearPing()
		this.pingTimeout = setTimeout(() => this.onTimeout('closed'), ms)
		this.pingTimeout.unref?.()
		void id
	}

	clearPing(): void {
		if (this.pingTimeout) { clearTimeout(this.pingTimeout); this.pingTimeout = null }
	}

	markConnected(): void {
		this.attempts = 0
		this.lastDisconnectAt = 0
		this.reconnecting = false
	}

	get attemptCount(): number {
		return this.attempts
	}

	get isReconnecting(): boolean {
		return this.reconnecting
	}

	/**
	 * Programa un reintento con backoff exponencial acotado.
	 * Devuelve el delay aplicado, o `null` si ya había uno en marcha.
	 */
	scheduleReconnect(baseMs: number, maxMs: number, maxAttempts: number): number | null {
		if (this.reconnect) return null
		if (this.attempts >= maxAttempts) return null

		const elapsed = this.lastDisconnectAt ? Date.now() - this.lastDisconnectAt : baseMs
		// el backoff crece con el número de intento, no con el tiempo
		const delay = Math.min(baseMs * 2 ** this.attempts, maxMs)
		this.attempts += 1
		this.reconnecting = true
		void elapsed

		this.reconnect = setTimeout(() => {
			this.reconnect = null
			this.reconnecting = false
			this.onReconnect()
		}, delay)
		this.reconnect.unref?.()
		return delay
	}

	markDisconnected(): void {
		this.lastDisconnectAt = Date.now()
	}

	cancelReconnect(): void {
		if (this.reconnect) { clearTimeout(this.reconnect); this.reconnect = null }
		this.reconnecting = false
	}

	cancelAll(): void {
		this.stopKeepAlive()
		this.clearPing()
		this.cancelReconnect()
	}
}
