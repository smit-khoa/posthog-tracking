# User Paths Viewer

Vite + Vue 3 app trực quan hoá **user journey** từ PostHog dạng Sankey-card giống PostHog User Paths.

- Host: `https://dev.smit.team:8309`
- PostHog HogQL query qua proxy (key giấu server-side)
- Import JSON / paste data thủ công / fetch trực tiếp

## Setup

```bash
cd user-paths-viewer
npm install
cp .env.example .env   # điền POSTHOG_API_KEY + VITE_POSTHOG_PROJECT_ID
```

### HTTPS cert (bạn tự config)

Vite sẽ chạy HTTPS nếu tìm thấy 2 file:
- `certs/dev.smit.team-key.pem`
- `certs/dev.smit.team.pem`

Gợi ý dùng [mkcert](https://github.com/FiloSottile/mkcert):

```bash
brew install mkcert nss
mkcert -install
mkdir -p certs
mkcert -key-file certs/dev.smit.team-key.pem -cert-file certs/dev.smit.team.pem dev.smit.team
```

Đảm bảo `dev.smit.team` trỏ về `127.0.0.1` trong `/etc/hosts`:

```
127.0.0.1   dev.smit.team
```

Nếu chưa có cert → vite vẫn chạy nhưng dùng HTTP (browser sẽ phải mở `http://dev.smit.team:8309`).

## Chạy dev

```bash
npm run dev
```

Mở `https://dev.smit.team:8309`.

## Kiến trúc

```
src/
├── App.vue                              # Layout + toolbar + import/export
├── main.js
├── sample-data.js                       # Sample preview UI khi chưa kết nối PostHog
├── components/
│   └── user-paths-chart.vue            # SVG Sankey-style chart
├── composables/
│   └── use-posthog-query.js            # Wrapper gọi /api/posthog/...
└── styles/global.css
```

### PostHog proxy

`vite.config.js` proxy `/api/posthog/*` → `${VITE_POSTHOG_HOST}/api/*`, kèm header `Authorization: Bearer <POSTHOG_API_KEY>`. Key **không** prefix `VITE_` nên không bao giờ lộ ra bundle client.

### Format dữ liệu

Component `user-paths-chart` nhận `rawData: Array`, mỗi record cần ít nhất:

```json
{
  "full_journey": "timestamp\nAction → timestamp\nAction → ..."
}
```

Các bước được tách bằng ` → `, mỗi bước có thể có timestamp ở dòng đầu (phân cách `\n`). Component sẽ tự đảo thứ tự (bước cuối trong chuỗi gốc = bước đầu thời gian).

## Lưu ý bảo mật

- **KHÔNG** commit `.env` hay `certs/`.
- Personal API key có quyền đọc toàn bộ project, chỉ chạy local hoặc behind VPN.
- Nếu deploy public: thay vite proxy bằng serverless function có rate-limit & auth.
