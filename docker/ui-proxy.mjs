import http from 'node:http'

/**
 * Publish the loopback-only management UI on a container port.
 *
 * The service fences management requests by Host/Origin (src/trust.js):
 * Host must be a loopback authority, and Origin/Referer must match it.
 * This proxy terminates the browser's public authority and rewrites the
 * upstream request to the service's own loopback authority, dropping the
 * browser provenance headers. The UI login (managementKey) remains the
 * application-level authentication; optional Basic Auth is an extra gate.
 */
export function startUiProxy({
  listenHost = '0.0.0.0',
  listenPort = 8080,
  targetHost = '127.0.0.1',
  targetPort = 18900,
  basicAuth = '',
  logger = console,
} = {}) {
  return new Promise((resolve, reject) => {
    const expectedAuth = basicAuth === ''
      ? ''
      : `Basic ${Buffer.from(basicAuth, 'utf8').toString('base64')}`

    const server = http.createServer((req, res) => {
      if (expectedAuth !== '' && req.headers.authorization !== expectedAuth) {
        res.writeHead(401, {
          'www-authenticate': 'Basic realm="Our Free Model"',
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end('authentication required')
        return
      }

      const headers = { ...req.headers }
      headers.host = `${targetHost}:${targetPort}`
      delete headers.origin
      delete headers.referer
      delete headers['sec-fetch-site']

      const upstream = http.request({
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      }, up => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      })

      upstream.on('error', error => {
        logger.warn?.(`[ofm] Web UI upstream error: ${error.message}`)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('management service unavailable')
        } else {
          res.end()
        }
      })
      req.on('aborted', () => upstream.destroy())
      req.pipe(upstream)
    })

    server.once('error', reject)
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : listenPort
      resolve({
        port,
        close: () => new Promise((done, fail) => {
          server.close(error => error ? fail(error) : done())
          server.closeAllConnections?.()
        }),
      })
    })
  })
}
