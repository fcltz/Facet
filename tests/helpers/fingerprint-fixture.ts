import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'

export const READ_FINGERPRINT = `(() => ({
  ua: navigator.userAgent, webdriver: navigator.webdriver ?? null, platform: navigator.platform, language: navigator.language,
  languages: Array.from(navigator.languages), locale: Intl.DateTimeFormat().resolvedOptions().locale,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, cores: navigator.hardwareConcurrency,
  memory: navigator.deviceMemory ?? null, hints: navigator.userAgentData?.toJSON() ?? null,
  screen: typeof screen === 'undefined' ? null : [screen.width, screen.height, screen.availWidth, screen.availHeight, devicePixelRatio],
  webrtc: (() => { try { if (typeof RTCPeerConnection === 'undefined') return 'absent'; const pc = new RTCPeerConnection(); pc.close(); return 'available' } catch { return 'blocked' } })()
}))()`

/** Site e scripts inteiramente locais; coleta valores já no primeiro script do documento. */
export async function fingerprintFixture() {
  const requests: { path: string; headers: IncomingHttpHeaders }[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    const pathname = request.url?.split('?')[0] ?? '/'
    requests.push({ path: request.url ?? '/', headers: request.headers })
    if (pathname.endsWith('.js')) {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
      if (pathname === '/worker.js') response.end(`postMessage(${READ_FINGERPRINT})`)
      else if (pathname === '/shared.js')
        response.end(`onconnect = event => event.ports[0].postMessage(${READ_FINGERPRINT})`)
      else
        response.end(
          `oninstall = () => self.skipWaiting(); onactivate = event => event.waitUntil(clients.claim()); onmessage = event => event.ports[0].postMessage(${READ_FINGERPRINT});`,
        )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    if (pathname === '/frame') {
      response.end(
        `<!doctype html><script>window.first = ${READ_FINGERPRINT}; parent.postMessage({frame:location.hostname, data:window.first}, '*')</script>`,
      )
      return
    }
    // páginas feitas para celular declaram a largura do aparelho (sem isso, 980 px, como no celular)
    const viewport = request.url?.includes('viewport')
      ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
      : ''
    response.end(`<!doctype html>${viewport}<title>Facet fingerprint fixture</title><h1>Fingerprint fixture</h1>
      <script>
        window.first = ${READ_FINGERPRINT}; window.reports = {};
        addEventListener('message', event => { if (event.data.frame) window.reports[event.data.frame] = event.data.data });
        if (location.pathname === '/page') {
          const worker = new Worker('/worker.js'); worker.onmessage = event => window.reports.worker = event.data;
          const shared = new SharedWorker('/shared.js'); shared.port.onmessage = event => window.reports.shared = event.data;
          navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(reg => {
            const channel = new MessageChannel(); channel.port1.onmessage = event => window.reports.service = event.data;
            reg.active.postMessage('observe', [channel.port2]);
          }).catch(error => window.reports.error = String(error));
          for (const host of ['127.0.0.1', 'localhost']) {
            const frame = document.createElement('iframe'); frame.src = location.protocol + '//' + host + ':' + location.port + '/frame'; document.body.append(frame);
          }
        }
      </script>`)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done) => server.listen(0, done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Porta indisponível')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
