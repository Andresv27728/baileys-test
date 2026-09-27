# wasa

Cliente de WhatsApp implementado desde cero en TypeScript: protocolo binario,
Noise, Signal y store persistente. No usa Baileys ni ningún otro cliente como
base.

## Estado

Lo que está verificado con tests (46, todos en verde):

- Codec protobuf: varint, fixed32/64, bytes, mensajes anidados, `float`/`double`.
- Framing WebSocket: extensible de 8/16/32 bits y compresión.
- X3DH: bundle de prekeys, firma del prekey firmado, con y sin prekey de un solo uso.
- Double Ratchet: ida y vuelta, mensajes fuera de orden, rechazo de duplicados,
  serialización del estado.
- Emparejamiento: formato del código de 8 caracteres, payload del QR, validación.

Lo que **no** está verificado contra tráfico real: el handshake con el servidor,
el formato exacto del QR, la clave del prekey firmado y el resto del protocolo
como lo implementa WhatsApp hoy. Ver "Limitaciones".

## Instalación

```bash
npm install
```

Node 22.6 o superior (usa el strip-types nativo, sin paso de compilación para
correr). Para instalar, `npm run build`.

## Uso

```ts
import { WaSocket } from 'wasa'

const sock = new WaSocket({ sessionId: 'mi-sesion' })

sock.on('messages.upsert', ({ messages }) => {
  for (const msg of messages) console.log(msg.key?.remoteJid, msg.pushName)
})

await sock.connect()
await sock.sendText('34600112233', 'hola')
```

## Emparejamiento

Hay dos métodos, igual que en WhatsApp.

### Por QR

```ts
const sock = new WaSocket({ pairingMethod: 'qr' })
sock.on('connection.update', u => { if (u.qr) console.log(u.qr) })
sock.on('pairing.update', u => { if (u.kind === 'paired') console.log('listo') })

await sock.connect()
await sock.waitForPairing()
```

El QR se emite en `connection.update` y también en `pairing.update`, y se
rota cada 20 s porque caduca rápido.

### Por código de 8 caracteres

```ts
const sock = new WaSocket({ pairingMethod: 'code', phoneNumber: '+34600112233' })
sock.on('pairing.update', u => { if (u.kind === 'awaiting-code') console.log('teclea el código') })

await sock.connect()
await sock.submitPairingCode('ABCD-1234')
await sock.waitForPairing()
```

El código se acepta en mayúsculas, minúsculas y con guion, porque lo teclea una
persona: `normalizePairingCode` lo limpia antes de mandarlo.

### CLI

```bash
npm run cli -- pair qr
npm run cli -- pair code +34600112233
npm run cli -- send 34600112233 "hola"
npm run cli -- watch
npm run cli -- logout
```

## La clave estática del servidor

El handshake de Noise necesita la clave estática de 32 bytes del servidor para
verificar la firma del `serverHello`. **WhatsApp Web ya no la publica de forma
legible**: se revisaron los 9 bundles de `web.whatsapp.com` y no aparece en el
HTML ni en el JS. Hay que aportarla, por orden de prioridad:

```ts
new WaSocket({ staticKey: Buffer.from('...', 'base64') })   // 1
WASA_STATIC_KEY='...' npm run cli -- pair qr                 // 2
new WaSocket({ serverConfigUrl: 'https://mi-servidor/cfg' }) // 3
```

La 3 espera un JSON `{"staticKey": "<base64>"}`. Sin ninguna de las tres,
`connect()` falla con un error que lo dice explícitamente.

## Limitaciones

- El QR y el código están implementados a nivel de protocolo y validados con
  tests, pero no se han podido probar contra WhatsApp porque falta la clave
  estática del servidor.
- El `Double Ratchet` usa un modelo de una sola cadena compartida en vez de las
  dos cadenas de la especificación de Signal. El motivo está explicado al
  principio de `src/protocol/signal/ratchet.ts`: rotar la clave de ratchet al
  recibir descuadra al otro lado. Mantiene secreto hacia adelante, pero
  desvía de Signal y no es interoperable con él.
- Los medios se rellenan con metadatos, no se suben.
- El protocolo de WhatsApp cambia sin aviso; este código está escrito sobre
  aproximaciones reverse-engineered.

## Estructura

```
src/
  proto/      codec protobuf y schemas
  transport/  WebSocket, framing, nodos binarios
  protocol/
    noise/    handshake y sesión
    signal/   X3DH, ratchet, sesiones
  store/      memoria y SQLite
  socket/     WaSocket, eventos, emparejamiento, timers
  api/        superficie pública
test/
```

## Licencia

MIT
