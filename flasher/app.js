import { ESPLoader, Transport } from 'https://cdn.jsdelivr.net/npm/esptool-js@0.5.4/bundle.js'
import {
  collectSyncFiles,
  collectSyncMtimes,
  connectAndPrepare,
  reconnectPrepared,
  requestSerialPort,
  sleep,
  syncFileList,
  syncStorePath,
  waitForAuthorizedPort,
} from './sync.js'

const REPO = 'ben-wes/espd-kits'

let boards = []
let selectedBoardId = null
let releaseManifests = new Map()
let githubReleases = []
let useLocal = false
let localFile = null
let localOffset = '0x10000'
let eraseFirst = false
let flashing = false
let flashLog = []
let showLog = false
let monPort = null
let monReader = null
let monBuf = ''
let monFollowLog = true
let monExpanded = false

let syncDirHandle = null
let syncClient = null
let syncBusy = false
let syncObserver = null
let syncDebounceTimer = null
let syncPollTimer = null
let syncMtimes = new Map()
let syncWatchPaused = false
let syncReconnecting = false

function syncLog(msg) {
  appendLine(`[sync] ${msg}`)
}

function syncCallbacks() {
  return {
    onLog: syncLog,
    onDisconnect: onSyncDisconnect,
    onLine(line, kind) {
      if (kind === 'device') appendLine(line)
      else syncLog(line)
    },
  }
}

function onSyncDisconnect() {
  if (syncReconnecting || syncBusy) return
  syncLog('device disconnected')
  if (syncClient) {
    syncClient.close().catch(() => {})
    syncClient = null
  }
  stopSyncWatch()
  setSyncUi(false)
  $('sync-status').textContent = 'Disconnected — Connect & sync again'
}

function stopSyncWatch() {
  if (syncObserver) {
    try { syncObserver.disconnect() } catch (_) {}
    syncObserver = null
  }
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer)
    syncDebounceTimer = null
  }
  if (syncPollTimer) {
    clearInterval(syncPollTimer)
    syncPollTimer = null
  }
}

async function refreshSyncMtimes() {
  if (!syncDirHandle) return
  const includeAssets = $('sync-assets').checked
  syncMtimes = await collectSyncMtimes(syncDirHandle, includeAssets)
}

async function collectChangedRels() {
  if (!syncDirHandle) return []
  const includeAssets = $('sync-assets').checked
  const current = await collectSyncMtimes(syncDirHandle, includeAssets)
  const changed = []
  for (const [rel, mtime] of current) {
    if (syncMtimes.get(rel) !== mtime) changed.push(rel)
  }
  return changed
}

function setWatchingStatus() {
  if (!syncClient) return
  const n = syncMtimes.size
  $('sync-status').textContent = syncObserver || syncPollTimer
    ? `Watching ${n} file${n === 1 ? '' : 's'} for changes`
    : `Connected · use Sync now after saves`
}

async function reconnectSync() {
  syncReconnecting = true
  const cb = syncCallbacks()
  try {
    let client = await waitForAuthorizedPort(60000, cb)
    return await reconnectPrepared(client, cb)
  } catch (_) {
    syncLog('Pick the USB port again (reboot / re-enumeration)')
    return connectAndPrepare(requestSerialPort, cb)
  } finally {
    syncReconnecting = false
  }
}

function setSyncUi(connected) {
  show($('sync-start-btn'), syncDirHandle && !connected)
  show($('sync-now-btn'), connected)
  show($('sync-stop-btn'), connected)
  show($('sync-assets-row'), !!syncDirHandle)
  show($('mon-connect-btn'), !connected && !monPort)
  $('sync-start-btn').disabled = syncBusy
  $('sync-now-btn').disabled = syncBusy
}

async function stopSync() {
  stopSyncWatch()
  if (syncClient) {
    await syncClient.close().catch(() => {})
    syncClient = null
  }
  syncMtimes.clear()
  syncBusy = false
  setSyncUi(false)
  $('sync-status').textContent = syncDirHandle ? 'Stopped' : ''
  setMonitorExpanded(false)
  showMonitorDisconnected()
}

async function runSync(label, onlyRels = null) {
  if (!syncDirHandle || !syncClient || syncBusy) return
  syncBusy = true
  syncWatchPaused = true
  stopSyncWatch()
  setSyncUi(true)
  $('sync-status').textContent = 'Syncing…'
  try {
    const includeAssets = $('sync-assets').checked
    let rels = onlyRels
    if (!rels) rels = await collectSyncFiles(syncDirHandle, includeAssets)
    if (!rels.length) {
      if (label !== 'watch') syncLog(`${label}: nothing to send`)
      return
    }
    syncLog(`${label} (${rels.length} file${rels.length === 1 ? '' : 's'})`)
    syncClient = await syncFileList(
      syncClient,
      syncDirHandle,
      rels,
      syncLog,
      reconnectSync,
    )
    await refreshSyncMtimes()
    if (syncClient) await syncClient.status().catch(() => {})
    setWatchingStatus()
  } catch (e) {
    syncLog(`error: ${e.message || e}`)
    if (!syncClient) $('sync-status').textContent = 'Disconnected — Connect & sync again'
  } finally {
    syncBusy = false
    syncWatchPaused = false
    setSyncUi(!!syncClient)
    if (syncClient) resumeSyncWatch()
  }
}

async function resumeSyncWatch() {
  if (!syncDirHandle || !syncClient) return
  if ('FileSystemObserver' in window) {
    if (!syncObserver) await startFileObserver()
  } else if (!syncPollTimer) {
    startSyncPoll()
  }
  setWatchingStatus()
}

async function startFileObserver() {
  if (syncObserver) return
  syncObserver = new FileSystemObserver(() => {
    if (syncWatchPaused || syncBusy || !syncClient) return
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer)
    syncDebounceTimer = setTimeout(async () => {
      const changed = await collectChangedRels()
      if (!changed.length || syncBusy || !syncClient) return
      await runSync('watch', changed)
    }, 350)
  })
  await syncObserver.observe(syncDirHandle, { recursive: true })
  show($('sync-watch-hint'), false)
}

function startSyncPoll() {
  show($('sync-watch-hint'), true)
  $('sync-watch-hint').textContent = 'Polling folder every 1.5s for changes (FileSystemObserver unavailable).'
  syncPollTimer = setInterval(async () => {
    if (syncWatchPaused || syncBusy || !syncClient) return
    const changed = await collectChangedRels()
    if (!changed.length) return
    await runSync('watch', changed)
  }, 1500)
}

async function startSyncWatch() {
  if (!syncDirHandle || !syncClient) return
  await refreshSyncMtimes()
  if ('FileSystemObserver' in window) {
    await startFileObserver()
  } else {
    startSyncPoll()
  }
  setWatchingStatus()
}

async function startPatchSync() {
  if (!syncDirHandle || syncBusy) return
  await stopSync()
  if (monPort) await closeMonitor()
  syncBusy = true
  setSyncUi(true)
  showSyncLogPanel()
  monFollowLog = true
  $('sync-status').textContent = 'Connecting…'
  try {
    syncLog('connecting…')
    syncClient = await connectAndPrepare(requestSerialPort, syncCallbacks())
    const info = await syncClient.status()
    $('sync-status').textContent = `Connected · target ${syncStorePath(info)}`
    syncBusy = false
    await runSync('initial sync')
  } catch (e) {
    syncLog(`connect failed: ${e.message || e}`)
    await stopSync()
  } finally {
    syncBusy = false
    setSyncUi(!!syncClient)
  }
}

function setMonitorExpanded(on) {
  monExpanded = on
  $('monitor-wrap').classList.toggle('mon-expanded', on)
  show($('mon-fs-controls'), on)
  $('mon-expand-btn').textContent = on ? 'Collapse' : 'Expand log'
  document.body.classList.toggle('overflow-hidden', on)
  if (monFollowLog) scrollMonitorToEnd()
}

function toggleMonitorExpanded() {
  setMonitorExpanded(!monExpanded)
}

const $ = id => document.getElementById(id)
const show = (el, on) => { el.classList.toggle('hidden', !on) }

function releaseDownloadBase(tag) {
  return `https://github.com/${REPO}/releases/download/${tag}`
}

async function loadBoardsForRelease(tag) {
  selectedBoardId = null
  boards = []
  if (!tag) {
    renderBoards()
    return
  }
  const manifest = await loadReleaseManifest(tag)
  boards = manifest?.boards || []
  if (boards.length === 1) selectedBoardId = boards[0].id
  renderBoards()
}

function renderBoards() {
  const grid = $('board-grid')
  const hint = $('board-hint')
  const none = $('board-none')
  grid.innerHTML = ''

  if (useLocal) {
    show(hint, false)
    show(none, false)
    return
  }

  const tag = $('release-select').value
  if (!tag) {
    show(hint, true)
    show(none, false)
    return
  }
  show(hint, false)

  if (!boards.length) {
    show(none, true)
    none.textContent = releaseManifests.get(tag) === null
      ? 'Release firmware not mirrored on this site yet — wait for Pages to redeploy after the release.'
      : 'No boards in this release.'
    return
  }
  show(none, false)

  for (const b of boards) {
    const selected = b.id === selectedBoardId
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'w-full border px-4 py-3 text-left transition ' +
      (selected
        ? 'border-black bg-black text-white'
        : 'border-neutral-300 bg-white text-black hover:border-neutral-500')
    btn.innerHTML =
      `<p class="text-sm font-bold">${b.name}</p>` +
      `<p class="mt-1 text-xs ${selected ? 'text-neutral-300' : 'text-neutral-500'}">${b.chip || b.target}${b.description ? ' · ' + b.description : ''}</p>`
    btn.addEventListener('click', () => {
      selectedBoardId = b.id
      renderBoards()
      render()
    })
    grid.appendChild(btn)
  }
}

async function loadReleaseManifest(tag) {
  if (releaseManifests.has(tag)) return releaseManifests.get(tag)
  try {
    const res = await fetch(`manifests/releases/${encodeURIComponent(tag)}.json`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    releaseManifests.set(tag, data)
    return data
  } catch {
    releaseManifests.set(tag, null)
    return null
  }
}

function filesForBoardRelease(manifest, boardId, tag) {
  const entry = (manifest?.boards || []).find(b => b.id === boardId)
  if (entry?.files) {
    return Object.entries(entry.files).map(([name, f]) => ({
      name,
      url: f.url,
      offset: f.offset,
    }))
  }
  const base = releaseDownloadBase(tag)
  return [
    { name: 'bootloader', url: `${base}/${boardId}-bootloader.bin`, offset: 0 },
    { name: 'partition_table', url: `${base}/${boardId}-partition-table.bin`, offset: 0x8000 },
    { name: 'app', url: `${base}/${boardId}-espd.bin`, offset: 0x10000 },
  ]
}

async function fetchGithubReleases() {
  show($('fw-loading'), true)
  show($('fw-none'), false)
  show($('release-select'), false)
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    githubReleases = (await res.json()).filter(r => !r.draft)
  } catch {
    githubReleases = []
  }
  await renderFirmwareOptions()
  render()
}

function stableReleases() {
  return githubReleases.filter(r => !r.prerelease)
}

async function renderFirmwareOptions() {
  show($('fw-loading'), false)
  const releases = stableReleases()
  if (!releases.length) {
    show($('fw-none'), true)
    show($('release-select'), false)
    await loadBoardsForRelease('')
    return
  }
  const sel = $('release-select')
  show(sel, true)
  show($('fw-none'), false)
  const prev = sel.value
  while (sel.children.length > 1) sel.removeChild(sel.lastChild)
  for (const r of releases) {
    const o = document.createElement('option')
    o.value = r.tag_name
    o.textContent = r.name || r.tag_name
    sel.appendChild(o)
  }
  const latest = releases[0].tag_name
  if (prev && releases.some(r => r.tag_name === prev)) sel.value = prev
  else sel.value = latest
  await loadBoardsForRelease(sel.value)
}

function fwReady() {
  if (useLocal) return !!localFile
  const tag = $('release-select').value
  return !!(tag && selectedBoardId)
}

function stepState(n) {
  if (useLocal) {
    if (n === 1) return localFile ? 'done' : 'active'
    if (n === 2) return localFile ? 'done' : 'locked'
    if (n === 3) return localFile ? 'active' : 'locked'
    return 'locked'
  }
  if (n === 1) {
    if (!stableReleases().length) return 'locked'
    return $('release-select').value ? 'done' : 'active'
  }
  if (n === 2) {
    if (!$('release-select').value) return 'locked'
    return selectedBoardId ? 'done' : 'active'
  }
  if (n === 3) return fwReady() ? 'active' : 'locked'
  return 'locked'
}

const TICK = '<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
const badgeBase = 'relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 bg-white text-[11px] font-bold'
const badgeStates = {
  active: 'border-red-500 text-red-500',
  done: 'border-red-500 bg-red-500 text-white',
  locked: 'border-neutral-300 text-neutral-300',
}
const stepBaseMid = 'relative flex gap-5 pb-12'
const stepBaseLast = 'relative flex gap-5 pb-0'
const stepLockedMid = stepBaseMid + ' opacity-30 pointer-events-none select-none'
const stepLockedLast = stepBaseLast + ' opacity-30 pointer-events-none select-none'

function setBadge(el, state, num) {
  el.className = badgeBase + ' ' + badgeStates[state]
  el.innerHTML = state === 'done' ? TICK : String(num)
}

function render() {
  const s1 = stepState(1), s2 = stepState(2), s3 = stepState(3)
  setBadge($('badge1'), s1, 1)
  setBadge($('badge2'), s2, 2)
  setBadge($('badge3'), s3, 3)
  $('step2').className = s2 === 'locked' ? stepLockedMid : stepBaseMid
  show($('step2'), !useLocal)
  $('step3').className = s3 === 'locked' ? stepLockedLast : stepBaseLast

  const ready = fwReady()
  show($('flash-ready'), ready)
  show($('flash-incomplete'), !ready)

  const box = $('erase-box')
  box.className = 'flex h-4 w-4 shrink-0 items-center justify-center border transition ' +
    (eraseFirst ? 'border-black bg-black text-white' : 'border-neutral-400 bg-white')
  box.innerHTML = eraseFirst
    ? '<svg class="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="square" stroke-linejoin="miter" d="M5 13l4 4L19 7"/></svg>'
    : ''
}

const tabOn = 'px-5 py-2.5 text-xs font-bold uppercase tracking-wider bg-black text-white'
const tabOff = 'px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-neutral-500 hover:text-black'

function setTab(local) {
  useLocal = local
  $('tab-release').className = local ? tabOff : tabOn
  $('tab-local').className = local ? tabOn : tabOff
  show($('fw-release-panel'), !local)
  show($('fw-local-panel'), local)
  if (local) {
    selectedBoardId = null
    boards = []
  } else {
    loadBoardsForRelease($('release-select').value).then(render)
  }
  renderBoards()
  render()
}

$('tab-release').addEventListener('click', () => setTab(false))
$('tab-local').addEventListener('click', () => setTab(true))
$('release-select').addEventListener('change', async () => {
  await loadBoardsForRelease($('release-select').value)
  render()
})
$('erase-row').addEventListener('click', () => { eraseFirst = !eraseFirst; render() })
$('local-file').addEventListener('change', e => { localFile = e.target.files?.[0] ?? null; render() })
$('local-offset').addEventListener('input', e => { localOffset = e.target.value })

function readAsBinaryString(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('FileReader error'))
    r.readAsBinaryString(blob)
  })
}

const PHASE_LABELS = {
  connecting: 'Connecting', initializing: 'Initializing', preparing: 'Preparing',
  erasing: 'Erasing', writing: 'Writing', finished: 'Done', error: 'Error',
}

function renderProgress(phase, msg, pct) {
  const isErr = phase === 'error'
  const isDone = phase === 'finished'
  const dotCls = isErr ? 'bg-red-500' : isDone ? 'bg-green-600' : 'bg-red-500 animate-pulse'
  const label = PHASE_LABELS[phase] ?? phase
  const barHtml = pct !== null
    ? `<div class="mb-2 h-1.5 w-full overflow-hidden bg-neutral-200"><div class="h-full transition-all ${isDone ? 'bg-green-600' : 'bg-red-500'}" style="width:${pct}%"></div></div>`
    : ''
  const pctHtml = pct !== null
    ? `<span class="font-mono text-sm font-bold ${isErr ? 'text-red-500' : 'text-black'}">${pct}%</span>`
    : ''
  const logBtn = flashLog.length
    ? `<button type="button" class="shrink-0 text-[10px] font-bold uppercase tracking-wider text-neutral-400 hover:text-black" id="log-toggle-btn">${showLog ? 'Log ▲' : 'Log ▼'}</button>`
    : ''
  const logHtml = showLog
    ? `<div class="mt-2 max-h-40 overflow-y-auto border border-neutral-200 bg-neutral-50 p-3 font-mono text-[10px] leading-relaxed">${flashLog.map(l => `<div class="${logLineClass(l)}">${escapeHtml(l)}</div>`).join('')}</div>`
    : ''
  $('flash-progress').innerHTML =
    `<div class="mb-2 flex items-center justify-between gap-4"><div class="flex items-center gap-2"><span class="h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}"></span><span class="text-xs font-bold uppercase tracking-wider ${isErr ? 'text-red-500' : 'text-neutral-700'}">${label}</span></div>${pctHtml}</div>` +
    barHtml +
    `<div class="flex items-center gap-3"><p class="flex-1 text-xs text-neutral-500">${msg}</p>${logBtn}</div>` +
    logHtml
  const lt = $('log-toggle-btn')
  if (lt) lt.addEventListener('click', () => { showLog = !showLog; renderProgress(phase, msg, pct) })
}

async function loadReleaseImages(tag, boardId, log) {
  const manifest = await loadReleaseManifest(tag)
  const specs = filesForBoardRelease(manifest, boardId, tag)
  const fileArray = []
  let totalSize = 0
  for (const spec of specs) {
    log('Loading ' + spec.url)
    const resp = await fetch(spec.url)
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + spec.name)
    const data = await readAsBinaryString(await resp.blob())
    fileArray.push({ data, address: spec.offset })
    totalSize += data.length
    log(spec.name + ' @ 0x' + spec.offset.toString(16) + ' (' + Math.round(data.length / 1024) + ' KB)')
  }
  return { fileArray, totalSize }
}

$('flash-btn').addEventListener('click', async () => {
  if (flashing) return
  flashing = true; flashLog = []; showLog = false
  show($('flash-progress'), true)
  $('flash-btn').disabled = true
  $('flash-label').textContent = 'Flashing…'

  const log = msg => flashLog.push(msg)
  let eraseTimer = null

  renderProgress('connecting', 'Connecting…', null)
  log('Connecting…')
  try {
    const port = await navigator.serial.requestPort()
    const transport = new Transport(port)
    const esp = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, enableTracing: false })

    renderProgress('initializing', 'Initializing…', null)
    await esp.main()
    log('Chip: ' + esp.chip.CHIP_NAME)

    renderProgress('preparing', 'Loading firmware…', null)
    let fileArray, totalSize

    if (useLocal && localFile) {
      const data = await readAsBinaryString(localFile)
      const offset = parseInt(localOffset, 16) || 0
      fileArray = [{ data, address: offset }]
      totalSize = data.length
      log('Local file: ' + localFile.name + ' @ 0x' + offset.toString(16))
    } else {
      const tag = $('release-select').value
      if (!tag) throw new Error('No release selected')
      if (!selectedBoardId) throw new Error('No board selected')
      ;({ fileArray, totalSize } = await loadReleaseImages(tag, selectedBoardId, log))
    }

    if (eraseFirst) {
      renderProgress('erasing', 'Erasing flash…', 0)
      log('Erasing flash…')
      const t0 = Date.now()
      eraseTimer = setInterval(() => {
        renderProgress('erasing', 'Erasing flash…', Math.min(90, Math.round((Date.now() - t0) / 180)))
      }, 200)
      await esp.eraseFlash()
      clearInterval(eraseTimer); eraseTimer = null
      log('Flash erased')
    }

    let totalWritten = 0
    await esp.writeFlash({
      fileArray,
      flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
      eraseAll: false, compress: true,
      reportProgress(fileIndex, written, total) {
        const uncomp = (written / total) * fileArray[fileIndex].data.length
        const pct = Math.floor(((totalWritten + uncomp) / totalSize) * 100)
        if (written === total) { totalWritten += fileArray[fileIndex].data.length; return }
        renderProgress('writing', 'Writing: ' + pct + '%', pct)
      },
    })

    try { await transport.disconnect() } catch (_) {}
    try { await transport.setRTS(true); await new Promise(r => setTimeout(r, 100)); await transport.setRTS(false) } catch (_) {}

    renderProgress('finished', 'Firmware flashed — press RESET to start', 100)
    log('Done ✓')
  } catch (err) {
    if (eraseTimer) { clearInterval(eraseTimer); eraseTimer = null }
    const msg = err?.message ?? String(err)
    renderProgress('error', 'Error: ' + msg, null)
    log('ERROR: ' + msg)
  } finally {
    flashing = false
    $('flash-btn').disabled = false
    $('flash-label').textContent = 'Flash firmware'
  }
})

function showSyncLogPanel() {
  show($('monitor-wrap'), true)
  show($('mon-clear-btn'), true)
  show($('mon-expand-btn'), true)
  show($('monitor-cursor'), true)
  show($('mon-connect-btn'), false)
  show($('mon-disc-btn'), false)
}

function showMonitorConnected() {
  if (syncClient) return
  show($('mon-connect-btn'), false)
  show($('mon-disc-btn'), true)
  show($('mon-status'), true)
  show($('mon-clear-btn'), true)
  show($('mon-expand-btn'), true)
  show($('monitor-wrap'), true)
  show($('monitor-cursor'), true)
  monFollowLog = true
  show($('mon-scroll-end'), false)
}

function showMonitorDisconnected() {
  setMonitorExpanded(false)
  show($('mon-connect-btn'), true)
  show($('mon-disc-btn'), false)
  show($('mon-status'), false)
  show($('mon-clear-btn'), false)
  show($('mon-expand-btn'), false)
  show($('monitor-wrap'), false)
  show($('monitor-cursor'), false)
  show($('mon-scroll-end'), false)
  monFollowLog = true
}

function isMonitorAtBottom() {
  const el = $('monitor-term')
  return el.scrollHeight - el.scrollTop - el.clientHeight < 12
}

function scrollMonitorToEnd() {
  const el = $('monitor-term')
  el.scrollTop = el.scrollHeight
  monFollowLog = true
  show($('mon-scroll-end'), false)
}

async function closeMonitor() {
  if (syncClient) {
    await stopSync()
    return
  }
  const port = monPort
  const reader = monReader
  monPort = null
  monReader = null
  monBuf = ''
  if (reader) {
    try { await reader.cancel() } catch (_) {}
    try { reader.releaseLock() } catch (_) {}
  }
  if (port) {
    try { await port.close() } catch (_) {}
  }
  showMonitorDisconnected()
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ANSI_RE = /\x1b\[[0-9;]*m/g
const ESP_LOG_RE = /^[IWEDV] \([^)]+\) [^:\n]+: /

function stripAnsi(s) {
  return s.replace(ANSI_RE, '')
}

/** Line kind — mirrors espd/scripts/espd_sync.py classify_line(). */
function classifyLine(text) {
  const line = stripAnsi(text)
  if (line.startsWith('-ERR')) return 'dev-err'
  if (line.startsWith('+')) return 'dev-ok'
  if (line.startsWith('RELOAD done:') || line.startsWith('RELOAD failed:')) return 'espd'
  if (ESP_LOG_RE.test(line)) return 'esp-' + line[0].toLowerCase()
  return 'pd'
}

function classifyLogLine(text) {
  if (text.startsWith('[sync] ')) {
    const body = text.slice(7)
    if (body.startsWith('→ ')) return 'dev-tx'
    if (body.startsWith('← ')) return classifyLine(body.slice(2))
    if (body.startsWith('+') || body.startsWith('-ERR')) return classifyLine(body)
    return 'script'
  }
  if (text.startsWith('[Error] ')) return 'dev-err'
  return classifyLine(text)
}

function logLineClass(text) {
  return `log-line log-${classifyLogLine(text)}`
}

function appendLine(text) {
  const div = document.createElement('div')
  div.className = logLineClass(text)
  div.textContent = text
  $('monitor-lines').appendChild(div)
  while ($('monitor-lines').children.length > 500)
    $('monitor-lines').removeChild($('monitor-lines').firstChild)
  if (monFollowLog) scrollMonitorToEnd()
  else show($('mon-scroll-end'), true)
}

$('mon-connect-btn').addEventListener('click', async () => {
  if (monPort || syncClient) return
  try {
    const port = await navigator.serial.requestPort()
    await port.open({ baudRate: 115200 })
    monPort = port
    monBuf = ''
    showMonitorConnected()
    readMonitor(port)
  } catch (err) {
    appendLine('[Error] ' + (err?.message ?? err))
    show($('monitor-wrap'), true)
    show($('mon-clear-btn'), true)
  }
})

async function readMonitor(port) {
  const reader = port.readable.getReader()
  monReader = reader
  const decoder = new TextDecoder()
  try {
    while (monPort === port) {
      const { value, done } = await reader.read()
      if (done) break
      monBuf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = monBuf.indexOf('\n')) !== -1) {
        appendLine(monBuf.slice(0, idx).replace(/\r$/, ''))
        monBuf = monBuf.slice(idx + 1)
      }
    }
  } catch (_) {}
  finally {
    try { reader.releaseLock() } catch (_) {}
    if (monReader === reader) monReader = null
    if (monPort === port) {
      monPort = null
      showMonitorDisconnected()
    }
  }
}

$('mon-disc-btn').addEventListener('click', async () => { await closeMonitor() })
$('mon-clear-btn').addEventListener('click', () => {
  $('monitor-lines').innerHTML = ''
  scrollMonitorToEnd()
})
$('monitor-term').addEventListener('scroll', () => {
  if (isMonitorAtBottom()) scrollMonitorToEnd()
  else {
    monFollowLog = false
    show($('mon-scroll-end'), true)
  }
})
$('mon-scroll-end').addEventListener('click', scrollMonitorToEnd)
$('mon-expand-btn').addEventListener('click', toggleMonitorExpanded)
$('mon-fs-collapse').addEventListener('click', () => setMonitorExpanded(false))
$('mon-fs-clear').addEventListener('click', () => $('mon-clear-btn').click())
$('mon-fs-disc').addEventListener('click', () => $('mon-disc-btn').click())
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && monExpanded) setMonitorExpanded(false)
})

$('sync-folder-btn').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    syncLog('Folder picker not supported in this browser')
    show($('monitor-wrap'), true)
    show($('mon-clear-btn'), true)
    return
  }
  try {
    syncDirHandle = await window.showDirectoryPicker({ mode: 'read' })
    $('sync-folder-name').textContent = syncDirHandle.name
    show($('sync-folder-name'), true)
    setSyncUi(!!syncClient)
    try {
      const hasMain = await syncDirHandle.getFileHandle('main.pd').then(() => true).catch(() => false)
      if (!hasMain) syncLog(`warning: no main.pd in ${syncDirHandle.name}`)
    } catch (_) {}
  } catch (_) {}
})

$('sync-start-btn').addEventListener('click', () => startPatchSync())
$('sync-now-btn').addEventListener('click', () => runSync('sync'))
$('sync-stop-btn').addEventListener('click', () => stopSync())

if (!('serial' in navigator)) show($('serial-warning'), true)
if (location.protocol === 'file:') setTab(true)

fetchGithubReleases()
render()
