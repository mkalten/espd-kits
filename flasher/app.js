import { ESPLoader, Transport } from 'https://cdn.jsdelivr.net/npm/esptool-js@0.5.4/bundle.js'

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

const $ = id => document.getElementById(id)
const show = (el, on) => { el.classList.toggle('hidden', !on) }

function releaseDownloadBase(tag) {
  return `https://github.com/${REPO}/releases/download/${tag}`
}

async function loadBoardCatalog() {
  try {
    const res = await fetch('manifests/boards.json')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    boards = data.boards || []
  } catch {
    boards = [{
      id: 'waveshare_s3',
      name: 'Waveshare ESP32-S3-AUDIO',
      target: 'esp32s3',
      chip: 'ESP32-S3',
      description: 'Waveshare AI Smart Speaker / ESP32-S3-AUDIO Board (ES8311 DAC,',
    }]
  }
  if (boards.length === 1) selectedBoardId = boards[0].id
  renderBoards()
}

function renderBoards() {
  const grid = $('board-grid')
  grid.innerHTML = ''
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
      $('release-select').value = ''
      renderBoards()
      renderFirmwareOptions()
      render()
    })
    grid.appendChild(btn)
  }
}

async function loadReleaseManifest(tag) {
  if (releaseManifests.has(tag)) return releaseManifests.get(tag)
  try {
    const res = await fetch(`${releaseDownloadBase(tag)}/manifest.json`)
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
  show($('board-no-fw'), false)
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    githubReleases = (await res.json()).filter(r => !r.draft)
  } catch {
    githubReleases = []
  }
  renderFirmwareOptions()
  render()
}

function stableReleases() {
  return githubReleases.filter(r => !r.prerelease)
}

function visibleReleases() {
  const s = stableReleases()
  return s.length ? s : githubReleases
}

async function renderFirmwareOptions() {
  show($('fw-loading'), false)
  const vr = visibleReleases()
  if (!vr.length) {
    show($('fw-none'), true)
    return
  }
  const sel = $('release-select')
  show(sel, true)
  while (sel.children.length > 1) sel.removeChild(sel.lastChild)
  for (const r of vr) {
    const o = document.createElement('option')
    o.value = r.tag_name
    o.textContent = (r.name || r.tag_name) + (r.prerelease ? ' (preview)' : '')
    sel.appendChild(o)
  }
  if (sel.value) await updateBoardFirmwareAvailability(sel.value)
}

async function updateBoardFirmwareAvailability(tag) {
  if (!tag || !selectedBoardId) {
    show($('board-no-fw'), false)
    return
  }
  const manifest = await loadReleaseManifest(tag)
  if (!manifest) {
    show($('board-no-fw'), false)
    return
  }
  const hasBoard = (manifest.boards || []).some(b => b.id === selectedBoardId)
  show($('board-no-fw'), !hasBoard)
}

function fwReady() {
  if (!selectedBoardId) return false
  if (useLocal) return !!localFile
  const tag = $('release-select').value
  if (!tag) return false
  if ($('board-no-fw') && !$('board-no-fw').classList.contains('hidden')) return false
  return true
}

function stepState(n) {
  if (n === 1) return selectedBoardId ? 'done' : 'active'
  if (n === 2) return !selectedBoardId ? 'locked' : fwReady() ? 'done' : 'active'
  if (n === 3) return !fwReady() ? 'locked' : 'active'
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
  render()
}

$('tab-release').addEventListener('click', () => setTab(false))
$('tab-local').addEventListener('click', () => setTab(true))
$('release-select').addEventListener('change', async () => {
  await updateBoardFirmwareAvailability($('release-select').value)
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
    ? `<div class="mt-2 max-h-40 overflow-y-auto border border-neutral-200 bg-neutral-50 p-3 font-mono text-[10px] leading-relaxed text-neutral-600">${flashLog.map(l => `<div>${l}</div>`).join('')}</div>`
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

function appendLine(text) {
  const div = document.createElement('div')
  div.textContent = text
  $('monitor-lines').appendChild(div)
  while ($('monitor-lines').children.length > 500)
    $('monitor-lines').removeChild($('monitor-lines').firstChild)
  $('monitor-term').scrollTop = $('monitor-term').scrollHeight
}

$('mon-connect-btn').addEventListener('click', async () => {
  try {
    const port = await navigator.serial.requestPort()
    await port.open({ baudRate: 115200 })
    monPort = port; monBuf = ''
    show($('mon-connect-btn'), false)
    show($('mon-reset-btn'), true)
    show($('mon-disc-btn'), true)
    show($('mon-status'), true)
    show($('mon-clear-btn'), true)
    show($('monitor-term'), true)
    show($('monitor-cursor'), true)
    readMonitor(port)
  } catch (err) {
    appendLine('[Error] ' + (err?.message ?? err))
    show($('monitor-term'), true)
    show($('mon-clear-btn'), true)
  }
})

async function readMonitor(port) {
  const decoder = new TextDecoderStream()
  port.readable.pipeTo(decoder.writable).catch(() => {})
  monReader = decoder.readable.getReader()
  try {
    while (true) {
      const { value, done } = await monReader.read()
      if (done) break
      monBuf += value
      let idx
      while ((idx = monBuf.indexOf('\n')) !== -1) {
        appendLine(monBuf.slice(0, idx).replace(/\r$/, ''))
        monBuf = monBuf.slice(idx + 1)
      }
    }
  } catch (_) {}
}

$('mon-reset-btn').addEventListener('click', async () => {
  if (!monPort) return
  try {
    await monPort.setSignals({ dataTerminalReady: false, requestToSend: true })
    await new Promise(r => setTimeout(r, 100))
    await monPort.setSignals({ dataTerminalReady: true, requestToSend: false })
  } catch (err) { appendLine('[Reset error] ' + (err?.message ?? err)) }
})
$('mon-disc-btn').addEventListener('click', async () => {
  try { await monReader?.cancel() } catch (_) {}
  try { await monPort?.close() } catch (_) {}
})
$('mon-clear-btn').addEventListener('click', () => { $('monitor-lines').innerHTML = '' })

if (!('serial' in navigator)) show($('serial-warning'), true)
if (location.protocol === 'file:') setTab(true)

loadBoardCatalog().then(fetchGithubReleases)
render()
