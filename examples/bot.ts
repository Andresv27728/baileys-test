/**
 * Bot mínimo sobre wasa.
 *
 *   npm run bot
 *
 * Antes de la primera vez hay que emparejar la sesión (ver README). El proceso
 * se queda escuchando y responde a los comandos.
 *
 * Cosas que un bot tiene que mirar sí o sí, y que están resueltas aquí:
 *
 *   - No contestar a los mensajes propios, ni a los status.
 *   - Deduplicar por id: WhatsApp reenvía notificaciones y además llega el
 *     historial al sincronizar, así que sin esto el bot contesta dos veces (o
 *     a mil mensajes viejos).
 *   - Que un handler que lance no tumbe el proceso entero.
 *   - Salir limpiamente con Ctrl-C.
 */

import { WaSocket, extractMessageText, type WAMessage } from '../src/index.ts'
import { errorMessage } from '../src/util/errors.ts'

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const PREFIX = '/'
/** Cuánto recordamos un id para no contestar dos veces al mismo mensaje. */
const DEDUPE_TTL_MS = 5 * 60_000
const DEDUPE_MAX = 5000
/** Si es true, solo contesta en chats privados, no en grupos. */
const ONLY_PRIVATE = true

// ---------------------------------------------------------------------------
// Estado del bot
// ---------------------------------------------------------------------------

/**
 * Ids ya vistos, con la hora.
 *
 * `Map` porque podemos borrar los viejos en orden, en vez de mantener un
 * temporizador por mensaje.
 */
const seen = new Map<string, number>()

function alreadyHandled(id: string): boolean {
	const now = Date.now()
	const at = seen.get(id)
	if (at !== undefined && now - at < DEDUPE_TTL_MS) return true

	seen.set(id, now)
	// Poda: si nos pasamos de ids, quitamos los más antiguos.
	if (seen.size > DEDUPE_MAX) {
		for (const key of seen.keys()) {
			if (seen.size <= DEDUPE_MAX / 2) break
			seen.delete(key)
		}
	}
	return false
}

/** ¿Es un grupo? Los grupos acaban en `@g.us`. */
function isGroup(remoteJid: string): boolean {
	return remoteJid.endsWith('@g.us')
}

/** Los status son broadcasts con `status@broadcast`. */
function isStatusBroadcast(remoteJid: string): boolean {
	return remoteJid.startsWith('status@')
}

// ---------------------------------------------------------------------------
// Lógica del bot
// ---------------------------------------------------------------------------

async function handleMessage(sock: WaSocket, msg: WAMessage): Promise<void> {
	// Los mensajes propios y los status nunca se responden.
	if (msg.key.fromMe) return
	if (isStatusBroadcast(msg.key.remoteJid)) return
	if (ONLY_PRIVATE && isGroup(msg.key.remoteJid)) return

	// Reenvíos del mismo id: fuera.
	if (alreadyHandled(msg.key.id)) return

	const text = extractMessageText(msg.message).trim()
	const from = msg.key.remoteJid
	const who = msg.pushName ?? from

	// Sin texto puede ser audio, sticker o lo que sea; aquí no hacemos nada,
	// pero es el sitio donde meter transcribed-on-device o lo que toque.
	if (!text) {
		console.log(`[${who}] mensaje sin texto (${Object.keys(msg.message ?? {}).join(',') || 'vacío'})`)
		return
	}

	console.log(`[${who}] ${text}`)

	if (!text.startsWith(PREFIX)) return

	const [command = '', ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
	const argument = args.join(' ')

	switch (command.toLowerCase()) {
		case 'help':
		case 'ayuda':
			await sock.sendText(from, [
				`Comandos con "${PREFIX}":`,
				`${PREFIX}help — esta ayuda`,
				`${PREFIX}ping — comprobar que sigue vivo`,
				`${PREFIX}echo <texto> — repetir`,
				`${PREFIX}hora — hora del servidor`
			].join('\n'))
			return

		case 'ping':
			await sock.sendText(from, 'pong')
			return

		case 'echo':
			await sock.sendText(from, argument || 'no has dicho nada')
			return

		case 'hora':
			await sock.sendText(from, new Date().toISOString())
			return

		default:
			await sock.sendText(from, `No conozco el comando "${PREFIX}${command}". Prueba ${PREFIX}help`)
	}
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const sock = new WaSocket({
		sessionId: process.env.WASA_SESSION ?? 'bot',
		pairingMethod: process.env.WASA_PHONE ? 'code' : 'qr',
		phoneNumber: process.env.WASA_PHONE
	})

	sock.on('connection.update', update => {
		console.log(`[conexión] ${update.state}`)
		if (update.me) console.log(`[cuenta] ${update.me.id}`)
	})

	sock.on('pairing.update', update => {
		if (update.kind === 'awaiting-qr' && update.qr) {
			console.log('[emparejamiento] QR listo, escanéalo en el móvil (se renueva cada 20 s)')
		}
		if (update.kind === 'awaiting-code') console.log('[emparejamiento] esperando el código de 8 caracteres')
		if (update.kind === 'paired') console.log('[emparejamiento] confirmado')
		if (update.kind === 'idle' && update.reason) console.log(`[emparejamiento] fallido: ${update.reason}`)
	})

	sock.on('messages.upsert', ({ messages }) => {
		for (const msg of messages) {
			// Cada mensaje va por su cuenta: si uno falla, los demás siguen.
			handleMessage(sock, msg).catch(err => {
				console.error(`[error] manejando ${msg.key.id}: ${errorMessage(err)}`)
			})
		}
	})

	sock.on('message-receipt.update', receipts => {
		for (const [id, status] of Object.entries(receipts)) {
			console.log(`[recibo] ${id} → ${status}`)
		}
	})

	sock.on('stream.error', err => {
		console.error(`[stream] ${errorMessage(err)}`)
	})

	sock.on('logout', ({ reason }) => {
		console.log(`[sesión] cerrada: ${reason}`)
		process.exit(0)
	})

	await sock.connect()
	console.log('[bot] en marcha. Ctrl-C para salir.')

	// Presencia: sin esto el número puede aparecer como "no disponible".
	await sock.sendPresenceUpdate('available').catch(() => undefined)

	const shutdown = (signal: string): void => {
		console.log(`\n[bot] ${signal}, cerrando`)
		sock.end()
		process.exit(0)
	}
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
	console.error(`[bot] no pudo arrancar: ${errorMessage(err)}`)
	if (err instanceof Error && err.message.includes('clave estática')) {
		console.error('\nFalta la clave estática del servidor. Mira la sección "La clave estática" del README.')
	}
	process.exit(1)
})
