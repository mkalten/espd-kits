/** ESPD CDC dev sync (browser port of espd/scripts/espd_sync.py core). */

const PUT_CHUNK = 4096
const PUT_BPS = 800000
const STATUS_RE = /^\+OK STATUS sdcard=(yes|no) internal=(yes|no) mode=(normal|msc_sync)$/
const PUT_DONE_RE = /^\+OK PUT done ([0-9a-fA-F]{8})$/

const PATCH_SUFFIXES = ['.pd']
const ASSET_SUFFIXES = ['.wav', '.aiff', '.aif', '.flac', '.ogg', '.mp3', '.raw']

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export function crc32Bytes(data) {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function parseStatus(line) {
  const m = String(line).trim().match(STATUS_RE)
  if (!m) throw new Error(`unexpected STATUS: ${line}`)
  return { sdcard: m[1], internal: m[2], mode: m[3] }
}

export function syncStorePath(info) {
  return info.sdcard === 'yes' ? '/sdcard' : '/storage'
}

function syncNameOk(name, includeAssets) {
  if (!name || name.startsWith('.')) return false
  const low = name.toLowerCase()
  if (name === 'config.txt') return true
  if (PATCH_SUFFIXES.some(s => low.endsWith(s))) return true
  return includeAssets && ASSET_SUFFIXES.some(s => low.endsWith(s))
}

export async function collectSyncFiles(dirHandle, includeAssets = true, prefix = '') {
  const out = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue
    const rel = prefix + name
    if (handle.kind === 'file') {
      if (syncNameOk(name, includeAssets)) out.push(rel)
    } else if (handle.kind === 'directory') {
      out.push(...await collectSyncFiles(handle, includeAssets, rel + '/'))
    }
  }
  return out
}

export async function readFileBytes(dirHandle, rel) {
  const parts = rel.split('/')
  let h = dirHandle
  for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i])
  const file = await (await h.getFileHandle(parts[parts.length - 1])).getFile()
  return new Uint8Array(await file.arrayBuffer())
}

export async function collectSyncMtimes(dirHandle, includeAssets = true, prefix = '') {
  const out = new Map()
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue
    const rel = prefix + name
    if (handle.kind === 'file') {
      if (syncNameOk(name, includeAssets)) {
        const file = await handle.getFile()
        out.set(rel, file.lastModified)
      }
    } else if (handle.kind === 'directory') {
      for (const [k, v] of await collectSyncMtimes(handle, includeAssets, rel + '/')) out.set(k, v)
    }
  }
  return out
}

export async function ensurePortOpen(port) {
  if (port.readable && port.writable) return
  try {
    await port.open({ baudRate: 115200 })
  } catch (e) {
    const msg = String(e.message || e)
    if (msg.includes('already open')) {
      try { await port.close() } catch (_) {}
      await sleep(200)
      await port.open({ baudRate: 115200 })
    } else {
      throw e
    }
  }
}

function syncOrder(rel) {
  if (rel === 'main.pd') return [2, rel]
  if (rel.endsWith('.pd') || rel === 'config.txt') return [1, rel]
  return [0, rel]
}

export class EspdSyncClient {
  constructor(port, { onLine, onLog, onDisconnect } = {}) {
    this.port = port
    this.onLine = onLine || (() => {})
    this.onLog = onLog || (() => {})
    this.onDisconnect = onDisconnect || (() => {})
    this.reader = null
    this.writer = null
    this.stopped = false
    this.disconnected = false
    this.putActive = false
    this.pendingReply = null
    this.lastStatus = null
    this._buf = ''
  }

  log(msg) {
    this.onLog(msg)
  }

  async open() {
    await ensurePortOpen(this.port)
    await this.port.setSignals?.({ dataTerminalReady: true, requestToSend: true }).catch(() => {})
    if (this.reader) {
      try { await this.reader.cancel() } catch (_) {}
      try { this.reader.releaseLock() } catch (_) {}
      this.reader = null
    }
    if (this.writer) {
      try { await this.writer.close() } catch (_) {}
      try { this.writer.releaseLock?.() } catch (_) {}
      this.writer = null
    }
    this.writer = this.port.writable.getWriter()
    this.reader = this.port.readable.getReader()
    this.stopped = false
    this.disconnected = false
    this._readLoop()
    await sleep(250)
  }

  async ensureOpen() {
    if (this.disconnected || this.stopped || !this.writer || !this.reader
        || !this.port.readable || !this.port.writable) {
      await this.open()
    }
  }

  _markDisconnected() {
    this.disconnected = true
  }

  _ioAlive() {
    return !this.disconnected && !this.stopped && this.writer && this.reader
      && this.port.readable && this.port.writable
  }

  async close() {
    this.stopped = true
    this.disconnected = true
    this.pendingReply = null
    try { await this.reader?.cancel() } catch (_) {}
    try { this.reader?.releaseLock() } catch (_) {}
    this.reader = null
    try { await this.writer?.close() } catch (_) {}
    try { this.writer?.releaseLock?.() } catch (_) {}
    this.writer = null
    try { await this.port.close() } catch (_) {}
  }

  _resolveReply(line) {
    if (this.pendingReply) {
      this.pendingReply(line)
      this.pendingReply = null
    }
  }

  async _readLoop() {
    const decoder = new TextDecoder()
    const reader = this.reader
    try {
      while (!this.stopped && this.reader === reader) {
        const { value, done } = await reader.read()
        if (done) break
        this._buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = this._buf.indexOf('\n')) !== -1) {
          const raw = this._buf.slice(0, idx)
          this._buf = this._buf.slice(idx + 1)
          const line = raw.replace(/\r$/, '').trim()
          if (!line) continue
          if (this.putActive) {
            if (line.startsWith('+OK PUT done') || line.startsWith('-ERR')) {
              this.onLine(line, 'dev')
              this._resolveReply(line)
            }
            continue
          }
          if (line.startsWith('+') || line.startsWith('-ERR')) {
            this.onLine(line, 'dev')
            this._resolveReply(line)
          } else {
            this.onLine(line, 'device')
          }
        }
      }
    } catch (_) {
      if (this.reader === reader) this._markDisconnected()
    } finally {
      if (!this.stopped && this.reader === reader) {
        this._markDisconnected()
        this.onDisconnect()
      }
    }
  }

  _clearPendingReply() {
    this.pendingReply = null
  }

  _waitReply(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingReply = null
        if (!this._ioAlive()) {
          reject(new Error('serial disconnected'))
        } else {
          reject(new Error('device reply timeout'))
        }
      }, timeoutMs)
      this.pendingReply = line => {
        clearTimeout(t)
        resolve(line)
      }
    })
  }

  async command(text, timeoutMs = 10000) {
    await this.ensureOpen()
    if (!this.writer) throw new Error('serial disconnected')
    this._clearPendingReply()
    this.log(`→ ${text.trim()}`)
    try {
      await this.writer.write(new TextEncoder().encode(text.endsWith('\n') ? text : text + '\n'))
    } catch (e) {
      this._markDisconnected()
      throw new Error(`serial disconnected: ${e.message || e}`)
    }
    return this._waitReply(timeoutMs)
  }

  async status() {
    const line = await this.command('STATUS', 10000)
    if (line.startsWith('+OK STATUS')) {
      this.lastStatus = line
      return parseStatus(line)
    }
    throw new Error(line)
  }

  deviceStatus() {
    if (this.lastStatus?.startsWith('+OK STATUS')) return parseStatus(this.lastStatus)
    return this.status()
  }

  async setMode(mode) {
    try {
      await this.command(`MODE ${mode}`, 3000)
    } catch (_) {
      /* reboot disconnects CDC */
    }
  }

  async reload() {
    await this.command('RELOAD', 30000)
  }

  async resetDevice() {
    try {
      await this.command('RESET', 2000)
    } catch (_) {}
  }

  async putFile(relPath, data) {
    const crc = crc32Bytes(data)
    const nbytes = data.length
    const probeTimeout = Math.max(30000, nbytes / 40)
    const doneTimeout = Math.max(60000, nbytes / 8)
    let line = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        line = await this.command(`PUT ${relPath} ${nbytes} ${crc.toString(16).padStart(8, '0')}`, probeTimeout)
        break
      } catch (e) {
        const msg = String(e.message || e)
        if (attempt === 0 && /timeout|disconnected/i.test(msg)) {
          this.log(`PUT ${relPath}: no reply, retrying…`)
          this._clearPendingReply()
          try {
            await this.ensureOpen()
          } catch (_) {
            throw new Error('serial disconnected')
          }
          await sleep(300)
          continue
        }
        throw e
      }
    }
    if (line.startsWith('+OK PUT skip')) return false
    if (!line.startsWith('+OK PUT ready')) {
      if (line.startsWith('-ERR')) throw new Error(line)
      throw new Error(`unexpected PUT reply: ${line}`)
    }
    this.log(`sending ${nbytes} bytes for ${relPath}`)
    this.putActive = true
    try {
      let nextSend = performance.now()
      for (let off = 0; off < data.length; off += PUT_CHUNK) {
        if (!this.writer) throw new Error('serial disconnected')
        const part = data.subarray(off, off + PUT_CHUNK)
        try {
          await this.writer.write(part)
        } catch (e) {
          this._markDisconnected()
          throw new Error(`serial disconnected: ${e.message || e}`)
        }
        nextSend += (part.length / PUT_BPS) * 1000
        const wait = nextSend - performance.now()
        if (wait > 0) await sleep(wait)
      }
      while (true) {
        const doneLine = await this._waitReply(doneTimeout)
        const m = doneLine.trim().match(PUT_DONE_RE)
        if (m && parseInt(m[1], 16) === crc) return true
        if (doneLine.startsWith('-ERR')) throw new Error(doneLine)
        throw new Error(`unexpected PUT reply: ${doneLine}`)
      }
    } finally {
      this.putActive = false
    }
  }
}

export async function requestSerialPort() {
  if (!('serial' in navigator)) throw new Error('Web Serial not supported')
  return navigator.serial.requestPort()
}

export async function openAuthorizedPort() {
  const ports = await navigator.serial.getPorts()
  for (const port of ports) {
    try {
      await ensurePortOpen(port)
      return port
    } catch (_) {
      try { await port.close() } catch (_) {}
    }
  }
  return null
}

export async function waitForAuthorizedPort(timeoutMs = 60000, callbacks = {}) {
  const onLog = callbacks.onLog || (() => {})
  const deadline = Date.now() + timeoutMs
  onLog('waiting for CDC after reboot…')
  while (Date.now() < deadline) {
    const port = await openAuthorizedPort()
    if (port) {
      const client = new EspdSyncClient(port, callbacks)
      try {
        await client.open()
        for (let i = 0; i < 15; i++) {
          try {
            const info = await client.status()
            onLog(`connected: +OK STATUS sdcard=${info.sdcard} internal=${info.internal} mode=${info.mode}`)
            return client
          } catch (_) {
            await sleep(400)
          }
        }
      } catch (_) {}
      await client.close()
    }
    await sleep(500)
  }
  throw new Error(`CDC port not ready within ${timeoutMs / 1000}s — pick the port again`)
}

export async function leaveMscSync(client, callbacks) {
  const onLog = callbacks?.onLog || (() => {})
  onLog('leaving msc_sync (device will reboot)')
  await client.setMode('NORMAL')
  await client.close()
  await sleep(2500)
  return waitForAuthorizedPort(60000, callbacks)
}

export async function ensureMscSyncForWrite(client, callbacks) {
  const onLog = callbacks?.onLog || (() => {})
  let info = client.lastStatus?.startsWith('+OK STATUS')
    ? parseStatus(client.lastStatus)
    : await client.status()

  if (info.mode === 'msc_sync') {
    if (info.internal === 'no') {
      onLog('waiting for /storage mount on device…')
      for (let i = 0; i < 30; i++) {
        info = await client.status()
        if (info.internal === 'yes') break
        await sleep(500)
      }
    }
    if (info.internal !== 'yes') throw new Error('/storage not mounted (msc_sync)')
    return client
  }

  onLog('switching to msc_sync for flash write (device will reboot)')
  await client.setMode('MSC_SYNC')
  await client.close()
  await sleep(2500)
  client = await waitForAuthorizedPort(60000, callbacks)

  for (let attempt = 0; attempt < 60; attempt++) {
    info = await client.status()
    if (info.mode === 'msc_sync' && info.internal === 'yes') return client
    if (info.mode === 'msc_sync' && info.internal === 'no' && (attempt === 0 || attempt % 10 === 0)) {
      onLog('waiting for /storage mount on device…')
    }
    await sleep(500)
  }
  throw new Error(`msc_sync failed: mode=${info.mode} internal=${info.internal}`)
}

export async function prepareForSync(client, callbacks) {
  const onLog = callbacks?.onLog || (() => {})
  let info = await client.status()
  if (info.sdcard === 'yes') {
    if (info.mode === 'msc_sync') {
      onLog('SD card available — using /sdcard')
      return leaveMscSync(client, callbacks)
    }
    return client
  }
  if (info.internal !== 'yes' && info.mode !== 'msc_sync') {
    onLog('no SD card — using /storage on device')
  }
  return ensureMscSyncForWrite(client, callbacks)
}

export async function connectAndPrepare(requestPort, callbacks) {
  const port = await requestPort()
  let client = new EspdSyncClient(port, callbacks)
  await client.open()
  client = await prepareForSync(client, callbacks)
  return client
}

export async function reconnectPrepared(client, callbacks) {
  const info = await client.status()
  if (info.sdcard === 'yes' && info.mode !== 'msc_sync') return client
  if (info.mode === 'msc_sync' && info.internal === 'yes') return client
  return prepareForSync(client, callbacks)
}

export async function syncFileList(client, dirHandle, rels, onLog, reconnect) {
  let reloadNeeded = false
  let resetNeeded = false
  let uploaded = 0
  let skipped = 0
  const t0 = performance.now()

  for (const rel of [...rels].sort((a, b) => {
    const [oa, ra] = syncOrder(a)
    const [ob, rb] = syncOrder(b)
    return oa - ob || ra.localeCompare(rb)
  })) {
    const data = await readFileBytes(dirHandle, rel)
    while (true) {
      try {
        const sent = await client.putFile(rel, data)
        if (sent) {
          uploaded++
          if (rel === 'config.txt') resetNeeded = true
          else if (rel.endsWith('.pd')) reloadNeeded = true
        } else {
          onLog?.(`skip ${rel} (unchanged)`)
          skipped++
        }
        break
      } catch (e) {
        const msg = String(e.message || e)
        if (/timeout|disconnect|closed|break|null/i.test(msg)) {
          onLog?.(`disconnect during PUT ${rel}; reconnecting…`)
          await client.close().catch(() => {})
          client = await reconnect()
          client = await reconnectPrepared(client, { onLog })
          continue
        }
        if (/not mounted|crc/i.test(msg)) {
          onLog?.(`${msg}; reconnecting…`)
          await client.close().catch(() => {})
          client = await reconnect()
          client = await reconnectPrepared(client, { onLog })
          continue
        }
        throw e
      }
    }
  }

  if (resetNeeded) {
    onLog?.('RESET (config.txt applies on boot)')
    try { await client.resetDevice() } catch (_) {}
    await client.close().catch(() => {})
    client = await reconnect()
    client = await reconnectPrepared(client, { onLog })
  } else if (reloadNeeded) {
    onLog?.('RELOAD')
    try { await client.reload() } catch (_) {
      onLog?.('timeout during RELOAD (patch may still reload on device)')
    }
  }

  onLog?.(`sync done in ${((performance.now() - t0) / 1000).toFixed(2)}s (${uploaded} uploaded, ${skipped} unchanged)`)
  return client
}
