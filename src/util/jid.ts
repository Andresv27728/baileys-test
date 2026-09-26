import { InvalidJidError } from './errors.ts'

export type JidDevice = { user: string; server: string; device: number; agent?: number }
export type Jid = string

export const Server = {
	USER: 's.whatsapp.net',
	BUSINESS: 'g.whatsapp.net',
	GROUP: 'g.us',
	BROADCAST: 'broadcast',
	HOST: 'c.us',
	APP: 'app',
	WEB: 'web.whatsapp.net',
	NEWSLETTER: 'newsletter',
	/** LID: el identificador de usuario "ligero" que sustituye al msisdn. */
	LID: 'lid'
} as const

export type Server = (typeof Server)[keyof typeof Server]

const DEVICE_REGEX = /^(.*?):(\d+)(?::(\d+))?$/

export function parseJid(jid: string): JidDevice {
	if (typeof jid !== 'string' || jid.length === 0) throw new InvalidJidError(String(jid))
	const [bare, deviceStr, agentStr] = jid.split(':')
	const at = bare!.indexOf('@')
	const user = at < 0 ? bare! : bare!.slice(0, at)
	const server = at < 0 ? Server.USER : bare!.slice(at + 1)
	if (!user) throw new InvalidJidError(jid)
	const device = deviceStr ? Number(deviceStr) : 0
	const agent = agentStr ? Number(agentStr) : 0
	return Number.isNaN(device) || device < 0
		? (() => { throw new InvalidJidError(jid) })()
		: { user, server, device, agent }
}

export function isJidUser(jid: string, type: Server = Server.USER): boolean {
	const { user, server } = parseJid(jid)
	return server === type && !user.includes('-')
}

export function isJidGroup(jid: string): boolean {
	return parseJid(jid).server === Server.GROUP
}

export function isJidBroadcast(jid: string): boolean {
	return parseJid(jid).server === Server.BROADCAST
}

export function isJidNewsletter(jid: string): boolean {
	return parseJid(jid).server === Server.NEWSLETTER
}

export function isJidStatusBroadcast(jid: string): boolean {
	const { user } = parseJid(jid)
	return isJidBroadcast(jid) && user === 'status'
}

export function isJidDevice(jid: string): boolean {
	const parts = jid.split(':')
	return parts.length === 3
}

export function stripJidDevice(jid: string): string {
	const { user, server } = parseJid(jid)
	return `${user}@${server}`
}

/** Quita el device_id del jid dejando el AGENT. */
export function encodeJidUser(jid: string): string {
	const { user, server, agent } = parseJid(jid)
	return `${user}@${server}${agent ? `:${agent}` : ''}`
}

/** Devuelve el jid con device_id explícito (necesario para el ACK de mensajes). */
export function encodeJidDevice(jid: string, device: number, agent = 0): string {
	const { user, server } = parseJid(jid)
	return `${user}@${server}:${device}:${agent}`
}

export function getAgent(jid: string): number {
	return parseJid(jid).agent ?? 0
}

export function getDevice(jid: string): number {
	return parseJid(jid).device ?? 0
}

export function getServer(jid: string): Server {
	return parseJid(jid).server as Server
}

export function getUser(jid: string): string {
	return parseJid(jid).user
}

export function isLidUser(jid: string): boolean {
	return parseJid(jid).server === Server.LID
}

export function toLidUser(jid: string): string {
	const parsed = parseJid(jid)
	if (parsed.server === Server.LID) return jid
	return `${parsed.user}@${Server.LID}`
}

/** Compara dos jids ignorando device_id (misma identidad lógica). */
export function areJidsSameUser(a: string, b: string): boolean {
	try {
		return stripJidDevice(a) === stripJidDevice(b)
	} catch {
		return a === b
	}
}
