import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { extractMessageText } from '../src/api/index.ts'
import type { WAMessageContent } from '../src/api/types.ts'

test('un chat normal devuelve su texto', () => {
	assert.equal(extractMessageText({ conversation: 'hola qué tal' }), 'hola qué tal')
})

test('un mensaje con previsualización de enlace devuelve el texto', () => {
	const content: WAMessageContent = {
		extendedTextMessage: {
			text: 'mira esto https://example.com',
			canonicalLink: 'https://example.com'
		}
	}
	assert.equal(extractMessageText(content), 'mira esto https://example.com')
})

test('una foto con pie devuelve el pie, no la url', () => {
	const content: WAMessageContent = {
		imageMessage: {
			caption: 'en la playa',
			url: 'https://mmg.whatsapp.net/x',
			mimetype: 'image/jpeg',
			mediaKey: randomKey()
		}
	}
	assert.equal(extractMessageText(content), 'en la playa')
})

test('video y documento también devuelven su pie', () => {
	assert.equal(
		extractMessageText({ videoMessage: { caption: 'un clip', url: 'https://x', mimetype: 'video/mp4', mediaKey: randomKey() } }),
		'un clip'
	)
	assert.equal(
		extractMessageText({ documentMessage: { caption: 'la factura', url: 'https://x', mimetype: 'application/pdf', mediaKey: randomKey() } }),
		'la factura'
	)
})

test('sin texto devuelve cadena vacía, no undefined', () => {
	assert.equal(extractMessageText(undefined), '')
	assert.equal(extractMessageText({}), '')
	assert.equal(extractMessageText({ stickerMessage: { url: 'https://x', mediaKey: randomKey() } }), '')
	assert.equal(extractMessageText({ reactionMessage: { key: blankKey(), text: '❤️' } }), '')
	assert.equal(extractMessageText({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }), '')
})

test('un texto editado se resuelve en vez de devolver vacío', () => {
	assert.equal(extractMessageText({ editedMessage: { conversation: 'corregido' } }), 'corregido')
})

test('los captions vacíos no pisan una conversación con texto', () => {
	assert.equal(extractMessageText({ conversation: 'texto real', imageMessage: { caption: '', url: 'https://x', mediaKey: randomKey() } }), 'texto real')
})

test('si hay varios candidatos gana el texto principal, no el pie', () => {
	// En un mensaje real de WhatsApp estos campos son excluyentes, pero
	// documentamos la precedencia por si aparece un caso raro: el texto del
	// mensaje manda sobre el pie de un medio adjunto.
	const content: WAMessageContent = {
		imageMessage: { caption: 'pie de foto', url: 'https://x', mediaKey: randomKey() },
		extendedTextMessage: { text: 'texto principal' }
	}
	assert.equal(extractMessageText(content), 'texto principal')
})

function randomKey(): Buffer {
	return Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i))
}

function blankKey(): { remoteJid: string; fromMe: boolean; id: string } {
	return { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: 'X' }
}
