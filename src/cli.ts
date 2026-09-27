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

import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline'
import { WaSocket, type ConnectionUpdate, type WASocketConfig } from './index.ts'
import { errorMessage } from './util/errors.ts'
import qrcode from 'qrcode-terminal'

const [, , command = 'connect', ...rest] = process.argv

function usage(): void {
	console.log(`uso: npm run cli -- <comando> [args]

comandos:
  pair qr                  empareja mostrando un QR rotatorio
  pair code <número>       pide el código de 8 caracteres al móvil y lo teclea
  connect                  abre el socket y muestra los cambios de estado
  send <jid> <texto>       envía un texto
  watch                    se queda escuchando mensajes
  logout                   cierra la sesión y borra las credenciales
  help                     esta ayuda

El jid se puede dar como número suelto; se normaliza a <numero>@s.whatsapp.net.

El emparejamiento necesita la clave estática del servidor. Se toma de, por
orden: WASA_STATIC_KEY (base64, 32 bytes), o --static-key <base64>.`)
}

/** Lee la clave estática del entorno o del flag `--static-key`. */
function resolveStaticKey(args: string[]): WASocketConfig {
	const flagIndex = args.indexOf('--static-key')
	const fromFlag = flagIndex >= 0 ? args[flagIndex + 1] : undefined
	const raw = fromFlag ?? process.env.WASA_STATIC_KEY
	if (!raw) return {}
	return { staticKey: Buffer.from(raw, 'base64') }
}

function normalizeJid(input: string): string {
	if (input.includes('@')) return input
	const digits = input.replace(/\D/g, '')
	return `${digits}@s.whatsapp.net`
}

function makeSocket(extra: WASocketConfig = {}): WaSocket {
	return new WaSocket({
		sessionId: process.env.WASA_SESSION ?? 'default',
		...resolveStaticKey(process.argv),
		...extra
	})
}

/**
 * Muestra el QR en la terminal.
 *
 * El QR rota solo: cada vez que llega uno nuevo se vuelve a pintar, porque el
 * anterior ya caducó.
 */
function attachQrPrinter(sock: WaSocket): void {
	sock.on('pairing.update', update => {
		if (update.kind !== 'awaiting-qr' || !update.qr) return
		console.log('\nEscanea este QR en WhatsApp → Ajustes → Dispositivos vinculados:\n')
		qrcode.generate(update.qr, { small: true }, code => console.log(code))
	})
	sock.on('pairing.update', update => {
		if (update.kind === 'awaiting-code') {
			console.log(`\nSe ha pedido un código de 8 caracteres para ${update.phone}.`)
			console.log('Tecléalo con:  npm run cli -- code <código>\n')
		}
		if (update.kind === 'paired') console.log('\nemparejamiento confirmado')
		if (update.kind === 'idle' && update.reason) console.log(`\nemparejamiento fallido: ${update.reason}`)
	})
}

/** Pide una línea por stdin, para el código de emparejamiento. */
function prompt(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	return new Promise(resolve => {
		rl.question(question, answer => {
			rl.close()
			resolve(answer.trim())
		})
	})
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

		case 'pair': {
			const [method = 'qr', ...pairArgs] = rest
			const useCode = method === 'code'
			const phone = pairArgs[0]
			if (useCode && !phone) {
				console.error('falta el número: npm run cli -- pair code <número>')
				return 2
			}

			const sock = makeSocket(useCode ? { pairingMethod: 'code', phoneNumber: phone } : { pairingMethod: 'qr' })
			sock.on('stream.error', err => console.error(`error: ${errorMessage(err)}`))
			attachQrPrinter(sock)

			// Se espera el emparejamiento en segundo plano para poder seguir
			// interactuando con stdin mientras se muestra el QR o se pide el
			// código.
			const paired = sock.waitForPairing()
			await sock.connect()

			if (useCode) {
				await new Promise(resolve => setTimeout(resolve, 500))
				const code = await prompt('Código de 8 caracteres del móvil: ')
				await sock.submitPairingCode(code)
			}

			await paired
			await waitUntilReady(sock)
			console.log(`emparejado como ${sock.me?.id ?? '(desconocido)'}`)
			sock.end()
			return 0
		}

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
