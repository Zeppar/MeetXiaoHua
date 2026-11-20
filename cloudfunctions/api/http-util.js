const http = require('http')
const https = require('https')

function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? http : https
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body)
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Length': payload.length } : {})
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const contentType = String(res.headers['content-type'] || '')
          let json = null
          if (contentType.indexOf('application/json') >= 0 || buf[0] === 0x7b) {
            try {
              json = JSON.parse(buf.toString('utf8'))
            } catch (e) {
              json = null
            }
          }
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            buffer: buf,
            json,
            text: buf.toString('utf8')
          })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      const err = new Error('request timeout')
      err.code = 'TIMEOUT'
      reject(err)
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function buildMultipart(fields, fileField) {
  const boundary = `----MeetXiaoHua${Date.now()}${Math.random().toString(16).slice(2)}`
  const parts = []
  Object.keys(fields || {}).forEach((key) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${fields[key]}\r\n`
      )
    )
  })
  if (fileField) {
    const { name, filename, contentType, buffer } = fileField
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
      )
    )
    parts.push(buffer)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    boundary,
    body: Buffer.concat(parts)
  }
}

module.exports = {
  request,
  buildMultipart
}
