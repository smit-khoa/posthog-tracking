import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // ---- HTTPS cert (optional) ----
  // Bạn tự config sau. Bỏ comment + chỉnh path khi đã có cert (mkcert hoặc cert nội bộ).
  // Ví dụ với mkcert:
  //   mkcert -install
  //   mkcert -key-file certs/dev.smit.team-key.pem -cert-file certs/dev.smit.team.pem dev.smit.team
  let https = undefined
  const keyPath = path.resolve(__dirname, 'certs/dev.smit.team-key.pem')
  const certPath = path.resolve(__dirname, 'certs/dev.smit.team.pem')
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    https = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  }

  // ---- PostHog host ----
  const posthogHost = env.VITE_POSTHOG_HOST || 'https://us.posthog.com'

  return {
    plugins: [vue()],
    server: {
      host: 'dev.smit.team',
      port: 8309,
      strictPort: true,
      https,
      proxy: {
        // Browser gọi `/api/posthog/...` → vite forward sang `${posthogHost}/api/...`
        // Personal API key chỉ tồn tại server-side, không expose ra client.
        '/api/posthog': {
          target: posthogHost,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/posthog/, '/api'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const key = env.POSTHOG_API_KEY
              if (key) {
                proxyReq.setHeader('Authorization', `Bearer ${key}`)
              }
            })
          },
        },
      },
    },
  }
})
