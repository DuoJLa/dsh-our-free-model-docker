import fs from 'node:fs'
import path from 'node:path'

// Worker threads inherit process.execArgv. Some hosts (iSH, hardened runtimes)
// inject V8 flags that are invalid for Worker; channels/runtime.mjs only filters
// --input-type. Memory flags belong in NODE_OPTIONS, not on the CLI.
process.execArgv = []

const { startStandalone } = await import('../packages/standalone/service.mjs')
const { startUiProxy } = await import('./ui-proxy.mjs')

const dataDir = path.resolve(process.env.OFM_HOME || '/data')
const port = Number(process.env.OFM_PORT || 18900)
const lanEnabled = process.env.OFM_LAN !== '0'
const lanPort = Number(process.env.OFM_LAN_PORT || 18901)
const refresh = process.env.OFM_REFRESH !== '0'
const uiPort = Number(process.env.OFM_UI_PORT || 8080)
const uiBind = process.env.OFM_UI_BIND || '0.0.0.0'
const uiBasicAuth = (process.env.OFM_UI_BASIC_AUTH || '').trim()

function secret(name) {
  const file = process.env[`${name}_FILE`]
  if (file && file.trim() !== '') {
    try {
      return fs.readFileSync(file, 'utf8').trim()
    } catch (error) {
      console.error(`[ofm] cannot read ${name}_FILE: ${error.message}`)
      process.exit(1)
    }
  }
  return (process.env[name] || '').trim()
}

const managementKey = secret('OFM_MANAGEMENT_KEY')
const lanKey = secret('OFM_LAN_KEY')
const forwardKey = secret('OFM_FORWARD_KEY')

for (const [name, value] of [
  ['OFM_MANAGEMENT_KEY', managementKey],
  ['OFM_LAN_KEY', lanKey],
  ['OFM_FORWARD_KEY', forwardKey],
]) {
  if (value !== '' && value.length < 16) console.warn(`[ofm] ${name} is shorter than 16 characters; use a generated token`)
}

for (const [label, value] of [['OFM_PORT', port], ['OFM_LAN_PORT', lanPort], ['OFM_UI_PORT', uiPort]]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`[ofm] invalid ${label}: ${process.env[label]}`)
    process.exit(2)
  }
}
if (new Set([port, lanPort, uiPort]).size !== 3) {
  console.error('[ofm] OFM_PORT, OFM_LAN_PORT and OFM_UI_PORT must be distinct')
  process.exit(2)
}
if (uiBasicAuth !== '' && !uiBasicAuth.includes(':')) {
  console.error('[ofm] OFM_UI_BASIC_AUTH must be user:password')
  process.exit(2)
}

// Seed only the keys the operator supplied. If a key is absent the service
// generates one; existing values in the volume are never overwritten by an
// empty environment.
function seedSettings() {
  const file = path.join(dataDir, 'settings.json')
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[ofm] cannot parse ${file}: ${error.message}`)
      process.exit(1)
    }
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    console.error(`[ofm] ${file} is not a JSON object`)
    process.exit(1)
  }
  let changed = !fs.existsSync(file)
  const set = (key, value) => {
    if (value !== '' && current[key] !== value) {
      current[key] = value
      changed = true
    }
  }
  set('managementKey', managementKey)
  set('forwardKey', forwardKey)
  set('standaloneLanKey', lanKey)
  if (lanEnabled && current.standaloneLanEnabled !== true) {
    current.standaloneLanEnabled = true
    changed = true
  }
  if (current.version === undefined) {
    current.version = 1
    changed = true
  }
  if (!changed) return
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
}
seedSettings()

let service
try {
  service = await startStandalone({
    dataDir,
    port,
    lanEnabled,
    lanPort,
    refresh,
    logger: {
      info: message => console.log(`[ofm] ${message}`),
      warn: message => console.warn(`[ofm] ${message}`),
      error: message => console.error(`[ofm] ${message}`),
    },
  })
} catch (error) {
  console.error(`[ofm] startup failed: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`)
  process.exit(1)
}

// The full URL contains a one-time login token. Write it to the data volume
// with 0600 instead of printing it to Docker logs.
const bootstrapFile = path.join(dataDir, 'bootstrap-url')
fs.writeFileSync(bootstrapFile, `${service.managementUrl}\n`, { mode: 0o600 })
try { fs.chmodSync(bootstrapFile, 0o600) } catch { /* best effort */ }

let ui
try {
  ui = await startUiProxy({
    listenHost: uiBind,
    listenPort: uiPort,
    targetPort: port,
    basicAuth: uiBasicAuth,
    logger: { info: message => console.log(message), warn: message => console.warn(message) },
  })
} catch (error) {
  console.error(`[ofm] Web UI proxy failed to start: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`)
  try { await service.close() } catch { /* best effort */ }
  process.exit(1)
}

console.log(`[ofm] ${service.product} ${service.version} listening on ${service.url}`)
console.log(`[ofm] Web UI: http://${uiBind}:${ui.port}/ (login with OFM_MANAGEMENT_KEY or bootstrap URL)`)
console.log(`[ofm] management bootstrap URL written to ${bootstrapFile} (mode 0600)`)
if (service.lan?.running) {
  console.log(`[ofm] LAN API: ${service.lan.baseUrls.join(', ') || `port ${service.lan.port}`} (Bearer OFM_LAN_KEY)`)
} else if (service.lan?.error) {
  console.warn(`[ofm] LAN relay unavailable: ${service.lan.error}`)
}

let stopping = false
async function stop(signal) {
  if (stopping) return
  stopping = true
  console.log(`[ofm] ${signal} received, shutting down`)
  try {
    await ui.close()
  } catch (error) {
    console.error(`[ofm] UI proxy shutdown failed: ${error?.message ?? error}`)
    process.exitCode = 1
  }
  try {
    await service.close()
  } catch (error) {
    console.error(`[ofm] service shutdown failed: ${error?.message ?? error}`)
    process.exitCode = 1
  } finally {
    process.exit(process.exitCode ?? 0)
  }
}
process.on('SIGTERM', () => { void stop('SIGTERM') })
process.on('SIGINT', () => { void stop('SIGINT') })

// Keep the process alive if the HTTP server ever unrefs itself.
setInterval(() => {}, 1 << 30)
