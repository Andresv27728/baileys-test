/**
 * Versión del cliente y token de release.
 *
 * El servidor de WhatsApp rechaza clientes que no se identifiquen con una
 * build real. El `waVersion` (token de release + versión + platform) se saca
 * del bundle de `web.whatsapp.com`; aquí se puede fijar a mano o descubrirlo
 * en tiempo de ejecución.
 */

import { Buffer } from 'node:buffer'

export const DEFAULT_URL = 'wss://web.whatsapp.com/ws/chat'

export const Platform = {
	WEB: '0',
	ANDROID: '1',
	IOS: '2'
} as const

export type Platform = (typeof Platform)[keyof typeof Platform]

export interface WaVersion {
	/** token de release, p.ej. "WABetaRelease/2.3000.10xxxx" */
	release: string
	/** versión de web, p.ej. "2.3000.10xxxx" */
	version: string
	platform: Platform
	/** platformType del WebInfo: 1 = web, 4 = facebook, 72 = hermes */
	platformType?: number
	webSubPlatform?: number
	/** si está presente, se envía en la query */
	ua?: string
	/** User-Agent completo del HTTP request */
	userAgent: string
	/** marca de tiempo de la query, se refresca por conexión */
	[key: string]: unknown
}

export const DEFAULT_WA_VERSION: WaVersion = {
	release: 'WABetaRelease/2.3000.1028706',
	version: '2.3000.1028706',
	platform: Platform.WEB,
	platformType: 1,
	webSubPlatform: 72,
	userAgent:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

/**
 * Construye la query del handshake. El servidor valida que los campos
 * coincidan con la build declarada, así que deben ir todos.
 */
export function buildQuery(version: WaVersion): string {
	const now = Math.floor(Date.now() / 1000)
	const params: Record<string, string | number> = {
		cc: 0,
		expt: 24,
		auth: 0,
		key: '0',
		news: 0,
		cr: 0,
		// ...
		_models: 0,
		_rc: 0,
		_t: '',
		waid: '0',
		//_pragma_num_sequences: 0,
		_c: '',
		ct: '2',
		// ...
		t: String(now),
		rc: 0,
		r: 1,
		sm: '2',
		_dec: 0,
		//_ax_blob_v: '',
		fb: 0,
		//_ax_...'': '',
		s: 0,
		v: version.version,
		// ...
		WABetaRelease: version.release.split('/')[1] ?? version.release,
		WAWeb: '1',
		wv: version.version,
		// ...
		_agent: 'WhatsApp/2.3000.1028706 Web/2.3000.1028706',
		platform: version.platform
	}
	const qs = Object.entries(params)
		.filter(([, v]) => v !== '')
		.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
		.join('&')
	return '?' + qs
}

/** Token P-256 que se envía en el handshake de Noise. */
export interface WATokenRequest {
	token: string
	version: number
	identities?: string[]
	exp0: number
	iat0: number
	flags?: number
	lhks?: unknown
	bk?: string
}

export const DEFAULT_WA_CERT = {
	issuer: 'WhatsApp',
	serial: 1,
	subject: 'WhatsApp',
	issuedAt: 0,
	expiresAt: 0,
	notBefore: 0,
	notAfter: 0
}
