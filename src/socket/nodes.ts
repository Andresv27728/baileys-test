/**
 * Utilidades de nodo: construir y leer los `BinaryNode` del protocolo.
 *
 * Aquí vive la traducción entre el mundo JSON de la API y el mundo binario
 * del socket, para que el cliente no tenga que repetirlo.
 */

import { Buffer } from 'node:buffer'
import { BinaryNode } from '../transport/binary-node.ts'
import { decode, encode, type ProtoObject } from '../proto/codec.ts'
import { WAProto } from '../proto/schema.ts'

export type NodeType = keyof typeof WAProto

/** Los attrs viajan siempre como texto en el cable; aquí se acepta lo cómodo. */
export type NodeAttrs = Record<string, string | number | boolean | undefined>

export function stringifyAttrs(attrs: NodeAttrs): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(attrs)) {
		out[key] = value === undefined || value === null ? undefined : String(value)
	}
	return out
}

/** Nodo con contenido base64, la forma mayoritaria en WhatsApp. */
export function base64Node(tag: string, attrs: NodeAttrs, content: Array<string | Buffer | BinaryNode> = []): BinaryNode {
	return new BinaryNode(tag, stringifyAttrs(attrs), content)
}

export function stringNode(tag: string, attrs: NodeAttrs, content: string[] = []): BinaryNode {
	return new BinaryNode(tag, stringifyAttrs(attrs), content)
}

/** Nodo `iq` de consulta. */
export function iqNode(attrs: NodeAttrs, content: Array<string | Buffer | BinaryNode> = []): BinaryNode {
	return new BinaryNode('iq', stringifyAttrs(attrs), content)
}

/** Nodo de presencia: `available` / `unavailable` / `composing`. */
export function presenceNode(presence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'): BinaryNode {
	return new BinaryNode('presence', {}, [presence])
}

export function pingNode(): BinaryNode {
	return iqNode({ type: 'get', id: waId('PND') }, [stringNode('ping', {})])
}

export function receiptsNode(receipts: Array<{ messageId: string; receipt: string; participant?: string; to?: string }>): BinaryNode {
	const content: Array<BinaryNode> = []
	const byParticipant = new Map<string, string[]>()
	for (const r of receipts) {
		const key = r.participant ?? r.to ?? ''
		const list = byParticipant.get(key) ?? []
		list.push(r.messageId)
		byParticipant.set(key, list)
	}
	for (const [participant, ids] of byParticipant) {
		const attrs: Record<string, string | undefined> = { type: 'received' }
		if (participant) attrs.participant = participant
		content.push(stringNode('ack', attrs, ids))
	}
	return new BinaryNode('receipt', {}, content)
}

/** Nodo `msg` normal (sin cifrar). */
export function messageNode(
	attrs: { to: string; type?: string; id?: string; participant?: string; from?: string; ack?: number } | NodeAttrs,
	content: Array<string | BinaryNode> = []
): BinaryNode {
	return new BinaryNode('msg', stringifyAttrs(attrs), content)
}

/** Nodo `msg` con contenido protobuf (el caso de los mensajes de texto). */
export function protocolMessageNode(
	attrs: { to: string; participant?: string },
	protocol: ProtoObject,
	messageType: keyof typeof WAProto
): BinaryNode {
	return messageNode({ ...attrs, type: 'text' }, [stringNode('content', {}, [protocolMessageContent(protocol, messageType)])])
}

/** Serializa `{ type, body }` donde el body va en base64. */
export function protocolMessageContent(protocol: ProtoObject, messageType: keyof typeof WAProto): string {
	const schema = WAProto[messageType]
	if (!schema) throw new Error(`tipo de protocolo sin schema: ${String(messageType)}`)
	return JSON.stringify({ type: messageType, body: encode(schema, protocol).toString('base64') })
}

/** Lee `{ type, body }` y devuelve el objeto ya decodificado. */
export function decodeProtocolContent(content: string): ProtoObject {
	const { type, body } = JSON.parse(content) as { type: string; body: string }
	const schema = WAProto[type as keyof typeof WAProto]
	if (!schema) throw new Error(`tipo de protocolo desconocido: ${type}`)
	return decode(schema, Buffer.from(body, 'base64'))
}

export function decodeProtocolContentSafe(content: string): ProtoObject | null {
	try {
		return decodeProtocolContent(content)
	} catch {
		return null
	}
}

/** Identificador único de nodo, con el formato que espera WA. */
export function waId(prefix: string): string {
	const now = Date.now()
	const rand = Math.floor(Math.random() * 0xffffff)
	return `${prefix}.${now.toString(36)}.${rand.toString(36).toUpperCase()}`
}

/** Nodo `success` para cerrar un `iq` de tipo `set`. */
export function successNode(id: string): BinaryNode {
	return stringNode('success', { id })
}

/** Convierte un nodo a objeto JS plano, para processing asíncrono. */
export function nodeToJson(node: BinaryNode): { tag: string; attrs: Record<string, string | undefined>; content: unknown[] } {
	return {
		tag: node.tag,
		attrs: node.attrs,
		content: node.content.map(c => (c instanceof BinaryNode ? nodeToJson(c) : c.toString('utf8')))
	}
}

/** Busca un nodo hijo por tag, con atributos opcionales. */
export function findChild(node: BinaryNode, tag: string, attrs?: Record<string, string | undefined>): BinaryNode | undefined {
	for (const child of node.content) {
		if (!(child instanceof BinaryNode)) continue
		if (child.tag !== tag) continue
		if (attrs) {
			const ok = Object.entries(attrs).every(([k, v]) => child.attrs[k] === v)
			if (!ok) continue
		}
		return child
	}
	return undefined
}

export function findAll(node: BinaryNode, tag: string): BinaryNode[] {
	return node.content.filter((c): c is BinaryNode => c instanceof BinaryNode && c.tag === tag)
}

export function findChildPath(node: BinaryNode, path: string[]): BinaryNode | undefined {
	let current: BinaryNode = node
	for (const seg of path) {
		const next = findChild(current, seg)
		if (!next) return undefined
		current = next
	}
	return current
}

/** Etiqueta para diagnóstico: `msg @from`. */
export function nodeLabel(node: BinaryNode): string {
	return `${node.tag}${node.attrs.id ? ` @${node.attrs.id}` : ''}${node.attrs.from ? ` from=${node.attrs.from}` : ''}`
}
