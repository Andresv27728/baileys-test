/**
 * CLI de prueba.
 *
 * Sirve para ejercitar el cliente a mano sin escribir un script cada vez:
 *
 *   npm run cli                    conecta y muestra el estado
 *   npm run cli -- send <jid> <txt> envía un mensaje
 *   npm run cli -- watch           se queda escuchando mensajes
 *   npm run cli -- logout          cierra sesión y borra credenciales
 *
 * La sesión se guarda en `.wasa/<sessionId>`, así que se conserva entre
 * ejecuciones.
 */

import { WaSocket, type ConnectionUpdate, type WASocketConfig } from './index.ts'
import { errorMessage } from './util/errors.ts'

const [, , command = 'connect', ...rest] = process.argv

function usage(): void {
	console.log(`uso: npm run cli -- <comando> [args]

comandos:
  connect                 abre el socket y muestra los cambios de estado
  send <jid> <texto>      envía un texto
  watch                   conecta y muestra los mensajes que llegan
  logout                  cierra la sesión y borra las credenciales
  help                    esta ayuda

El jid se puede dar como número suelto; se normaliza a <numero>@s.whatsapp.net.`)
}

function normalizeJid(input: string): string {
	if (input.includes('@')) return input
	const digits = input.replace(/\D/g, '')
	return `${digits}@s.whatsapp.net`
}

function makeSocket(): WaSocket {
	return new WaSocket({ sessionId: process.env.WASA_SESSION ?? 'default' } satisfies WASocketConfig)
}

async function waitUntilReady(sock: WaSocket): Promise<void> {
	if (sock.connectionState === 'online') return
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off('connection.update', onUpdate)
			reject(new Error('timeout esperando a que la sesión esté online'))
		}, 60_000)
		timer.unref?.()
		function onUpdate(update: ConnectionUpdate): void {
			console.log(`  estado: ${update.state}`)
			if (update.qr) {
				console.log('\n  Escanea este QR en WhatsApp > Dispositivos enlazados:\n')
				console.log(update.qr)
				console.log('')
			}
			if (update.me) console.log(`  cuenta: ${update.me.id}`)
			if (update.state === 'online') {
				clearTimeout(timer)
				sock.off('connection.update', onUpdate)
				resolve()
			}
			if (update.state === 'closed') {
				clearTimeout(timer)
				sock.off('connection.update', onUpdate)
				reject(new Error('la conexión se cerró antes de estar online'))
			}
		}
		sock.on('connection.update', onUpdate)
	})
}

async function main(): Promise<number> {
	switch (command) {
		case 'help':
		case '--help':
		case '-h':
			usage()
			return 0

		case 'send': {
			const [rawJid, ...words] = rest
			if (!rawJid || words.length === 0) {
				usage()
				return 2
			}
			const sock = makeSocket()
			sock.on('stream.error', err => console.error(`error: ${errorMessage(err)}`))
			await sock.connect()
			await waitUntilReady(sock)
			const jid = normalizeJid(rawJid)
			const sent = await sock.sendText(jid, words.join(' '))
			console.log(`enviado ${sent.key?.id ?? '(sin id)'} a ${jid}`)
			sock.end()
			return 0
		}

		case 'watch': {
			const sock = makeSocket()
			sock.on('stream.error', err => console.error(`error: ${errorMessage(err)}`))
			sock.on('messages.upsert', ({ messages }) => {
				for (const msg of messages) {
					const from = msg.key?.remoteJid ?? '(desconocido)'
					const body = typeof msg.message === 'string' ? msg.message : (msg.pushName ?? '(sin texto)')
					console.log(`[${new Date().toISOString()}] ${from}: ${body}`)
				}
			})
			sock.on('message-receipt.update', receipts => {
				for (const [id, receipt] of Object.entries(receipts)) console.log(`recibo ${id}: ${receipt}`)
			})
			await sock.connect()
			await waitUntilReady(sock)
			console.log('escuchando. Ctrl-C para salir.')
			await new Promise<void>(resolve => {
				process.on('SIGINT', () => {
					console.log('\ncerrando...')
					sock.end()
					resolve()
				})
			})
			return 0
		}

		case 'logout': {
			const sock = makeSocket()
			await sock.connect()
			await sock.logout()
			console.log('sesión cerrada y credenciales borradas')
			return 0
		}

		case 'connect': {
			const sock = makeSocket()
			sock.on('stream.error', err => console.error(`error: ${errorMessage(err)}`))
			await sock.connect()
			console.log(`conectado. estado: ${sock.connectionState}`)
			console.log('cuenta:', sock.me?.id ?? '(sin emparejar)')
			sock.end()
			return 0
		}

		default:
			usage()
			return 2
	}
}

main()
	.then(code => process.exit(code))
	.catch((err: unknown) => {
		console.error(`fallo: ${errorMessage(err)}`)
		process.exit(1)
	})
