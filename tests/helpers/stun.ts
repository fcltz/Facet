import dgram from 'node:dgram'

export interface Stun {
  port: number
  requests: () => number
  close: () => Promise<void>
}

/** Servidor STUN mínimo (Binding Request → XOR-MAPPED-ADDRESS), só em 127.0.0.1. */
export async function stunServer(): Promise<Stun> {
  const socket = dgram.createSocket('udp4')
  let requests = 0
  socket.on('message', (message, remote) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001) return
    requests++
    const attribute = Buffer.alloc(12)
    attribute.writeUInt16BE(0x0020, 0)
    attribute.writeUInt16BE(8, 2)
    attribute.writeUInt8(1, 5)
    attribute.writeUInt16BE(remote.port ^ 0x2112, 6)
    const cookie = [0x21, 0x12, 0xa4, 0x42]
    remote.address
      .split('.')
      .forEach((part, index) => attribute.writeUInt8(Number(part) ^ cookie[index]!, 8 + index))
    const header = Buffer.alloc(20)
    header.writeUInt16BE(0x0101, 0)
    header.writeUInt16BE(attribute.length, 2)
    header.writeUInt32BE(0x2112a442, 4)
    message.copy(header, 8, 8, 20)
    socket.send(Buffer.concat([header, attribute]), remote.port, remote.address)
  })
  await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done))
  return {
    port: socket.address().port,
    requests: () => requests,
    close: () => new Promise<void>((done) => socket.close(() => done())),
  }
}

/**
 * Coleta os candidatos ICE de uma conexão WebRTC com um STUN local (até 5 s).
 * `constructor` é a expressão que obtém o RTCPeerConnection na página.
 */
export function gatherCandidates(stunPort: number, constructor = 'RTCPeerConnection'): string {
  return `(async () => {
    const Connection = ${constructor}
    const pc = new Connection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] })
    const candidates = []
    pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) candidates.push(event.candidate.candidate)
    }
    pc.createDataChannel('facet')
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise((done) => {
      const timer = setTimeout(done, 5000)
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer)
          done()
        }
      }
      pc.onicegatheringstatechange = check
      check()
    })
    pc.close()
    return candidates
  })()`
}
