/**
 * Punto de entrada de la librería.
 *
 *   import makeWASocket from 'wasa'
 *   const sock = await makeWASocket()
 */

export * from './api/index.ts'
export { WaSocket as default } from './socket/client.ts'
