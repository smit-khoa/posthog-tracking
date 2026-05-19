// Vercel Serverless Function — proxy /api/posthog/* → ${POSTHOG_HOST}/api/*
// Giữ POSTHOG_API_KEY ở server-side, không leak ra client bundle.
// Tương đương vite proxy trong vite.config.js khi chạy `npm run dev`.

export default async function handler(req, res) {
  const host = (process.env.VITE_POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '')
  const apiKey = process.env.POSTHOG_API_KEY

  if (!apiKey) {
    res.status(500).json({ error: 'Missing POSTHOG_API_KEY env on server' })
    return
  }

  // Vercel rewrites /api/posthog/foo/bar → req.query.path = ['foo','bar']
  const pathParts = Array.isArray(req.query.path) ? req.query.path : [req.query.path].filter(Boolean)
  const targetPath = '/api/' + pathParts.join('/')

  // Preserve query string (loại bỏ `path` mà Vercel auto-inject)
  const { path: _ignored, ...rest } = req.query
  const qs = new URLSearchParams(rest).toString()
  const url = host + targetPath + (qs ? `?${qs}` : '')

  // Một số PostHog endpoint yêu cầu trailing slash
  const finalUrl = targetPath.endsWith('/') ? url : url

  try {
    const upstream = await fetch(finalUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    })

    const contentType = upstream.headers.get('content-type') || ''
    res.status(upstream.status)

    if (contentType.includes('application/json')) {
      const json = await upstream.json()
      res.json(json)
    } else {
      const text = await upstream.text()
      res.send(text)
    }
  } catch (err) {
    res.status(502).json({ error: 'Proxy error', detail: err.message })
  }
}
