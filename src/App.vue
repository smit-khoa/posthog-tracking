<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import UserPathsChart from './components/user-paths-chart.vue'
import UserPathsTable from './components/user-paths-table.vue'
import { sampleRawData, defaultQuery } from './sample-data.js'
import { usePosthogQuery } from './composables/use-posthog-query.js'
import {
  TIME_RANGES, DEFAULT_RANGE_KEY, applyRangeToQuery,
  ENV_OPTIONS, DEFAULT_ENV_KEY,
  LIMIT_OPTIONS, DEFAULT_LIMIT,
  CUSTOM_RANGE_KEY,
} from './composables/time-ranges.js'

// localStorage keys
const QUERY_KEY = 'user-paths-viewer:query'
const RANGE_KEY = 'user-paths-viewer:range'
const ENV_KEY = 'user-paths-viewer:env'
const LIMIT_STORAGE_KEY = 'user-paths-viewer:limit'
const CUSTOM_START_KEY = 'user-paths-viewer:custom-start'
const CUSTOM_END_KEY = 'user-paths-viewer:custom-end'

// Helper: format Date → YYYY-MM-DD
function toDateInput(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const today = new Date()
const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)

// Init từ localStorage (nếu có) — lần sau vào lại có data như cũ
const rawData = ref([...sampleRawData])
const query = ref(localStorage.getItem(QUERY_KEY) || defaultQuery)
const timeRange = ref(localStorage.getItem(RANGE_KEY) || DEFAULT_RANGE_KEY)
const envFilter = ref(localStorage.getItem(ENV_KEY) || DEFAULT_ENV_KEY)
const queryLimit = ref(Number(localStorage.getItem(LIMIT_STORAGE_KEY)) || DEFAULT_LIMIT)
const customStart = ref(localStorage.getItem(CUSTOM_START_KEY) || toDateInput(oneWeekAgo))
const customEnd = ref(localStorage.getItem(CUSTOM_END_KEY) || toDateInput(today))

// Focus user — khi click vào id trong table, chart sẽ chỉ vẽ luồng của user đó
const focusedUserId = ref('')
function focusUser(id) {
  if (!id) return
  // Toggle: click cùng user 2 lần → bỏ focus
  focusedUserId.value = focusedUserId.value === id ? '' : id
}
function clearFocus() {
  focusedUserId.value = ''
}

// Dữ liệu truyền vào chart: nếu đang focus thì chỉ giữ user đó
const chartData = computed(() => {
  if (!focusedUserId.value) return rawData.value
  return rawData.value.filter((u) => {
    const id = u.person_id || u.distinct_id || u.user_id
    return id === focusedUserId.value
  })
})

// Khi data refresh → reset focus (id cũ có thể không còn)
watch(rawData, () => { clearFocus() })
const showQueryEditor = ref(false)
const copied = ref(false)

const { loading, error, run } = usePosthogQuery()

const isCustomRange = computed(() => timeRange.value === CUSTOM_RANGE_KEY)

async function fetchFromPosthog() {
  const customRange = isCustomRange.value
    ? { start: customStart.value, end: customEnd.value }
    : null
  const finalQuery = applyRangeToQuery(
    query.value, timeRange.value, envFilter.value, queryLimit.value, customRange,
  )
  const result = await run(finalQuery)
  if (result) {
    rawData.value = result
    try {
      localStorage.setItem(QUERY_KEY, query.value)
      localStorage.setItem(RANGE_KEY, timeRange.value)
      localStorage.setItem(ENV_KEY, envFilter.value)
      localStorage.setItem(LIMIT_STORAGE_KEY, String(queryLimit.value))
      localStorage.setItem(CUSTOM_START_KEY, customStart.value)
      localStorage.setItem(CUSTOM_END_KEY, customEnd.value)
    } catch {}
  }
}

function resetQuery() {
  if (!window.confirm('Đặt lại câu query về mặc định?')) return
  query.value = defaultQuery
  timeRange.value = DEFAULT_RANGE_KEY
  envFilter.value = DEFAULT_ENV_KEY
  queryLimit.value = DEFAULT_LIMIT
  customStart.value = toDateInput(oneWeekAgo)
  customEnd.value = toDateInput(today)
  try {
    localStorage.removeItem(QUERY_KEY)
    localStorage.removeItem(RANGE_KEY)
    localStorage.removeItem(ENV_KEY)
    localStorage.removeItem(LIMIT_STORAGE_KEY)
    localStorage.removeItem(CUSTOM_START_KEY)
    localStorage.removeItem(CUSTOM_END_KEY)
  } catch {}
}

// Tách watch để xử lý đúng case "vừa chuyển sang custom" vs "đổi env/limit khi đang ở custom"
watch(timeRange, (next, prev) => {
  try { localStorage.setItem(RANGE_KEY, next) } catch {}
  // Vừa chuyển sang custom → KHÔNG fetch (chờ user chọn date)
  if (next === CUSTOM_RANGE_KEY && prev !== CUSTOM_RANGE_KEY) return
  if (import.meta.env.VITE_POSTHOG_PROJECT_ID) fetchFromPosthog()
})
watch([envFilter, queryLimit], () => {
  try {
    localStorage.setItem(ENV_KEY, envFilter.value)
    localStorage.setItem(LIMIT_STORAGE_KEY, String(queryLimit.value))
  } catch {}
  // Khi đang ở custom: chỉ fetch nếu date hợp lệ
  if (isCustomRange.value) {
    if (!customStart.value || !customEnd.value) return
    if (customStart.value > customEnd.value) return
  }
  if (import.meta.env.VITE_POSTHOG_PROJECT_ID) fetchFromPosthog()
})

// Custom date change → fetch (chỉ khi đang ở chế độ custom + range hợp lệ)
watch([customStart, customEnd], () => {
  if (!isCustomRange.value) return
  if (!customStart.value || !customEnd.value) return
  if (customStart.value > customEnd.value) return
  try {
    localStorage.setItem(CUSTOM_START_KEY, customStart.value)
    localStorage.setItem(CUSTOM_END_KEY, customEnd.value)
  } catch {}
  if (import.meta.env.VITE_POSTHOG_PROJECT_ID) fetchFromPosthog()
})

// Auto-fetch khi mở trang (chỉ chạy nếu đã cấu hình PostHog)
onMounted(() => {
  if (import.meta.env.VITE_POSTHOG_PROJECT_ID) {
    fetchFromPosthog()
  }
})

async function copyRawData() {
  const json = JSON.stringify(rawData.value, null, 2)
  try {
    await navigator.clipboard.writeText(json)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = json
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1800)
}

function loadSample() {
  rawData.value = [...sampleRawData]
}

function handleFileImport(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result)
      if (Array.isArray(parsed)) {
        rawData.value = parsed
      } else {
        alert('File JSON phải là một mảng các record.')
      }
    } catch (err) {
      alert('JSON không hợp lệ: ' + err.message)
    }
  }
  reader.readAsText(file)
  e.target.value = ''
}
</script>

<template>
  <div class="container">
    <div v-if="loading" class="loading-bar"></div>
    <div class="header">
      <div class="header-text">
        <h2>Biểu đồ Luồng Hành Trình Khách Hàng</h2>
        <div class="subtitle">
          User Paths · Hover vào nhánh để xem số lượng user di chuyển giữa các bước
        </div>
      </div>
      <div class="header-actions">
        <select v-model="envFilter" class="btn time-range-select" :disabled="loading" title="Lọc theo môi trường (host)">
          <option v-for="e in ENV_OPTIONS" :key="e.key" :value="e.key">{{ e.label }}</option>
        </select>
        <select v-model="timeRange" class="btn time-range-select" :disabled="loading">
          <option v-for="r in TIME_RANGES" :key="r.key" :value="r.key">📅 {{ r.label }}</option>
        </select>
        <template v-if="isCustomRange">
          <input
            v-model="customStart"
            type="date"
            class="btn date-input"
            :disabled="loading"
            :max="customEnd"
            title="Từ ngày"
          />
          <span class="date-sep">→</span>
          <input
            v-model="customEnd"
            type="date"
            class="btn date-input"
            :disabled="loading"
            :min="customStart"
            :max="toDateInput(new Date())"
            title="Đến ngày"
          />
        </template>
        <select v-model.number="queryLimit" class="btn time-range-select" :disabled="loading" title="Giới hạn số record">
          <option v-for="n in LIMIT_OPTIONS" :key="n" :value="n">🔢 Limit {{ n }}</option>
        </select>
        <button class="btn" @click="showQueryEditor = !showQueryEditor">
          {{ showQueryEditor ? 'Ẩn query' : 'Sửa HogQL query' }}
        </button>
        <button class="btn btn-primary" :disabled="loading" @click="fetchFromPosthog">
          {{ loading ? 'Đang tải…' : 'Fetch from PostHog' }}
        </button>
        <button class="btn" :class="{ 'btn-success': copied }" @click="copyRawData">
          {{ copied ? `Đã copy (${rawData.length.toLocaleString('en-US')})` : 'Copy data' }}
        </button>
        <label class="btn">
          Import JSON
          <input type="file" accept="application/json,.json" @change="handleFileImport" hidden />
        </label>
        <button class="btn" @click="loadSample">Sample</button>
        <button class="btn btn-danger" @click="resetQuery" title="Đặt lại query về mặc định">
          ↺ Reset
        </button>
      </div>
    </div>

    <div v-if="showQueryEditor" class="query-editor">
      <label class="query-label">HogQL Query</label>
      <textarea v-model="query" class="query-textarea" spellcheck="false"></textarea>
      <div class="query-hint">
        Query phải trả về cột <code>full_journey</code>. Placeholder:
        <code v-pre>{{START_TIME}}</code>, <code v-pre>{{END_TIME}}</code> (thời gian),
        <code v-pre>{{ENV_FILTER}}</code> (môi trường theo <code>properties.$host</code>),
        <code v-pre>{{LIMIT}}</code> (số record).
        Query được lưu vào localStorage sau mỗi lần fetch thành công.
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div v-if="focusedUserId" class="focus-banner">
      <span class="focus-icon">👤</span>
      <span>Đang xem luồng riêng của user</span>
      <code class="focus-id">{{ focusedUserId }}</code>
      <button class="focus-clear" @click="clearFocus">Bỏ lọc · xem toàn bộ</button>
    </div>

    <UserPathsChart :raw-data="chartData" :loading="loading" />

    <div class="legend">
      <span class="legend-swatch"></span>
      <span>Số user đi qua bước · Bar height tỉ lệ với số user · Dải nối thể hiện flow</span>
    </div>

    <UserPathsTable
      :raw-data="rawData"
      :focused-user-id="focusedUserId"
      :loading="loading"
      @focus-user="focusUser"
    />
  </div>
</template>

<style scoped>
.container {
  max-width: 1600px;
  margin: 0 auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}
.header {
  padding: 20px 24px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.header h2 { margin: 0; font-size: 18px; font-weight: 600; color: #111827; }
.subtitle { font-size: 13px; color: #6b7280; margin-top: 4px; }
.header-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.btn:hover:not(:disabled) { background: #f9fafb; border-color: #9ca3af; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-primary {
  background: #6366f1; color: #fff; border-color: #6366f1;
}
.btn-primary:hover:not(:disabled) { background: #4f46e5; border-color: #4f46e5; }
.btn-success { background: #ecfdf5; border-color: #10b981; color: #065f46; }
.btn-danger {
  color: #991b1b; border-color: #fecaca;
}
.btn-danger:hover:not(:disabled) { background: #fef2f2; border-color: #fca5a5; }

.time-range-select {
  padding-right: 28px;
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='%236b7280' d='M4 6l4 4 4-4'/%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 16px;
  cursor: pointer;
}

.date-input {
  font-family: inherit;
  font-size: 13px;
  padding: 6px 8px;
  cursor: pointer;
}
.date-sep {
  display: inline-flex; align-items: center;
  color: #6b7280; font-size: 13px;
  padding: 0 4px;
}

.query-editor {
  padding: 16px 24px;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
}
.query-label {
  display: block; font-size: 12px; font-weight: 600;
  color: #374151; margin-bottom: 6px;
}
.query-textarea {
  width: 100%;
  min-height: 180px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  resize: vertical;
}
.query-hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
.query-hint code {
  background: #e5e7eb;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}

.error-banner {
  margin: 0 24px 16px;
  padding: 10px 12px;
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
}

.legend {
  padding: 12px 24px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
}
.legend-swatch {
  width: 12px; height: 12px; border-radius: 2px; background: #6366f1;
}

.focus-banner {
  display: flex; align-items: center; gap: 8px;
  margin: 12px 24px 0;
  padding: 10px 14px;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  font-size: 13px;
  color: #312e81;
  flex-wrap: wrap;
}
.focus-icon { font-size: 16px; }
.focus-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #fff;
  border: 1px solid #c7d2fe;
  padding: 2px 6px;
  border-radius: 4px;
  color: #4338ca;
}
.focus-clear {
  margin-left: auto;
  padding: 4px 10px;
  background: #fff;
  border: 1px solid #c7d2fe;
  border-radius: 6px;
  font-size: 12px;
  color: #4338ca;
  cursor: pointer;
}
.focus-clear:hover { background: #c7d2fe; }

.loading-bar {
  position: absolute;
  left: 0; right: 0; top: 0;
  height: 3px;
  background: linear-gradient(90deg, transparent 0%, #6366f1 50%, transparent 100%);
  background-size: 30% 100%;
  background-repeat: no-repeat;
  animation: loading-slide 1.2s linear infinite;
  z-index: 50;
}
@keyframes loading-slide {
  0% { background-position: -30% 0; }
  100% { background-position: 130% 0; }
}

.container { position: relative; }
</style>
