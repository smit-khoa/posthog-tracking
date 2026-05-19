// Danh sách time range giống PostHog. Mỗi item:
//  - key: id để lưu localStorage
//  - label: hiển thị UI
//  - getStart(now): trả về Date làm thời điểm bắt đầu (hoặc null = all time)
// Việc replace vào query: format `YYYY-MM-DD HH:MM:SS` (PostHog ClickHouse DateTime).

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function addDays(d, n) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
function startOfWeek(d) {
  // Tuần bắt đầu thứ 2 (chuẩn Việt Nam / ISO)
  const x = startOfDay(d)
  const day = x.getDay() // 0=CN
  const diff = (day === 0 ? -6 : 1 - day)
  return addDays(x, diff)
}
function startOfMonth(d) {
  const x = startOfDay(d)
  x.setDate(1)
  return x
}
function startOfYear(d) {
  const x = startOfDay(d)
  x.setMonth(0, 1)
  return x
}

// Mốc release update mới: 11:00 ngày 19/05/2026 (giờ VN, UTC+7)
export const LATEST_UPDATE_AT = new Date('2026-05-19T11:00:00+07:00')

export const TIME_RANGES = [
  { key: 'since_latest_update', label: 'Từ update mới', getStart: () => LATEST_UPDATE_AT },
  { key: 'today', label: 'Today', getStart: (now) => startOfDay(now) },
  { key: 'yesterday', label: 'Yesterday', getStart: (now) => addDays(startOfDay(now), -1), getEnd: (now) => startOfDay(now) },
  { key: 'last_hour', label: 'Last hour', getStart: (now) => new Date(now.getTime() - 60 * 60 * 1000) },
  { key: 'last_24_hours', label: 'Last 24 hours', getStart: (now) => new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  { key: 'last_7_days', label: 'Last 7 days', getStart: (now) => addDays(now, -7) },
  { key: 'last_14_days', label: 'Last 14 days', getStart: (now) => addDays(now, -14) },
  { key: 'last_30_days', label: 'Last 30 days', getStart: (now) => addDays(now, -30) },
  { key: 'last_90_days', label: 'Last 90 days', getStart: (now) => addDays(now, -90) },
  { key: 'last_180_days', label: 'Last 180 days', getStart: (now) => addDays(now, -180) },
  { key: 'last_week', label: 'Last week', getStart: (now) => addDays(startOfWeek(now), -7), getEnd: (now) => startOfWeek(now) },
  { key: 'last_month', label: 'Last month', getStart: (now) => { const s = startOfMonth(now); s.setMonth(s.getMonth() - 1); return s }, getEnd: (now) => startOfMonth(now) },
  { key: 'this_week', label: 'This week', getStart: (now) => startOfWeek(now) },
  { key: 'this_month', label: 'This month', getStart: (now) => startOfMonth(now) },
  { key: 'year_to_date', label: 'Year to date', getStart: (now) => startOfYear(now) },
  { key: 'all_time', label: 'All time', getStart: () => null },
  { key: 'custom', label: '🗓 Tự chọn ngày…', getStart: () => null }, // dùng customStart/customEnd
]

export const CUSTOM_RANGE_KEY = 'custom'

export const DEFAULT_RANGE_KEY = 'last_14_days'

// Format Date → 'YYYY-MM-DD HH:MM:SS' theo UTC.
// PostHog ClickHouse lưu `timestamp` ở UTC; string trong WHERE cũng được parse là UTC.
// Nếu format ở local time (UTC+7) thì filter sẽ lệch 7 tiếng so với data thực tế.
export function formatPosthogTimestamp(d) {
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

// Resolve range key → { start, end } (Date | null)
export function resolveRange(key, now = new Date()) {
  const range = TIME_RANGES.find((r) => r.key === key)
  if (!range) return { start: null, end: null }
  return {
    start: range.getStart ? range.getStart(now) : null,
    end: range.getEnd ? range.getEnd(now) : null,
  }
}

// ---- Env filter theo host ----
// PostHog auto-capture `properties.$host`. Logic:
//   prod  → host kết thúc bằng PROD_HOST_SUFFIX (cover agency.smit.vn, dashboard.smit.vn, …)
//   dev   → host KHÔNG kết thúc bằng PROD_HOST_SUFFIX (localhost, staging, IP…)
//   all   → không filter
export const PROD_HOST_SUFFIX = '.vn'

export const ENV_OPTIONS = [
  { key: 'all', label: '🌐 All envs' },
  { key: 'prod', label: '🚀 Production' },
  { key: 'dev', label: '🧪 Dev / Staging' },
]

export const DEFAULT_ENV_KEY = 'prod'

// Limit options cho dropdown
export const LIMIT_OPTIONS = [100, 200, 500, 1000, 2000]
export const DEFAULT_LIMIT = 100

function buildEnvFilter(envKey) {
  if (envKey === 'prod') return `AND properties.$host LIKE '%${PROD_HOST_SUFFIX}'`
  if (envKey === 'dev') return `AND properties.$host NOT LIKE '%${PROD_HOST_SUFFIX}'`
  return '' // all
}

// Apply range + env filter + limit vào query template
// Placeholders:
//   {{START_TIME}}, {{END_TIME}} → 'YYYY-MM-DD HH:MM:SS'
//   {{ENV_FILTER}} → '' | "AND properties.$host = '...'"
//   {{LIMIT}} → số (mặc định 100)
// `customRange` = { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } khi rangeKey === 'custom'
export function applyRangeToQuery(query, rangeKey, envKey = 'all', limit = DEFAULT_LIMIT, customRange = null, now = new Date()) {
  let start, end
  if (rangeKey === CUSTOM_RANGE_KEY && customRange && customRange.start && customRange.end) {
    // Cả ngày: from 00:00:00 đến 23:59:59
    start = new Date(customRange.start + 'T00:00:00')
    end = new Date(customRange.end + 'T23:59:59')
  } else {
    const r = resolveRange(rangeKey, now)
    start = r.start
    end = r.end
  }
  let q = query
  if (q.includes('{{START_TIME}}')) {
    q = q.replaceAll('{{START_TIME}}', start ? formatPosthogTimestamp(start) : '1970-01-01 00:00:00')
  }
  if (q.includes('{{END_TIME}}')) {
    q = q.replaceAll('{{END_TIME}}', end ? formatPosthogTimestamp(end) : formatPosthogTimestamp(now))
  }
  if (q.includes('{{ENV_FILTER}}')) {
    q = q.replaceAll('{{ENV_FILTER}}', buildEnvFilter(envKey))
  }
  if (q.includes('{{LIMIT}}')) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
    q = q.replaceAll('{{LIMIT}}', String(safeLimit))
  }
  return q
}
