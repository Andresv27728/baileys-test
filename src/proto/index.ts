import { decode, encode, encodedSize, defineSchema, lazySchema, type ProtoObject, type Schema } from './codec.ts'
import { WAProto, Message, ContextInfo } from './schema.ts'

export * from './codec.ts'
export { WAProto }

export type ProtoEnum = Record<string, Schema>
export type ProtoType = Record<string, Schema>

/** `decode(schema, bytes)` con inferencia del tipo de retorno. */
export function protoDecode<T extends ProtoObject = ProtoObject>(name: keyof typeof WAProto, data: Uint8Array): T {
	const schema = WAProto[name]
	if (!schema) throw new Error(`mensaje desconocido: ${String(name)}`)
	return decode<T>(schema, data)
}

export function protoEncode(name: keyof typeof WAProto, data: ProtoObject): Buffer {
	const schema = WAProto[name]
	if (!schema) throw new Error(`mensaje desconocido: ${String(name)}`)
	return encode(schema, data)
}

export function protoSize(name: keyof typeof WAProto, data: ProtoObject): number {
	const schema = WAProto[name]
	if (!schema) throw new Error(`mensaje desconocido: ${String(name)}`)
	return encodedSize(schema, data)
}

/**
 * `jsonToProtobuf`: convierte `{ Conversation: 'hola' }` a bytes.
 * Se usa para el campo `message` de los nodos, que travelan como
 * `{"type": <nombre>, "body": <base64>}`.
 */
export function nodeToProto(type: string, obj: ProtoObject): Buffer {
	const schema = WAProto[type as keyof typeof WAProto] as Schema | undefined
	if (!schema) throw new Error(`tipo de nodo sin schema: ${type}`)
	return encode(schema, obj)
}

export function protoToNode<T extends ProtoObject = ProtoObject>(type: string, data: Uint8Array): T {
	const schema = WAProto[type as keyof typeof WAProto] as Schema | undefined
	if (!schema) throw new Error(`tipo de nodo sin schema: ${type}`)
	return decode<T>(schema, data)
}

export { Message, ContextInfo, defineSchema, lazySchema, decode, encode, encodedSize }
