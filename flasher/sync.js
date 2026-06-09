/** ESPD CDC dev sync (browser port of espd/scripts/espd_sync.py core). */

const PUT_CHUNK = 4096
const PUT_BPS = 800000
const STATUS_RE = /^\+OK STATUS sdcard=(yes|no) internal=(yes|no)$/
const PUT_DONE_RE = /^\+OK PUT done ([0-9a-fA-F]{8})$/
const LIST_DONE_RE = /^\+OK LIST done (\d+)$/

export function devPathOk(rel) {
  if (!rel || rel.startsWith('/') || rel.includes('\\')) return false
  if (rel.split('/').some(p => !p || p.startsWith('.') || p.includes('..'))) return false
  if (rel.length >= 384) return false
  if (!/^[\x20-\x7e]+$/.test(rel)) return false
  return true
}

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
  return { sdcard: m[1], internal: m[2] }
}

export function syncStorePath(info) {
  return info.sdcard === 'yes' ? '/sdcard' : '/storage'
}

function syncNameOk(name) {
  if (!name || name.startsWith('.')) return false
  const low = name.toLowerCase()
  if (name === 'config.txt') return true
  if (PATCH_SUFFIXES.some(s => low.endsWith(s))) return true
  return ASSET_SUFFIXES.some(s => low.endsWith(s))
}

export async function collectSyncFiles(dirHandle, prefix = '') {
  const out = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue
    const rel = prefix + name
    if (handle.kind === 'file') {
      if (syncNameOk(name)) out.push(rel)
    } else if (handle.kind === 'directory') {
      out.push(...await collectSyncFiles(handle, rel + '/'))
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

export async function collectSyncMtimes(dirHandle, prefix = '') {
  const out = new Map()
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith('.')) continue
    const rel = prefix + name
    if (handle.kind === 'file') {
      if (syncNameOk(name)) {
        const file = await handle.getFile()
        out.set(rel, file.lastModified)
      }
    } else if (handle.kind === 'directory') {
      for (const [k, v] of await collectSyncMtimes(handle, rel + '/')) out.set(k, v)
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
      try { await port.close() } catch (_) { }
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
    this.onLine = onLine || (() => { })
    this.onLog = onLog || (() => { })
    this.onDisconnect = onDisconnect || (() => { })
    this.reader = null
    this.writer = null
    this.stopped = false
    this.disconnected = false
    this.putActive = false
    this.listActive = false
    this.listPaths = []
    this.pendingReply = null
    this.lastStatus = null
    this._buf = ''
  }

  log(msg) {
    this.onLog(msg)
  }

  async open() {
    await ensurePortOpen(this.port)
    if (this.reader) {
      try { await this.reader.cancel() } catch (_) { }
      try { this.reader.releaseLock() } catch (_) { }
      this.reader = null
    }
    if (this.writer) {
      try { await this.writer.close() } catch (_) { }
      try { this.writer.releaseLock?.() } catch (_) { }
      this.writer = null
    }
    this.writer = this.port.writable.getWriter()
    this.reader = this.port.readable.getReader()
    this.stopped = false
    this.disconnected = false
    this._readLoopPromise = this._readLoop()
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
    if (this.reader) {
      try { await this.reader.cancel() } catch (_) { }
    }
    if (this._readLoopPromise) {
      try { await this._readLoopPromise } catch (_) { }
      this._readLoopPromise = null
    }
    if (this.reader) {
      try { this.reader.releaseLock() } catch (_) { }
      this.reader = null
    }
    if (this.writer) {
      try { await this.writer.close() } catch (_) { }
      try { this.writer.releaseLock?.() } catch (_) { }
      this.writer = null
    }
    try { await this.port.close() } catch (_) { }
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
          if (this.listActive) {
            if (line.startsWith('+FILE ')) {
              const rel = line.slice(6)
              if (devPathOk(rel)) this.listPaths.push(rel)
              else this.onLog?.(`warning: ignore device path ${JSON.stringify(rel)}`)
              this.onLine(line, 'dev')
              continue
            }
            if (line.startsWith('+OK LIST done') || line.startsWith('-ERR')) {
              this.onLine(line, 'dev')
              this._resolveReply(line)
            } else if (line.startsWith('+OK LIST')) {
              this.onLine(line, 'dev')
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

  async status(timeoutMs = 10000) {
    const line = await this.command('STATUS', timeoutMs)
    if (line.startsWith('+OK STATUS')) {
      this.lastStatus = line
      return parseStatus(line)
    }
    throw new Error(line)
  }

  deviceStatus(timeoutMs = 10000) {
    if (this.lastStatus?.startsWith('+OK STATUS')) return parseStatus(this.lastStatus)
    return this.status(timeoutMs)
  }



  async reload() {
    await this.command('RELOAD', 30000)
  }

  async resetDevice() {
    try {
      await this.command('RESET', 2000)
    } catch (_) { }
  }

  async sendPd(message) {
    const msg = message.trim()
    if (!msg) throw new Error('empty Pd message')
    const line = await this.command(`MSG ${msg}`, 5000)
    if (line.startsWith('-ERR')) throw new Error(line)
    return line
  }

  async listFiles(timeoutMs = 120000) {
    await this.ensureOpen()
    if (!this.writer) throw new Error('serial disconnected')
    this._clearPendingReply()
    this.listPaths = []
    this.listActive = true
    try {
      this.log('→ LIST')
      await this.writer.write(new TextEncoder().encode('LIST\n'))
      const line = await this._waitReply(timeoutMs)
      if (line.startsWith('-ERR')) throw new Error(line)
      const m = line.trim().match(LIST_DONE_RE)
      if (!m) throw new Error(`unexpected LIST reply: ${line}`)
      return [...this.listPaths]
    } finally {
      this.listActive = false
    }
  }

  async rmFile(relPath, timeoutMs = 10000) {
    const line = await this.command(`RM ${relPath}`, timeoutMs)
    if (line.startsWith('-ERR')) throw new Error(line)
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

export async function writeSerialCommand(port, command) {
  if (!port?.writable) return
  const line = command.endsWith('\n') ? command : `${command}\n`
  const writer = port.writable.getWriter()
  try {
    await writer.write(new TextEncoder().encode(line))
  } finally {
    writer.releaseLock()
  }
}

export async function resetSerialPort(port) {
  return writeSerialCommand(port, 'RESET')
}

export async function requestSerialPort() {
  if (!('serial' in navigator)) throw new Error('Web Serial not supported')
  return navigator.serial.requestPort()
}

async function openPortFresh(port, timeoutMs, isAlive = () => true) {
  if (!isAlive()) throw new Error('aborted')
  try { await port.close() } catch (_) { }
  await sleep(300)
  if (!isAlive()) throw new Error('aborted')
  let timer
  const abortWait = (async () => {
    while (isAlive()) await sleep(100)
    throw new Error('aborted')
  })()
  try {
    await Promise.race([
      port.open({ baudRate: 115200 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('open timeout')), timeoutMs)
      }),
      abortWait,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function openAuthorizedPort(timeoutMs = 3000, isAlive = () => true, preferred = null) {
  const ports = await navigator.serial.getPorts()
  // Try the freshly (re)connected port first. After a RESET the device
  // re-enumerates and the 'connect' event hands us the exact new port; opening
  // it immediately avoids burning the open timeout on the dead pre-reboot handle
  // (the "stuck for seconds … waiting for CDC after reboot" stall).
  const ordered = (preferred && ports.includes(preferred))
    ? [preferred, ...ports.filter(p => p !== preferred)]
    : ports
  for (const port of ordered) {
    try {
      // Force a clean close+reopen: after a USB reboot Chrome reuses the same
      // SerialPort object with stale (dead) readable/writable handles, so the
      // lenient ensurePortOpen() would "succeed" onto a dead stream and STATUS
      // would never reply (stuck at "waiting for CDC after reboot…").
      // openPortFresh() discards the stale streams.
      await openPortFresh(port, timeoutMs, isAlive)
      return port
    } catch (e) {
      if (String(e.message || e) === 'aborted') throw e
      try { await port.close() } catch (_) { }
    }
  }
  return null
}

export async function waitForAuthorizedPort(timeoutMs = 60000, callbacks = {}) {
  const onLog = callbacks.onLog || (() => { })
  const isAlive = callbacks.isAlive || (() => true)
  const deadline = Date.now() + timeoutMs
  let wake = null
  let justConnected = null
  const onConnect = (e) => { justConnected = e?.target || null; wake?.() }
  if (typeof navigator !== 'undefined' && navigator.serial?.addEventListener) {
    navigator.serial.addEventListener('connect', onConnect)
  }
  onLog('waiting for CDC after reboot…')
  try {
    while (Date.now() < deadline) {
      if (!isAlive()) throw new Error('aborted')
      const port = await openAuthorizedPort(2000, isAlive, justConnected)
      if (port) {
        if (!isAlive()) {
          try { await port.close() } catch (_) { }
          throw new Error('aborted')
        }
        const client = new EspdSyncClient(port, callbacks)
        try {
          await client.open()
          // Only a few STATUS tries per open: after a RESET the device
          // re-enumerates and this open may have landed on stale/dead CDC
          // streams. Bail quickly so the outer loop re-opens FRESH streams (via
          // openPortFresh) rather than burning ~35s retrying on dead ones.
          for (let i = 0; i < 4; i++) {
            if (!isAlive()) {
              await client.close()
              throw new Error('aborted')
            }
            try {
              const info = await client.status(1200)
              onLog(`connected: +OK STATUS sdcard=${info.sdcard} internal=${info.internal}`)
              return client
            } catch (_) { }
          }
        } catch (e) {
          if (e.message === 'aborted') throw e
        }
        await client.close()
        // This port opened but never answered STATUS -> it's a dead/stale grant
        // left over from an earlier USB re-enumeration. Chrome keeps every such
        // grant per-origin, so over time getPorts() accumulates many corpses and
        // openAuthorizedPort can commit to one (opens fine, no bytes ever flow:
        // no bangs, no STATUS reply). Forget it so the list converges on the one
        // live port. Guard on >1 so a healthy sole port is never stranded.
        if ((await navigator.serial.getPorts()).length > 1) {
          onLog('dropping stale serial port')
          try { await port.forget?.() } catch (_) { }
        }
      }
      await Promise.race([
        sleep(200),
        new Promise(resolve => { wake = resolve }),
      ])
      wake = null
    }
    throw new Error(`CDC port not ready within ${timeoutMs / 1000}s — pick the port again`)
  } finally {
    if (typeof navigator !== 'undefined' && navigator.serial?.removeEventListener) {
      navigator.serial.removeEventListener('connect', onConnect)
    }
  }
}

export async function waitForStorageReady(client, onLog, maxSec = 45) {
  const deadline = Date.now() + maxSec * 1000
  let first = true
  while (Date.now() < deadline) {
    const info = first ? await client.deviceStatus(1500) : await client.status(1500)
    first = false
    if (info.internal === 'yes') return info
    onLog('waiting for /storage on device…')
    await sleep(500)
  }
  throw new Error('/storage not ready on device (boot still in progress?)')
}

export async function ensureStorageForWrite(client, callbacks) {
  const onLog = callbacks?.onLog || (() => { })

  /* Device is in drive mode (internal flash owned by the host USB volume). A
   * software RESET reboots straight back into Pd mode with /storage owned by the
   * app, so PUT works; the CDC link drops and we reconnect to the re-enumerated
   * port. */
  onLog('internal storage in drive mode -- resetting device')
  await client.resetDevice()
  await client.close()
  client = await waitForAuthorizedPort(60000, callbacks)
  const info = await waitForStorageReady(client, onLog)
  if (info.internal !== 'yes') {
    throw new Error(`/storage still not available after reset (internal=${info.internal})`)
  }
  return client
}

export async function prepareForSync(client, callbacks) {
  const onLog = callbacks?.onLog || (() => { })
  if (callbacks?.setReconnecting) callbacks.setReconnecting(true)
  try {
    let info = await client.deviceStatus()
    if (info.sdcard === 'yes') {
      onLog('SD card available -- using /sdcard')
      return client
    }
    if (info.internal === 'yes') return client
    return ensureStorageForWrite(client, callbacks)
  } finally {
    if (callbacks?.setReconnecting) callbacks.setReconnecting(false)
  }
}

export async function connectAndPrepare(requestPort, callbacks) {
  const port = await requestPort()
  if (!port) throw new Error('no serial port')
  let client = new EspdSyncClient(port, callbacks)
  await client.open()
  client = await prepareForSync(client, callbacks)
  return client
}


export async function mirrorPrune(client, keep, onLog, reconnect) {
  const keepSet = new Set(keep)
  let onDevice
  while (true) {
    try {
      onDevice = await client.listFiles()
      break
    } catch (e) {
      const msg = String(e.message || e)
      if (/timeout|disconnect|closed|break|null|not mounted/i.test(msg)) {
        onLog?.(`${msg}; reconnecting…`)
        await client.close().catch(() => { })
        client = await reconnect()
        client = await prepareForSync(client, { onLog })
        continue
      }
      throw e
    }
  }
  const orphans = onDevice.filter(p => !keepSet.has(p) && devPathOk(p)).sort()
  for (const rel of onDevice.filter(p => !keepSet.has(p) && !devPathOk(p))) {
    onLog?.(`warning: cannot mirror-remove invalid device path ${JSON.stringify(rel)}`)
  }
  if (!orphans.length) return client
  onLog?.(`mirror: removing ${orphans.length} file(s) not in project`)
  for (const rel of orphans) {
    while (true) {
      try {
        onLog?.(`remove ${rel}`)
        await client.rmFile(rel)
        break
      } catch (e) {
        const msg = String(e.message || e)
        if (/timeout|disconnect|closed|break|null|not mounted/i.test(msg)) {
          onLog?.(`${msg}; reconnecting…`)
          await client.close().catch(() => { })
          client = await reconnect()
          client = await prepareForSync(client, { onLog })
          continue
        }
        if (/not found|bad path/i.test(msg)) {
          onLog?.(`skip ${rel} (${msg.trim()})`)
          break
        }
        throw e
      }
    }
  }
  return client
}

export async function syncFileList(client, dirHandle, rels, onLog, reconnect, { mirror = true } = {}) {
  let reloadNeeded = false
  let resetNeeded = false
  let uploaded = 0
  let skipped = 0
  const t0 = performance.now()

  if (mirror) {
    client = await mirrorPrune(client, rels, onLog, reconnect)
  }

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
          // config.txt is only read at boot, so it needs a RESET; any other file
          // (patch or asset) just needs main.pd reloaded to pick up the change.
          if (rel === 'config.txt') resetNeeded = true
          else reloadNeeded = true
        } else {
          onLog?.(`skip ${rel} (unchanged)`)
          skipped++
        }
        break
      } catch (e) {
        const msg = String(e.message || e)
        if (/timeout|disconnect|closed|break|null|not mounted|crc/i.test(msg)) {
          onLog?.(`${msg}; reconnecting…`)
          await client.close().catch(() => { })
          client = await reconnect()
          client = await prepareForSync(client, { onLog })
          continue
        }
        throw e
      }
    }
  }

  if (resetNeeded) {
    onLog?.('RESET (config.txt applies on boot)')
    try { await client.resetDevice() } catch (_) { }
    await client.close().catch(() => { })
    client = await reconnect()
    client = await prepareForSync(client, { onLog })
  } else if (reloadNeeded) {
    onLog?.('RELOAD')
    try { await client.reload() } catch (_) {
      onLog?.('timeout during RELOAD (patch may still reload on device)')
    }
  }

  onLog?.(`sync done in ${((performance.now() - t0) / 1000).toFixed(2)}s (${uploaded} uploaded, ${skipped} unchanged)`)
  return client
}
