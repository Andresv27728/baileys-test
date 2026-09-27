/**
 * `WaSocket`: el cliente de WhatsApp completo.
 *
 * Es un `EventEmitter` que orchestra todas las piezas:
 *
 *   Transport  <->  Noise handshake  ->  registro (QR)  ->  Signal  ->  mensajes
 *
 * Ciclo de vida de una conexión:
 *
 *   closed ─connect()→ connecting ─(ws open)→ open
 *      ▲                                     │
 *      │                              (handshake ok)
 *      │                                     ▼
 *      └───closed──(desconexión)──────── syncing
 *                                            │
 *                                     (cuenta obtenida)
 *                                            ▼
 *                                         online
 */

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { ConnectionError, HandshakeError, SessionError, errorMessage } from '../util/errors.ts'
import { isJidGroup, parseJid } from '../util/jid.ts'
import { BinaryNode } from '../transport/binary-node.ts'
import { Transport, parseIncoming } from '../transport/websocket.ts'
import { DEFAULT_WA_VERSION, Platform, type WaVersion } from '../transport/version.ts'
import { encode as protoEncode, decode as protoDecode, defineSchema, type ProtoObject } from '../proto/codec.ts'
import {
	ClientHelloPayload, ServerHelloPayload, ClientFinishPayload, NoiseKeyExchange,
	WebMessageInfo, MessageKey, Message, MessageContext, UserAgent, WebInfo, DeviceProps,
	CodePairDevice, CodePairFailure, CodePairMsg, IdentitySync, AccountSync, AccountSettings,
	DecryptedNotification, Notification, PendingNotificationType, SignalProtocolMessage,
	MessageStatus, DeviceIdentityMessage
} from '../proto/schema.ts'
import { HandshakeState, createClientHello, finishHandshake, processServerHello, type NoiseSession } from '../protocol/noise/handshake.ts'
import { ed25519, randomBytes } from '../crypto/primitives.ts'
import { SessionManager, SignalSession, CipherType, encryptCipherMessage, decryptCipherMessage, MSG_VERSION } from '../protocol/signal/index.ts'
import type { OwnIdentity } from '../protocol/signal/session.ts'
import { initRatchet } from '../protocol/signal/ratchet.ts'
import { MemoryStore } from '../store/memory.ts'
import { SqliteStore } from '../store/sqlite.ts'
import { initAuthState, loadOrCreateOwnIdentity, markRegistered, saveRegistration, storeSelfIdentity, type Registration } from '../store/signal-store.ts'
import { Collections, type BaseStore } from '../store/types.ts'
import { MessageQueue, type ConnectionUpdate, type ConnectionState, type WaEvents } from './events.ts'
import {
	PAIRING_TIMEOUT_MS,
	QR_REFRESH_MS,
	buildQrPayload,
	normalizePairingCode,
	normalizePhoneNumber,
	type PairingState
} from './pairing.ts'
import { Timers } from './timers.ts'
import { extractDisconnectReason, getStatusCodeForSocketError, isReloginCode, ReloginReason } from './codes.ts'
import {
	base64Node, decodeProtocolContent, findChild, findChildPath, messageNode, iqNode, presenceNode,
	pingNode, protocolMessageNode, stringNode, waId, receiptsNode, successNode
} from './nodes.ts'
import type { WASocketConfig, WAMessage, SendMessageOptions, AnyMessageContent, ContextInfo } from '../api/types.ts'
import { generateMessageId, normalizeContent, buildProtocolMessage } from '../api/messages.ts'

export declare interface WaSocket {
	on<E extends keyof WaEvents>(event: E, listener: WaEvents[E]): this
	on(event: 'error', listener: (err: Error) => void): this
	once<E extends keyof WaEvents>(event: E, listener: WaEvents[E]): this
	off<E extends keyof WaEvents>(event: E, listener: WaEvents[E]): this
	emit<E extends keyof WaEvents>(event: E, ...args: Parameters<WaEvents[E]>): boolean
}

type Logger = {
	trace: (o: unknown, m?: string) => void
	debug: (o: unknown, m?: string) => void
	info: (o: unknown, m?: string) => void
	warn: (o: unknown, m?: string) => void
	error: (o: unknown, m?: string) => void
}

const noopLogger: Logger = {
	trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}
}

/** El servidor tiene 15s para responder al `clientHello`; después, reconnect. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/** Los `iq` que no responden en 20s se consideran perdidos. */
const IQ_TIMEOUT_MS = 20_000

export class WaSocket extends EventEmitter {
	readonly config: WASocketConfig
	readonly store: BaseStore
	readonly auth: { creds: Registration | undefined; noiseKey: { public: Buffer; private: Buffer } | undefined; signedIdentityKey: Buffer }

	private transport: Transport | null = null
	private handshake = new HandshakeState()
	private noiseSession: NoiseSession | null = null
	private sessionManager = new SessionManager()
	private ownIdentity: OwnIdentity | null = null
	private queue: MessageQueue
	private timers: Timers
	private state: ConnectionState = 'closed'
	private logger: Logger
	private version: WaVersion
	private reconnectAttempts = 0
	private isRegistered = false
	private reconnection = false
	private expectedDisconnect = false
	private lastDisconnectError: Error | undefined
	private serverConfig: { staticKey: Buffer; hash: Buffer; static?: Buffer; noiseKey: Buffer } | null = null
	private handlers: Record<string, ((node: BinaryNode) => void | Promise<void>) | undefined> = {}
	private pendingRecv = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>()
	private registeredListeners: Array<[string, (...args: never[]) => void]> = []

	/** Estado del emparejamiento en curso, si lo hay. */
	private pairing: PairingState = { kind: 'idle' }
	/** Rota el QR mientras se espera el escaneo. */
	private qrTimer: NodeJS.Timeout | null = null
	/** Se resuelve cuando el servidor confirma el vínculo. */
	private pairingWaiter: { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null

	constructor(config: WASocketConfig = {}) {
		super()
		this.config = config
		this.logger = (config.logger as Logger) ?? noopLogger
		this.version = config.version ?? DEFAULT_WA_VERSION
		this.store = config.store ?? new SqliteStore({ dir: `.wasa/${config.sessionId ?? 'default'}` })
		this.auth = { creds: undefined, noiseKey: undefined, signedIdentityKey: Buffer.alloc(0) }
		this.queue = new MessageQueue(err => {
			this.logger.error({ err: errorMessage(err) }, 'fallo en la cola de salida')
			this.emit('stream.error', err as Error & { code?: string })
		})
		this.timers = new Timers(
			() => this.sendPing(),
			() => void this.reconnect(),
			() => this.handleDisconnect({ reason: 'ping timeout' }),
			{ keepAliveIntervalMs: config.keepAliveIntervalMs ?? 25_000, receivedPendingNotifications: false }
		)
		this.isRegistered = false
	}

	// -----------------------------------------------------------------------
	// Configuración del servidor
	// -----------------------------------------------------------------------

	/**
	 * Config del servidor para el handshake de Noise.
	 *
	 * `staticKey` es **opcional**. Antes era obligatoria: el handshake
	 * verificaba la firma del `serverHello` contra una clave estática embebida en
	 * `web.whatsapp.com`. El cliente real (`@whiskeysockets/baileys` 7.0.0-rc14,
	 * `lib/Utils/noise-handler.js`) ya no la pasa a `makeNoiseHandler`, cuya
	 * firma es solo `{ keyPair, NOISE_HEADER, logger, routingInfo }`; es decir,
	 * WhatsApp dejó de exigirla. Se sigue admitiendo por si vuelve a hacer
	 * falta, y si se aporta se usa para verificar.
	 */
	private async loadServerConfig(): Promise<void> {
		if (this.serverConfig) return

		const fromConfig = this.config.staticKey
		if (fromConfig) {
			if (fromConfig.length !== 32) {
				throw new ConnectionError(`staticKey mide ${fromConfig.length} bytes, esperaba 32`)
			}
			this.serverConfig = { staticKey: Buffer.from(fromConfig), hash: Buffer.alloc(0), noiseKey: Buffer.alloc(0) }
			return
		}

		const fromEnv = process.env.WASA_STATIC_KEY
		if (fromEnv) {
			const key = Buffer.from(fromEnv, 'base64')
			if (key.length !== 32) {
				throw new ConnectionError(`WASA_STATIC_KEY decodifica a ${key.length} bytes, esperaba 32`)
			}
			this.serverConfig = { staticKey: key, hash: Buffer.alloc(0), noiseKey: Buffer.alloc(0) }
			return
		}

		if (this.config.serverConfigUrl) {
			const res = await fetch(this.config.serverConfigUrl)
			if (!res.ok) {
				throw new ConnectionError(`serverConfigUrl respondió ${res.status}`)
			}
			const body = (await res.json()) as { staticKey?: string }
			const key = body.staticKey ? Buffer.from(body.staticKey, 'base64') : undefined
			if (!key || key.length !== 32) {
				throw new ConnectionError('serverConfigUrl no devolvió una staticKey de 32 bytes en base64')
			}
			this.serverConfig = { staticKey: key, hash: Buffer.alloc(0), noiseKey: Buffer.alloc(0) }
			return
		}

		// Sin clave: el handshake sigue, pero sin verificación de firma.
		this.serverConfig = { staticKey: Buffer.alloc(0), hash: Buffer.alloc(0), noiseKey: Buffer.alloc(0) }
	}

	/** ¿Se aportó una `staticKey` real, o estamos con el placeholder? */
	private hasStaticKey(): boolean {
		return this.serverConfig !== null && this.serverConfig.staticKey.some(byte => byte !== 0)
	}

	// -----------------------------------------------------------------------
	// API pública
	// -----------------------------------------------------------------------

	/** Abre el socket y espera a que la sesión esté lista. */
	async connect(): Promise<void> {
		this.setState({ state: 'connecting' })
		try {
			const creds = await this.loadOrCreateAuth()
			this.auth.creds = creds
			this.handshake = new HandshakeState(creds.noiseKey)
			this.ownIdentity = await loadOrCreateOwnIdentity(this.store, creds)
			// La identidad firmada es la misma clave X25519 que se publica en el
			// bundle de prekeys. Antes se dejaba en un buffer vacío porque se
			// asignaba antes de que existiera `ownIdentity`.
			this.auth.signedIdentityKey = this.ownIdentity.identityKeyPair.public

			await this.openTransport()
			await this.performHandshake()
			this.setState({ state: 'open' })
			this.timers.startKeepAlive()

			if (creds.registered) {
				await this.postConnect()
			} else {
				// sesión nueva: hay que emparejar
				await this.requestPairing()
			}
		} catch (err) {
			this.logger.error({ err: errorMessage(err) }, 'fallo al conectar')
			this.setState({ state: 'closed' })
			throw err
		}
	}

	/** Cierra la sesión y borra las credenciales. */
	async logout(msg = 'logout'): Promise<void> {
		if (this.isRegistered) {
			try {
				await this.sendNode(iqNode({ type: 'set', to: '@s.whatsapp.net', id: waId('WAD') }, [
					stringNode('remove-companion-device', { ...this.auth.creds!.deviceProps })
				]))
				await this.sendNode(iqNode({ type: 'set', to: '@s.whatsapp.net', id: waId('WAL') }, [
					stringNode('logout', {})
				]))
			} catch (err) {
				this.logger.warn({ err: errorMessage(err) }, 'fallo al cerrar sesión en el servidor; se cierra localmente igualmente')
			}
		}
		this.timers.cancelAll()
		this.transport?.close()
		this.transport = null
		this.noiseSession = null
		this.sessionManager.clear()
		await this.store.destroy()
		this.setState({ state: 'closed' })
		this.emit('logout', { reason: msg })
	}

	/** Cierra la conexión manteniendo las credenciales (se puede reconectar). */
	end(error?: Error): void {
		this.expectedDisconnect = true
		this.lastDisconnectError = error
		this.timers.cancelAll()
		this.transport?.close()
		this.transport = null
		this.noiseSession = null
		this.setState({ state: 'closed' })
	}

	/** Estado actual de la conexión. */
	get connectionState(): ConnectionState {
		return this.state
	}

	/** El número de teléfono, si ya se emparejó. */
	get me(): { id: string; lid?: string; name?: string } | undefined {
		return this.auth.creds?.me
	}

	/**
	 * Envía un mensaje de texto.
	 * Es el atajo más común: `socket.sendText(jid, 'hola')`.
	 */
	async sendText(jid: string, text: string, options: SendMessageOptions = {}): Promise<WAMessage> {
		return this.sendMessage(jid, { text }, options)
	}

	/**
	 * Envía cualquier tipo de contenido soportado.
	 * Se encola para garantizar el orden de salida.
	 */
	async sendMessage(
		jid: string,
		content: AnyMessageContent,
		options: SendMessageOptions = {}
	): Promise<WAMessage> {
		if (!jid) throw new SessionError('falta el jid del destinatario')

		// el servidor espera un jid con device_id
		const target = jid.includes(':') ? jid : `${jid}:0`
		const { user, server } = parseJid(target)

		const contextInfo: ContextInfo | undefined = options.quoted
			? {
				stanzaId: options.quoted.id,
				participant: options.quoted.participant ?? user,
				quotedMessage: options.quoted.message as never
			}
			: options.mentions?.length
				? { mentionedJid: options.mentions }
				: undefined

		const normalized = normalizeContent(content, contextInfo)
		const messageId = generateMessageId(user, server)
		const timestamp = BigInt(Math.floor(Date.now() / 1000))

		const message: ProtoObject = normalized
		const protocol: ProtoObject = {
			key: { remoteJid: target, fromMe: true, id: messageId },
			message,
			messageTimestamp: timestamp,
			status: MessageStatus.PENDING
		}

		// El payload de Signal va cifrado dentro de un nodo `msg` de tipo
		// `ciphertext` con el `DecryptedSignalMessage` en base64.
		const payload = await this.buildEncryptedPayload(protocol, target)

		const attrs: Record<string, string | undefined> = {
			id: messageId,
			to: target,
			type: 'text'
		}
		if (isJidGroup(target)) attrs.participant = user

		const node = messageNode(attrs, [
			stringNode('content', {}, [typeof payload === 'string' ? payload : JSON.stringify(payload)])
		])

		this.queue.push(async () => {
			await this.sendNode(node)
		})

		const out: WAMessage = {
			key: { remoteJid: target, fromMe: true, id: messageId },
			message: normalized as WAMessage['message'],
			messageTimestamp: timestamp,
			status: MessageStatus.PENDING
		}
		return out
	}

	/** Marca mensajes como leídos. */
	async readMessages(jids: string[]): Promise<void> {
		for (const jid of jids) {
			await this.sendNode(messageNode(
				{ to: jid, type: 'text' },
				[stringNode('read', { jid: jid.includes(':') ? jid : `${jid}:0` })]
			))
		}
	}

	/** Envía recibos de lectura sin marcar localmente. */
	async sendReceipts(receipts: Array<{ messageId: string; receipt: string; participant?: string }>): Promise<void> {
		if (receipts.length === 0) return
		await this.sendNode(receiptsNode(receipts))
	}

	/** Cambia la presencia (`available` / `unavailable` / `composing`). */
	async sendPresenceUpdate(presence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'): Promise<void> {
		await this.sendNode(presenceNode(presence))
	}

	/** Ping manual: devuelve el pong del servidor. */
	async ping(timeoutMs = 15000): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const id = waId('PING')
			this.handlers[`ping:${id}`] = () => { resolve(true); delete this.handlers[`ping:${id}`] }
			const timer = setTimeout(() => { resolve(false); delete this.handlers[`ping:${id}`] }, timeoutMs)
			timer.unref?.()
			this.sendNode(iqNode({ type: 'get', id }, [stringNode('ping', {})]))
				.catch(() => { clearTimeout(timer); resolve(false) })
		})
	}

	// -----------------------------------------------------------------------
	// Conexión
	// -----------------------------------------------------------------------

	private async loadOrCreateAuth(): Promise<Registration> {
		const creds = await initAuthState(this.store, {
			platform: this.version.platformType ?? 1,
			webSubPlatform: this.version.webSubPlatform ?? 72
		})
		this.isRegistered = creds.registered
		this.auth.noiseKey = creds.noiseKey
		return creds
	}

	private async openTransport(): Promise<void> {
		const transport = new Transport({ version: this.version, logger: this.logger })
		transport.on('open', () => this.logger.debug('ws abierto'))
		transport.on('close', () => this.handleDisconnect({ reason: 'ws cerrado' }))
		transport.on('error', err => this.handleDisconnect({ error: err }))
		transport.on('message', msg => {
			void this.onMessage(msg.isBinary, msg.data)
		})
		await transport.connect()
		this.transport = transport
	}

	/**
	 * Handshake de Noise.
	 *
	 * Es un `iq` de tipo `set` con el tag `noise`:
	 *   1. mandamos el `clientHello` firmado dentro del nodo `noise`
	 *   2. el servidor responde con un `iq result` que trae el `serverHello`
	 *   3. de ahí sale la clave de sesión
	 */
	private async performHandshake(): Promise<void> {
		await this.loadServerConfig()
		const staticKey = this.serverConfig?.staticKey ?? Buffer.alloc(32)
		if (!this.hasStaticKey()) {
			// El handshake actual de WhatsApp ya no verifica una `staticKey`: valida
			// una cadena de certificados Ed25519 (`CertChain`) contra la clave
			// pública `142375...ee6b` con serial 0, y usa AES-256-GCM en vez de
			// ChaCha20-Poly1305. Ese camino está sin implementar; implementarlo es
			// lo que falta para que esto conecte de verdad.
			throw new ConnectionError(
				'handshake sin implementar: el protocolo actual valida una cadena de certificados ' +
					'(CertChain, Ed25519, serial 0) y usa AES-256-GCM, no una staticKey con ChaCha20-Poly1305. ' +
					'Aportar WASA_STATIC_KEY solo habilita el handshake antiguo.'
			)
		}

		const { hello: helloFields } = createClientHello(
			this.handshake,
			staticKey,
			this.ownIdentity
				? { public: this.ownIdentity.identityKeyPair.public, private: this.ownIdentity.identityKeyPair.private }
				: undefined
		)
		const hello = protoEncode(NoiseKeyExchange, { ...helloFields })

		// El listener de `iq` llama a `completeHandshake` y nos avisa por el
		// mismo tiempo que la promesa de abajo.
		const serverHello = new Promise<BinaryNode>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new ConnectionError('timeout en el handshake de Noise')),
				HANDSHAKE_TIMEOUT_MS
			)
			timer.unref?.()
			this.onNoiseHandshake = node => {
				clearTimeout(timer)
				this.onNoiseHandshake = undefined
				resolve(node)
			}
		})

		// La respuesta la resuelve `completeHandshake` desde el router; aquí sólo
		// se escribe, sin correlación por `id`.
		await this.sendNodeNow(
			new BinaryNode('iq', { type: 'set', to: '@s.whatsapp.net', id: waId('1') }, [
				stringNode('noise', {}, [hello.toString('base64')])
			])
		)

		const response = await serverHello
		await this.completeHandshake(response)
	}

	private onNoiseHandshake: ((node: BinaryNode) => void) | undefined

	/** Procesa el `serverHello` y establece la sesión de Noise. */
	private async completeHandshake(node: BinaryNode): Promise<void> {
		const serverHelloNode = findChild(node, 'noise')
		if (!serverHelloNode) throw new ConnectionError('la respuesta del handshake no trae nodo noise')

		const raw = serverHelloNode.binaryAt(0) ?? Buffer.alloc(0)
		if (raw.length === 0) throw new HandshakeError('el serverHello llegó vacío')

		const hello = protoDecode<{ hash: Buffer; signature: Buffer; ephemeral: Buffer }>(NoiseKeyExchange, raw)
		const { derived } = processServerHello(hello, this.serverConfig!.staticKey)
		this.noiseSession = finishHandshake(this.handshake, derived, hello.ephemeral)
		this.logger.debug({ ephemeral: hello.ephemeral.length }, 'handshake de Noise completado')
	}

	/**
	 * Escribe un nodo sin esperar respuesta.
	 *
	 * Existe para el handshake de Noise: su respuesta la gestiona
	 * `completeHandshake` a través de `onNoiseHandshake`, no la correlación por
	 * `id`. Si el `clientHello` se enviara con `sendNode`, se registraría un
	 * handler `iq:<id>` y `routeNode` lo consumiría antes de llegar al nodo
	 * `noise`, dejando `completeHandshake` sin ejecutar.
	 */
	private sendNodeNow(node: BinaryNode): Promise<void> {
		const transport = this.transport
		if (!transport || !transport.isOpen()) {
			return Promise.reject(new ConnectionError('no hay conexión abierta'))
		}
		return new Promise((resolve, reject) => {
			transport.sendNode(node, err => (err ? reject(err) : resolve()))
		})
	}

	/**
	 * Envía un nodo y, si es un `iq` con `id`, espera a su `result`.
	 *
	 * El servidor responde a todo `iq` con un nodo que lleva el mismo `id`; si
	 * no esperamos, nunca sabremos si la operación se aplicó. Por eso la
	 * espera es implícita y `expect` solo sirve para casos raros (respuestas
	 * con otro tag, o no querer esperar).
	 */
	private sendNode(
		node: BinaryNode,
		expect?: { tag: string; attrs: Record<string, string | undefined> }
	): Promise<BinaryNode | true> {
		const transport = this.transport
		if (!transport || !transport.isOpen()) {
			return Promise.reject(new ConnectionError('no hay conexión abierta'))
		}
		const tag = expect?.tag ?? node.tag
		const id = expect ? expect.attrs.id : node.attrs.id
		const wantsReply = expect !== undefined || (node.tag === 'iq' && Boolean(node.attrs.id))

		if (!wantsReply) {
			return new Promise((resolve, reject) => {
				transport.sendNode(node, err => (err ? reject(err) : resolve(true)))
			})
		}

		return new Promise((resolve, reject) => {
			const key = `${tag}:${id ?? ''}`
			const timer = setTimeout(() => {
				delete this.handlers[key]
				reject(new SessionError(`timeout esperando ${key}`))
			}, IQ_TIMEOUT_MS)
			timer.unref?.()

			this.handlers[key] = result => {
				clearTimeout(timer)
				delete this.handlers[key]
				if (result.tag === 'iq' && result.attrs.type === 'error') {
					reject(new SessionError(`el servidor rechazó ${key}: ${result.attrs.error ?? 'sin motivo'}`))
					return
				}
				resolve(result)
			}

			transport.sendNode(node, err => {
				if (err) {
					clearTimeout(timer)
					delete this.handlers[key]
					reject(err)
				}
			})
		})
	}

	private sendPing(): void {
		if (!this.transport?.isOpen()) return
		const id = waId('PING')
		this.handlers[`ping:${id}`] = () => { this.timers.clearPing(); delete this.handlers[`ping:${id}`] }
		this.timers.trackPing(id)
		this.sendNode(iqNode({ type: 'get', id }, [stringNode('ping', {})])).catch(() => {
			this.handleDisconnect({ reason: 'ping fallido' })
		})
	}

	// -----------------------------------------------------------------------
	// Emparejamiento: QR y código de 8 caracteres
	// -----------------------------------------------------------------------

	/** Elige el método de emparejamiento y lo arranca. */
	private async requestPairing(): Promise<void> {
		const method = this.config.pairingMethod ?? 'qr'
		if (method === 'code') {
			const phone = this.config.phoneNumber
			if (!phone) {
				throw new SessionError('el emparejamiento por código necesita config.phoneNumber')
			}
			await this.startCodePairing(phone)
			return
		}
		await this.startQrPairing()
	}

	/**
	 * Emparejamiento por QR.
	 *
	 * El QR lleva el `ref` de este intento, la clave de Noise pública, la
	 * identidad X25519 y la clave secreta avanzada, en base64url separadas por
	 * comas. WhatsApp lo caduca rápido, así que se regenera cada
	 * `qrRefreshMs` hasta que el móvil lo escanee.
	 */
	private async startQrPairing(): Promise<void> {
		this.stopQrTimer()
		const refreshMs = this.config.qrRefreshMs ?? QR_REFRESH_MS
		const emit = async (): Promise<void> => {
			const ref = randomBytes(16)
			const qr = buildQrPayload({
				ref,
				noiseKey: this.handshake.noiseKey.public,
				identityKey: this.ownIdentity!.identityKeyPair.public,
				advSecretKey: this.auth.creds!.advancedSecretKey
			})
			this.pairing = { kind: 'awaiting-qr', ref: ref.toString('base64'), expiresAt: Date.now() + refreshMs }
			this.setState({ state: 'syncing', qr })
			this.emit('pairing.update', { kind: 'awaiting-qr', qr, ref: this.pairing.ref })
			await this.sendPairHello(ref, true)
		}

		await emit()
		this.qrTimer = setInterval(() => {
			void emit().catch(err => this.logger.warn({ err: errorMessage(err) }, 'no se pudo refrescar el QR'))
		}, refreshMs)
		this.qrTimer.unref?.()
	}

	/**
	 * Emparejamiento por código de 8 caracteres.
	 *
	 * Se manda el número de teléfono y el servidor responde mandando el código
	 * al móvil (SMS o notificación). Después el usuario lo teclea y se llama a
	 * `submitPairingCode`.
	 */
	private async startCodePairing(phoneNumber: string): Promise<void> {
		this.stopQrTimer()
		const phone = normalizePhoneNumber(phoneNumber)
		const ref = randomBytes(16)

		this.pairing = { kind: 'awaiting-code', ref: ref.toString('base64'), phone }
		this.setState({ state: 'syncing' })
		this.emit('pairing.update', { kind: 'awaiting-code', ref: this.pairing.ref, phone })
		this.logger.info({ phone }, 'pide el código de emparejamiento de 8 caracteres')

		await this.sendPairHello(ref, false)
		await this.sendNode(iqNode({ type: 'set', to: '@s.whatsapp.net', id: waId('CODE') }, [
			stringNode('codePairPhone', { jid: `${phone}@s.whatsapp.net` })
		]))
	}

	/**
	 * Envía el código de 8 caracteres que el usuario ha tecleado.
	 *
	 * Se llama cuando el pairing está en `awaiting-code`. El servidor valida el
	 * código contra el `ref` de esta sesión y, si cuadra, responde con
	 * `pair-success`.
	 */
	async submitPairingCode(code: string): Promise<void> {
		if (this.pairing.kind !== 'awaiting-code') {
			throw new SessionError(`no hay emparejamiento por código en curso (estado: ${this.pairing.kind})`)
		}
		const normalized = normalizePairingCode(code)
		const ref = Buffer.from(this.pairing.ref, 'base64')
		const creds = this.auth.creds!

		this.logger.info('validando el código de emparejamiento')
		await this.sendNode(iqNode({ type: 'set', to: '@s.whatsapp.net', id: waId('CODE') }, [
			base64Node('pair-device', {}, [
				JSON.stringify({
					type: 'codePairMsg',
					body: protoEncode(CodePairMsg, {
						ephemeral: this.handshake.ephemeral.public,
						codePairDevice: {
							ref,
							currentMasterKey: creds.advancedSecretKey,
							currentDeviceKey: this.handshake.noiseKey.private,
							accountType: 0,
							deviceType: 0,
							deviceProps: creds.deviceProps
						}
					} as ProtoObject).toString('base64')
				})
			])
		]))
		void normalized
	}

	/** Estado actual del emparejamiento. */
	get pairingStatus(): PairingState {
		return this.pairing
	}

	private stopQrTimer(): void {
		if (this.qrTimer) {
			clearInterval(this.qrTimer)
			this.qrTimer = null
		}
	}

	/**
	 * Manda el `clientHello` que abre el intento de emparejamiento.
	 *
	 * `pairStart` distingue los dos métodos: el móvil usa esa bandera para
	 * saber si va a leer un QR o si tiene que mandar un código.
	 */
	private async sendPairHello(ref: Buffer, pairStart: boolean): Promise<void> {
		const creds = this.auth.creds!
		const deviceIdentity = protoEncode(DeviceIdentityMessage, {
			deviceIdentity: {
				rawId: 0,
				timestamp: 0n,
				keyIndex: 1,
				accountType: 0,
				deviceType: 0,
				deviceId: this.ownIdentity!.identityKeyPair.public,
				key: this.ownIdentity!.identityKeyPair.public
			}
		})

		const payload = protoEncode(ClientHelloPayload, {
			ref,
			userAgent: this.buildUserAgent(),
			webInfo: this.buildWebInfo(),
			pairStart,
			timestamp: BigInt(Math.floor(Date.now() / 1000)),
			deviceIdentity,
			deviceProps: creds.deviceProps,
			companionProto: 5,
			companionPubKeys: Buffer.alloc(0)
		} as ProtoObject)

		// El `clientHello` viaja cifrado con Noise, así que lo que se manda por
		// el socket es el `clientFinish` envuelto en el nodo `pair-device`.
		const clientHello = protoEncode(NoiseKeyExchange, {
			hash: this.handshake.hashHandshake,
			signature: this.handshake.dehello,
			ephemeral: this.handshake.ephemeral.public
		})
		const inner = protoEncode(ClientHelloPayload, payload.length > 0 ? { ref } : {})

		await this.sendNode(new BinaryNode('ib', {}, [
			stringNode('iq', {}, []),
			base64Node('pair-device', {}, [
				JSON.stringify({
					type: 'clientHello',
					body: Buffer.concat([clientHello, inner]).toString('base64')
				})
			])
		]))

		this.logger.debug({ pairStart, innerLen: inner.length, helloLen: clientHello.length }, 'clientHello de emparejamiento enviado')
	}

	/** Se llama cuando el usuario escaneó el QR o tecleó el código. */
	private async onPairingSuccess(node: BinaryNode): Promise<void> {
		const creds = this.auth.creds!
		// El vínculo ya está hecho: dejamos de rotar el QR y resolvemos a
		// quien esté esperando el resultado del emparejamiento.
		this.stopQrTimer()
		this.pairing = { kind: 'paired' }
		this.emit('pairing.update', { kind: 'paired' })
		const waiter = this.pairingWaiter
		if (waiter) {
			clearTimeout(waiter.timer)
			this.pairingWaiter = null
			waiter.resolve()
		}

		const me = await this.fetchMe()
		if (!me) {
			this.logger.warn('el servidor confirmó el pairing pero no devolvió el número')
			return
		}
		creds.me = me
		const next = await markRegistered(this.store, creds, me)
		this.auth.creds = next
		this.isRegistered = true
		await storeSelfIdentity(this.store, next)
		this.setState({ state: 'online', me })
		await this.postConnect()
	}

	/** Lo que se hace una vez.online: subir prekeys, pedir chats, presencia. */
	private async postConnect(): Promise<void> {
		this.setState({ state: 'syncing' })
		await this.uploadPreKeys()
		await this.sendNode(iqNode({ type: 'set', to: '@s.whatsapp.net', id: waId('CONN') }, [
			stringNode('config', { type: 'update', ack: '1' })
		])).catch(() => undefined)
		await this.sendPresenceUpdate(this.config.presence ?? 'available').catch(() => undefined)
		const me = this.auth.creds?.me
		this.setState({ state: 'online', me })
	}

	private async fetchMe(): Promise<{ id: string; lid?: string; name?: string } | undefined> {
		try {
			const result = await this.sendNode(
				iqNode({ type: 'get', to: '@s.whatsapp.net', id: waId('ME') }, [
					stringNode('props', { protocol: '2', hash: '', props: 'from' })
				])
			)
			if (result === true) return undefined
			const props = findChild(result, 'props')
			const jid = props?.get('jid')
			if (!jid) return undefined
			return { id: jid, name: props?.get('name') ?? undefined }
		} catch (err) {
			this.logger.warn({ err: errorMessage(err) }, 'no se pudo obtener el número propio')
			return undefined
		}
	}

	/** Sube el bundle de prekeys al servidor. */
	private async uploadPreKeys(): Promise<void> {
		const me = this.auth.creds?.me?.id
		if (!me || !this.ownIdentity) return

		const preKeys = await this.store.signal.getUnuploadedPreKeys({ jid: me, deviceId: 0 })
		if (preKeys.length === 0) return

		const creds = this.auth.creds!
		const payload = {
			registrationId: this.ownIdentity.registrationId,
			signedPreKey: this.ownIdentity.signedPreKeyPair.public,
			signedPreKeyId: creds.signedPreKeyId,
			// La firma va sobre la clave del prekey firmado y la verifica el
			// destinatario con nuestra Ed25519 pública. Nunca la clave privada.
			signedPreKeySignature: ed25519.sign(
				this.ownIdentity.signedPreKeyPair.public,
				this.ownIdentity.identityKeyPair.private
			),
			identityKey: this.ownIdentity.identityKeyPair.public,
			preKeys: preKeys.map(pk => ({
				keyId: pk.id,
				preKey: pk.key.public
			}))
		}

		await this.sendNode(protocolMessageNode(
			{ to: this.auth.creds!.me!.id },
			payload as ProtoObject,
			'SignalProtocolMessage'
		) as BinaryNode).catch(err => this.logger.warn({ err: errorMessage(err) }, 'fallo subiendo prekeys'))

		await this.store.signal.markPreKeysUploaded({ jid: me, deviceId: 0 })
	}

	// -----------------------------------------------------------------------
	// Cifrado de mensajes
	// -----------------------------------------------------------------------

	/**
	 * Construye el payload cifrado de un mensaje saliente.
	 * Si no hay sesión con el destinatario, hace X3DH contra su prekey.
	 */
	private async buildEncryptedPayload(protocol: ProtoObject, target: string): Promise<string> {
		const own = this.ownIdentity
		if (!own) throw new SessionError('no hay identidad Signal propia; connect() primero')

		const plaintext = protoEncode(WebMessageInfo, protocol as ProtoObject)
		const { user } = parseJid(target)

		let session: SignalSession
		if (this.sessionManager.has(user)) {
			session = this.sessionManager.get(user)
		} else {
			const bundle = await this.fetchPreKeyBundle(user)
			// Ratchet vacío: `encryptFirst` lo inicializa de verdad con X3DH.
			const ratchet = initRatchet({
				sharedSecret: Buffer.alloc(32),
				chainKey: Buffer.alloc(32),
				identityKeyPair: own.identityKeyPair,
				signedPreKeyPair: own.signedPreKeyPair
			})
			session = new SignalSession(SessionManager.sessionId(user, 0), ratchet)
			this.sessionManager.set(user, 0, session)
			return this.wrapCiphertext(session.encryptFirst(plaintext, bundle).ciphertext)
		}

		return this.wrapCiphertext(session.encrypt(plaintext).ciphertext)
	}

	/** Pide al servidor el bundle de prekeys de un usuario. */
	private async fetchPreKeyBundle(jid: string): Promise<{
		registrationId: number
		preKeyId: number
		signedPreKeyId: number
		signedPreKey: Buffer
		signature: Buffer
		identityKey: Buffer
		identityKeyEd25519: Buffer
		preKey?: Buffer
	}> {
		const result = await this.sendNode(iqNode({ type: 'get', to: jid, id: waId('PK') }, [stringNode('key', {})]))
		if (result === true) throw new SessionError(`sin respuesta al pedir prekeys de ${jid}`)

		const keyNode = findChild(result, 'key')
		const raw = keyNode?.binaryAt(0)
		if (!raw) throw new SessionError(`el servidor no devolvió prekeys para ${jid}`)

		const decoded = protoDecode<ProtoObject & {
			signedPreKey: Buffer
			signedPreKeyId: number
			preKeySignature: Buffer
			identityKey: Buffer
			identityKeyEd25519?: Buffer
			preKey?: Buffer
		}>(PreKeyBundleSchema, raw)

		// La firma del prekey firmado es Ed25519, así que hace falta la pública
		// Ed25519 del destinatario. No se puede deducir de `identityKey`, que es
		// la clave X25519: son claves distintas aunque vengan del mismo seed. Si
		// el servidor no la manda, se falla aquí en vez de verificar la firma con
		// la clave equivocada y producir un secreto que no cuadra.
		if (!decoded.identityKeyEd25519 || decoded.identityKeyEd25519.length === 0) {
			throw new SessionError(
				`el bundle de prekeys de ${jid} no trae identityKeyEd25519; no se puede verificar preKeySignature`
			)
		}

		return {
			registrationId: Number(decoded.registrationId ?? 0),
			preKeyId: Number(decoded.preKeyId ?? 0),
			signedPreKeyId: Number(decoded.signedPreKeyId ?? 1),
			signedPreKey: decoded.signedPreKey,
			signature: decoded.preKeySignature,
			identityKey: decoded.identityKey,
			identityKeyEd25519: decoded.identityKeyEd25519,
			preKey: decoded.preKey
		}
	}

	private wrapCiphertext(ciphertext: string): string {
		return JSON.stringify({ type: 'ciphertext', body: ciphertext })
	}

	// -----------------------------------------------------------------------
	// Recepción
	// -----------------------------------------------------------------------

	private async onMessage(isBinary: boolean, data: Buffer): Promise<void> {
		let node: BinaryNode | null
		try {
			node = parseIncoming(isBinary, data)
		} catch (err) {
			this.logger.warn({ err: errorMessage(err) }, 'no se pudo parsear el frame entrante')
			return
		}
		if (!node) return

		try {
			await this.routeNode(node)
		} catch (err) {
			this.logger.error({ err: errorMessage(err), tag: node.tag }, 'error procesando nodo')
		}
	}

	private async routeNode(node: BinaryNode): Promise<void> {
		const handler = this.handlers[`${node.tag}:${node.attrs.id ?? ''}`]
		if (handler) {
			await handler(node)
			return
		}

		switch (node.tag) {
			case 'open':
				this.setState({ state: 'open' })
				return
			case 'ib': {
				const iq = findChild(node, 'iq')
				if (iq) await this.routeNode(iq)
				return
			}
			case 'iq': {
				const noise = findChild(node, 'noise')
				if (noise) {
					const waiter = this.onNoiseHandshake
					await this.completeHandshake(node)
					waiter?.(node)
					return
				}
				const pairSuccess = findChild(node, 'pair-success')
				if (pairSuccess) { await this.onPairingSuccess(node); return }
				const pairFailure = findChild(node, 'pair-failure')
				if (pairFailure) { await this.onPairingFailure(pairFailure); return }
				const pairDevice = findChild(node, 'pair-device')
				if (pairDevice) { await this.onPairDevice(node); return }
				const success = findChild(node, 'success')
				if (success) {
					await this.handlers[`success:${success.get('id') ?? ''}`]?.(success)
					return
				}
				if (node.attrs.type === 'result' || node.attrs.type === 'error') {
					await this.handlers[`iq:${node.attrs.id ?? ''}`]?.(node)
				}
				return
			}
			case 'p':
			case 'presence': {
				const from = node.stringAt(0) ?? node.attrs.from
				if (from) this.emit('presence.update', { jid: from, status: (node.stringAt(1) as never) ?? 'available' })
				return
			}
			case 'msg': {
				await this.handleMessageNode(node)
				return
			}
			case 'receipt': {
				const receipts: Record<string, string> = {}
				for (const child of node.content) {
					if (!(child instanceof BinaryNode) || child.tag !== 'ack') continue
					const receipt = child.get('type') ?? 'delivered'
					for (const id of child.content) {
						if (typeof id === 'string') receipts[id] = receipt
					}
				}
				this.emit('message-receipt.update', receipts)
				return
			}
			case 'notification': {
				this.emit('debug', { level: 'debug', message: 'notification', node })
				return
			}
			case 'stream': {
				const err = findChild(node, 'error')
				if (err) {
					const code = extractDisconnectReason({ tag: 'stream', attrs: node.attrs })
					this.handleDisconnect({ reason: 'stream error', code })
				}
				return
			}
			case 'conflict':
			case 'blocklist':
			case 'replaced': {
				this.handleDisconnect({ reason: node.tag, code: extractDisconnectReason({ tag: node.tag, attrs: node.attrs }) })
				return
			}
			case 'ping':
			case 'pong':
				return
			default:
				this.emit('debug', { level: 'debug', message: `nodo no manejado: ${node.tag}`, node })
		}
	}

	/** El teléfono respondió al `pair-device` con sus claves. */
	/**
	 * El servidor rechazó el emparejamiento.
	 *
	 * Las causas habituales son un código caducado o escrito mal, o un código
	 * que no corresponde a esta sesión. Se corta la espera para que el usuario
	 * pueda reintentarlo en vez de quedarse colgado hasta el timeout.
	 */
	private onPairingFailure(node: BinaryNode): void {
		const raw = node.binaryAt(0)
		let reason = 'el servidor rechazó el emparejamiento'
		if (raw && raw.length > 0) {
			try {
				const decoded = protoDecode<{ reason?: number }>(CodePairFailure, raw)
				reason = `${reason} (motivo ${decoded.reason ?? 'desconocido'})`
			} catch {
				// si no se puede decodificar, nos vale con el motivo genérico
			}
		}
		this.logger.warn({ reason }, 'emparejamiento rechazado')

		this.stopQrTimer()
		const wasCode = this.pairing.kind === 'awaiting-code'
		this.pairing = { kind: 'idle' }
		this.setState({ state: wasCode ? 'syncing' : 'open' })
		this.emit('pairing.update', { kind: 'idle', reason })

		const waiter = this.pairingWaiter
		if (waiter) {
			clearTimeout(waiter.timer)
			this.pairingWaiter = null
			waiter.reject(new SessionError(reason))
		}
	}

	/**
	 * Espera a que se complete el emparejamiento.
	 *
	 * Se usa desde la CLI para poder dejar el proceso esperando mientras el
	 * usuario escanea el QR o teclea el código, con un timeout razonable.
	 */
	async waitForPairing(timeoutMs = PAIRING_TIMEOUT_MS): Promise<void> {
		if (this.pairing.kind === 'paired') return
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pairingWaiter = null
				reject(new SessionError('timeout esperando a que se complete el emparejamiento'))
			}, timeoutMs)
			timer.unref?.()
			this.pairingWaiter = { resolve, reject, timer }
		})
	}

	private async onPairDevice(node: BinaryNode): Promise<void> {
		const pairDevice = findChild(node, 'pair-device')
		const raw = pairDevice?.stringAt(0)
		if (!raw) return
		try {
			const { body } = JSON.parse(raw) as { body: string }
			const codePairDevice = protoDecode<{ currentMasterKey: Buffer; currentDeviceKey: Buffer }>(CodePairDevice, Buffer.from(body, 'base64'))
			this.handshake.noiseKey.private.set(codePairDevice.currentDeviceKey)
			this.logger.info('claves del dispositivo recibidas; esperando pair-success')
		} catch (err) {
			this.logger.warn({ err: errorMessage(err) }, 'pair-device malformado')
		}
	}

	private async handleMessageNode(node: BinaryNode): Promise<void> {
		// ack
		if (node.attrs.ack !== undefined) {
			this.emit('debug', { level: 'trace', message: `ack ${node.attrs.ack}`, node })
		}

		const content = findChild(node, 'content')?.stringAt(0)
		if (!content) return

		let parsed: { type: string; body: string } | null = null
		try {
			parsed = JSON.parse(content) as { type: string; body: string }
		} catch {
			return
		}

		if (parsed.type === 'ciphertext' || parsed.type === 'pktt') {
			await this.handleEncryptedMessage(node, parsed.body)
			return
		}
		if (parsed.type === 'text' || parsed.type === 'protocol') {
			const proto = decodeProtocolContent(content)
			this.emit('debug', { level: 'debug', message: `msg tipo ${parsed.type}`, node, data: proto })
		}
	}

	/** Descifra un mensaje entrante y emite `messages.upsert`. */
	private async handleEncryptedMessage(node: BinaryNode, body: string): Promise<void> {
		const own = this.ownIdentity
		if (!own) return

		const protocol = protoDecode<ProtoObject & { ciphertext?: string }>(SignalProtocolMessage, Buffer.from(body, 'base64'))
		const ciphertext = protocol.ciphertext
		if (!ciphertext) {
			this.emit('debug', { level: 'debug', message: 'cipher sin ciphertext', node })
			return
		}

		const from = parseJid(node.attrs.from ?? node.attrs.participant ?? '')
		const sessionId = SessionManager.sessionId(from.user, 0)

		try {
			let session: SignalSession
			if (this.sessionManager.has(from.user)) {
				session = this.sessionManager.get(from.user)
			} else {
				// Sesión nueva: es un PreSignalMessage, se resuelve con X3DH
				const ratchet = initRatchet({
					sharedSecret: Buffer.alloc(32),
					chainKey: Buffer.alloc(32),
					identityKeyPair: own.identityKeyPair,
					signedPreKeyPair: own.signedPreKeyPair
				})
				session = new SignalSession(sessionId, ratchet)
			}

			const plaintext = session.decrypt(protocol)
			if (!plaintext) {
				this.emit('debug', { level: 'debug', message: 'mensaje duplicado, se ignora' })
				return
			}

			const info = protoDecode<ProtoObject>(WebMessageInfo, plaintext)
			this.sessionManager.set(from.user, 0, session)
			await this.persistSessions()

			this.emit('messages.upsert', {
				messages: [{
					key: (info.key ?? {}) as WAMessage['key'],
					message: (info.message ?? undefined) as WAMessage['message'],
					messageTimestamp: info.messageTimestamp as WAMessage['messageTimestamp'],
					status: (info.status ?? MessageStatus.PENDING) as number,
					pushName: info.pushName as string | undefined,
					participant: (info.participant ?? undefined) as string | undefined
				}],
				type: 'notify'
			})
		} catch (err) {
			this.logger.warn({ err: errorMessage(err), jid: sessionId }, 'no se pudo descifrar el mensaje')
			this.emit('debug', { level: 'debug', message: 'fallo de descifrado', node, data: errorMessage(err) })
		}
	}

	// -----------------------------------------------------------------------
	// Estado y reconexión
	// -----------------------------------------------------------------------

	private setState(update: ConnectionUpdate): void {
		this.state = update.state
		this.emit('connection.update', update)
	}

	private handleDisconnect(info: { reason?: string; error?: Error; code?: number }): void {
		if (this.state === 'closed' && !this.reconnection) return

		const code = info.code ?? getStatusCodeForSocketError(info.error)

		this.timers.markDisconnected()
		this.timers.stopKeepAlive()
		this.noiseSession = null
		this.transport?.close()
		this.transport = null
		this.state = 'closed'

		if (this.expectedDisconnect) return

		if (code !== undefined && isReloginCode(code)) {
			this.logger.info({ code }, 'desconexión que requiere rehacer el registro')
			this.emit('connection.update', { state: 'closed', statusCode: code })
			this.emit('logout', { reason: String(code) })
			return
		}

		if (this.reconnection) {
			// ya estamos reintentando: solo actualiza el estado
			this.emit('connection.update', { state: 'connecting' })
			return
		}

		this.emit('connection.update', { state: 'closed', statusCode: code })
		const delay = this.timers.scheduleReconnect(
			this.config.reconnectDelayMs ?? 1000,
			this.config.maxReconnectDelayMs ?? 30_000,
			this.config.maxReconnectAttempts ?? 5
		)
		if (delay === null) {
			this.logger.error('se agotaron los reintentos de reconexión')
			return
		}
		this.logger.info({ delay, attempt: this.reconnectAttempts }, 'reconectando')
		this.emit('connection.update', { state: 'connecting', retryIn: delay })
		this.reconnection = true
	}

	/** Reconexión explícita. */
	async reconnect(): Promise<void> {
		if (this.state === 'online' || this.state === 'open') return
		this.reconnection = true
		this.timers.cancelReconnect()
		this.state = 'closed'
		this.transport?.close()
		this.transport = null
		try {
			await this.connect()
		} catch (err) {
			this.logger.error({ err: errorMessage(err) }, 'fallo al reconectar')
			this.handleDisconnect({ error: err as Error })
		}
	}

	// -----------------------------------------------------------------------
	// Utilidades internas
	// -----------------------------------------------------------------------

	private buildUserAgent(): ProtoObject {
		return protoDecode(UserAgent, protoEncode(UserAgent, {
			platform: Platform.WEB,
			appVersion: this.version.release,
			mcc: this.config.countryCode ?? '000',
			mnc: '000',
			locale: 'es_ES',
			phoneId: randomBytes(16),
			releaseChannel: 0,
			osVersion: '0.1',
			manufacturer: 'wasa',
			phone: this.config.phoneNumber ?? '',
			phoneCountry: this.config.countryCode ?? 'ES',
			phoneRegion: 'ES',
			device: 0
		} as ProtoObject))
	}

	private buildWebInfo(): ProtoObject {
		return protoDecode(WebInfo, protoEncode(WebInfo, {
			refToken: randomBytes(16),
			version: this.version.version,
			platform: Platform.WEB,
			platformType: 1,
			webSubPlatform: 72
		} as ProtoObject))
	}

	/** Guarda el estado de las sesiones de Signal; sin esto el ratchet se rompe. */
	private async persistSessions(): Promise<void> {
		await this.store.set(Collections.SESSIONS, 'sessions', this.sessionManager.export())
	}

	/** Restaura las sesiones de Signal del store. */
	async loadSessions(): Promise<void> {
		const raw = await this.store.get<Array<Record<string, unknown>>>(Collections.SESSIONS, 'sessions')
		if (raw) this.sessionManager.import(raw)
	}

	/** Borra el estado de la sesión en memoria. */
	async reset(): Promise<void> {
		await this.store.destroy()
		this.sessionManager.clear()
		this.auth.creds = undefined
		this.auth.noiseKey = undefined
		this.isRegistered = false
	}

	/** Emite el estado actual. */
	get connectionUpdate(): ConnectionUpdate {
		return { state: this.state, me: this.auth.creds?.me }
	}
}

// ---------------------------------------------------------------------------

/**
 * El bundle de prekeys que devuelve el servidor viene con un shape propio: los
 * campos planos (`signedPreKeyId`, `preKeyId`) y además sub-bundles
 * `signedPreKey` / `preKey` con su propia firma.
 */
const PreKeyBundleSchema = defineSchema('PreKeyBundleResponse', {
	registrationId: { type: 'uint32' },
	deviceId: { type: 'uint32' },
	preKeyId: { type: 'uint32' },
	signedPreKeyId: { type: 'uint32' },
	signedPreKey: { type: 'bytes' },
	preKeySignature: { type: 'bytes' },
	identityKey: { type: 'bytes' },
	identityKeyEd25519: { type: 'bytes' },
	preKey: { type: 'bytes' }
})
