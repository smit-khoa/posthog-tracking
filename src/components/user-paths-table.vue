<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  rawData: { type: Array, required: true },
  focusedUserId: { type: String, default: '' },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['focus-user'])

// PostHog link helpers — đồng nhất với chart component
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '')
const POSTHOG_PROJECT_ID = import.meta.env.VITE_POSTHOG_PROJECT_ID || ''
const canOpenPosthog = !!POSTHOG_PROJECT_ID
function personUrl(id) {
  if (!canOpenPosthog || !id) return '#'
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/person/${encodeURIComponent(id)}`
}
function replayUrl(sessionId) {
  if (!canOpenPosthog || !sessionId) return ''
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/replay/${encodeURIComponent(sessionId)}`
}
function replayListUrl(distinctId) {
  if (!canOpenPosthog || !distinctId) return '#'
  // Dùng person page tab sessionRecordings — PostHog tự lọc đúng recordings của user
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/person/${encodeURIComponent(distinctId)}?activeTab=sessionRecordings`
}

// ---- Columns definition ----
// Mỗi cột có:
//  - key: field name trong row data (khớp với SQL alias trong sample-data.js)
//  - label: tên hiển thị (tiếng Việt)
//  - hint: chú thích giải thích chỉ số PostHog (hiện qua icon ⓘ)
//  - width, align, type
const columns = [
  {
    key: '__index',
    label: '#',
    hint: 'Số thứ tự dòng theo thứ tự sort hiện tại (không phải id user). Click cột khác để đổi sort sẽ làm STT thay đổi tương ứng.',
    width: 60,
    type: 'index',
    align: 'right',
  },
  {
    key: 'person_id',
    label: 'Mã user',
    hint: 'PostHog person_id (UUID nội bộ). Click vào để focus luồng của user này trong chart bên trên. Các icon: ⧉ copy, ▶ replay session mới nhất, 📜 danh sách recordings, ↗ trang person trên PostHog.',
    width: 280,
    type: 'id',
  },
  {
    key: 'distinct_id',
    label: 'Distinct ID',
    hint: 'distinct_id PostHog — thường là email hoặc user_id thật của user (đã identify). Giúp nhận biết "user này là ai" thay vì UUID nội bộ. Click icon ⧉ để copy.',
    width: 240,
    type: 'distinct',
  },
  {
    key: 'total_steps',
    label: 'Tổng bước',
    hint: 'Tổng số event PostHog mà user đã trigger trong khoảng thời gian truy vấn (đã loại các event hệ thống bắt đầu bằng $, mcp_, posthog_, Application, Deep link). Mỗi pageview / click / scroll = 1 bước.',
    width: 110,
    type: 'number',
    align: 'right',
  },
  {
    key: 'duration_minutes',
    label: 'Thời lượng (phút)',
    hint: 'Khoảng cách thời gian (phút) giữa event đầu tiên và event cuối cùng của user trong session. Tính bằng dateDiff(max, min) / 60.',
    width: 140,
    type: 'number',
    align: 'right',
  },
  {
    key: 'started_at',
    label: 'Bắt đầu',
    hint: 'Timestamp event đầu tiên của user (giờ máy chủ PostHog, đã đổi sang local). Bảng mặc định sort giảm dần theo cột này.',
    width: 180,
    type: 'date',
  },
  {
    key: 'user_status',
    label: 'Trạng thái',
    hint: 'Phân loại user theo hành vi sâu nhất đạt được, ưu tiên từ cao xuống thấp: 💰 Đã click mua → 🤝 Đã click tư vấn → 📊 Xem dashboard → 👀 Xem giá → 🔍 Chỉ xem. Mỗi user chỉ rơi vào 1 trạng thái.',
    width: 180,
    type: 'text',
  },
  {
    key: 'scroll_count',
    label: 'Scroll',
    hint: 'Số lần user trigger event chứa từ "Scroll". Phản ánh mức độ đọc nội dung trang.',
    width: 90,
    type: 'number',
    align: 'right',
  },
  {
    key: 'pricing_interest',
    label: 'Xem giá',
    hint: 'Số lần user trigger event liên quan đến "giá" (xem bảng giá, mở popup giá…). Tín hiệu quan tâm thương mại.',
    width: 100,
    type: 'number',
    align: 'right',
  },
  {
    key: 'clicked_consultation',
    label: 'Tư vấn',
    hint: 'Số lần user click vào event "tư vấn" (nút gọi tư vấn, form liên hệ…). Tín hiệu chuyển đổi mềm.',
    width: 100,
    type: 'number',
    align: 'right',
  },
  {
    key: 'clicked_buy',
    label: 'Mua',
    hint: 'Số lần user click vào event "mua" (nút thanh toán, đăng ký gói…). Tín hiệu chuyển đổi cứng — gần nhất với mục tiêu doanh thu.',
    width: 90,
    type: 'number',
    align: 'right',
  },
  {
    key: 'clicked_dashboard',
    label: 'Dashboard',
    hint: 'Số lần user truy cập / tương tác với dashboard. User đã đăng nhập và đang sử dụng sản phẩm.',
    width: 110,
    type: 'number',
    align: 'right',
  },
  {
    key: 'full_journey',
    label: 'Hành trình',
    hint: 'Mở modal xem toàn bộ chuỗi event theo thứ tự thời gian (timeline). Hiển thị số bước trên nút.',
    width: 140,
    type: 'journey',
  },
]

// ---- Journey modal ----
const journeyModal = ref({ visible: false, userId: '', steps: [] })

function parseJourneySteps(raw) {
  if (!raw) return []
  return raw
    .split(' → ')
    .map((s) => {
      const parts = s.split('\n')
      if (parts.length > 1) {
        return { time: parts[0].trim(), event: parts[1].trim() }
      }
      return { time: '', event: s.trim() }
    })
    .reverse() // bước cuối chuỗi = bước đầu thời gian
}

function openJourney(row) {
  journeyModal.value = {
    visible: true,
    userId: row.person_id || row.distinct_id || row.user_id || '',
    distinctId: row.distinct_id || row.person_id || row.user_id || '',
    sessionId: row.latest_session_id || '',
    totalSteps: row.total_steps,
    duration: row.duration_minutes,
    startedAt: row.started_at,
    steps: parseJourneySteps(row.full_journey),
  }
}
function closeJourney() {
  journeyModal.value = { visible: false, userId: '', distinctId: '', sessionId: '', steps: [] }
}

const journeyCopied = ref(false)
async function copyJourney() {
  const text = journeyModal.value.steps
    .map((s, i) => `${String(i + 1).padStart(2, '0')}. ${s.time ? s.time + ' · ' : ''}${s.event}`)
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
  journeyCopied.value = true
  setTimeout(() => (journeyCopied.value = false), 1400)
}

// Total width của bảng (cho horizontal scroll khi cần)
const totalWidth = computed(() => columns.reduce((s, c) => s + c.width, 0))

// ---- Sort ----
const sortKey = ref('started_at')
const sortDir = ref('desc') // 'asc' | 'desc'

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

const sortedRows = computed(() => {
  const arr = [...props.rawData]
  const key = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  arr.sort((a, b) => {
    const va = a?.[key]
    const vb = b?.[key]
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
    return String(va).localeCompare(String(vb)) * dir
  })
  return arr
})

// ---- Virtual scroll ----
// Render 1 cửa sổ N rows quanh scrollTop. Rất gọn, không cần lib.
const ROW_HEIGHT = 36
const VIEWPORT_HEIGHT = 480
const OVERSCAN = 8 // số rows render trước/sau viewport để scroll mượt

const scrollTop = ref(0)
function onScroll(e) {
  scrollTop.value = e.target.scrollTop
}

const totalHeight = computed(() => sortedRows.value.length * ROW_HEIGHT)

const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2
  const end = Math.min(sortedRows.value.length, start + visibleCount)
  return { start, end }
})

const visibleRows = computed(() => {
  const { start, end } = visibleRange.value
  return sortedRows.value.slice(start, end).map((row, i) => ({ row, index: start + i }))
})

const topPadding = computed(() => visibleRange.value.start * ROW_HEIGHT)

// ---- Formatters ----
function formatCell(value, type) {
  if (value == null || value === '') return '—'
  if (type === 'date') {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
  }
  if (type === 'number') {
    if (typeof value === 'number') return value.toLocaleString('en-US')
    return value
  }
  return value
}

// ---- Copy ----
const copiedId = ref(null)
async function copyId(id) {
  try {
    await navigator.clipboard.writeText(id)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = id
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
  copiedId.value = id
  setTimeout(() => { if (copiedId.value === id) copiedId.value = null }, 1200)
}
</script>

<template>
  <div class="upt-root">
    <div class="upt-header">
      <div class="upt-title">
        Dashboard ·
        <b>{{ sortedRows.length.toLocaleString('en-US') }}</b>
        <span class="upt-title-sub">
          / {{ props.rawData.length.toLocaleString('en-US') }} records
        </span>
      </div>
      <div class="upt-hint">Click vào id user để xem luồng riêng · Click cột để sort</div>
    </div>

    <div
      class="upt-table-wrap"
      :class="{ 'upt-table-wrap--loading': props.loading }"
      :style="{ height: VIEWPORT_HEIGHT + 40 + 'px' }"
    >
      <div v-if="props.loading" class="upt-loading-overlay">
        <div class="upt-spinner"></div>
        <div class="upt-loading-text">Đang tải bảng…</div>
      </div>
      <!-- Empty state cho table -->
      <div
        v-else-if="sortedRows.length === 0"
        class="upt-empty-state"
      >
        <div class="upt-empty-illu">🗒️</div>
        <div class="upt-empty-title">Không có record nào</div>
        <div class="upt-empty-desc">
          Query đã chạy nhưng không trả về user nào trong khoảng thời gian +
          môi trường + limit hiện tại. Thử mở rộng range hoặc đổi env trên
          thanh công cụ.
        </div>
      </div>
      <!-- Scroll ngang chung cho header + body (header sticky top) -->
      <div v-else class="upt-scroll-x">
        <!-- Header row (sticky) -->
        <div class="upt-thead" :style="{ width: totalWidth + 'px' }">
          <div
            v-for="col in columns"
            :key="col.key"
            class="upt-th"
            :class="{
              'upt-th--num': col.align === 'right',
              'upt-th--nosort': col.type === 'index',
            }"
            :style="{ width: col.width + 'px' }"
            @click="col.type !== 'index' && toggleSort(col.key)"
          >
            <span>{{ col.label }}</span>
            <span
              v-if="col.hint"
              class="upt-th-hint"
              :title="col.hint"
              @click.stop
            >ⓘ</span>
            <span class="upt-sort" v-if="sortKey === col.key">
              {{ sortDir === 'asc' ? '▲' : '▼' }}
            </span>
          </div>
        </div>

        <!-- Body — virtual scroll dọc -->
        <div
          class="upt-body"
          :style="{ height: VIEWPORT_HEIGHT + 'px', width: totalWidth + 'px' }"
          @scroll="onScroll"
        >
          <div :style="{ height: totalHeight + 'px', width: totalWidth + 'px', position: 'relative' }">
            <div :style="{ transform: `translateY(${topPadding}px)` }">
            <div
              v-for="{ row, index } in visibleRows"
              :key="index"
              class="upt-tr"
              :style="{ height: ROW_HEIGHT + 'px', width: totalWidth + 'px' }"
            >
              <div
                v-for="col in columns"
                :key="col.key"
                class="upt-td"
                :class="{
                  'upt-td--num': col.align === 'right',
                  'upt-td--focused': col.type === 'id' && row[col.key] === props.focusedUserId,
                }"
                :style="{ width: col.width + 'px' }"
              >
                <template v-if="col.type === 'index'">
                  <span class="upt-index">{{ (index + 1).toLocaleString('en-US') }}</span>
                </template>
                <template v-else-if="col.type === 'id'">
                  <span
                    class="upt-id"
                    :class="{ 'upt-id--focused': row[col.key] === props.focusedUserId }"
                    :title="`Click để xem luồng của ${row[col.key]}`"
                    @click="emit('focus-user', row[col.key])"
                  >
                    {{ row[col.key] || '—' }}
                  </span>
                  <div class="upt-id-actions" v-if="row[col.key]">
                    <span
                      class="upt-link"
                      title="Copy id"
                      @click.stop="copyId(row[col.key])"
                    >{{ copiedId === row[col.key] ? '✓' : '⧉' }}</span>
                    <a
                      v-if="canOpenPosthog && row.latest_session_id"
                      :href="replayUrl(row.latest_session_id)"
                      target="_blank"
                      rel="noopener"
                      class="upt-link"
                      title="Recording của session mới nhất"
                      @click.stop
                    >▶</a>
                    <a
                      v-if="canOpenPosthog && (row.distinct_id || row[col.key])"
                      :href="replayListUrl(row.distinct_id || row[col.key])"
                      target="_blank"
                      rel="noopener"
                      class="upt-link"
                      title="Danh sách recordings"
                      @click.stop
                    >📜</a>
                    <a
                      v-if="canOpenPosthog"
                      :href="personUrl(row.distinct_id || row[col.key])"
                      target="_blank"
                      rel="noopener"
                      class="upt-link"
                      title="Trang person"
                      @click.stop
                    >↗</a>
                  </div>
                </template>
                <template v-else-if="col.type === 'distinct'">
                  <span class="upt-distinct" :title="row[col.key] || ''">
                    {{ row[col.key] || '—' }}
                  </span>
                  <div class="upt-id-actions" v-if="row[col.key]">
                    <span
                      class="upt-link"
                      title="Copy distinct_id"
                      @click.stop="copyId(row[col.key])"
                    >{{ copiedId === row[col.key] ? '✓' : '⧉' }}</span>
                  </div>
                </template>
                <template v-else-if="col.type === 'journey'">
                  <button
                    class="upt-action-btn"
                    :disabled="!row[col.key]"
                    @click="openJourney(row)"
                  >
                    ▶ {{ (row.total_steps || (row[col.key] ? parseJourneySteps(row[col.key]).length : 0)).toLocaleString('en-US') }} bước
                  </button>
                </template>
                <template v-else>
                  {{ formatCell(row[col.key], col.type) }}
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div><!-- end .upt-scroll-x -->
    </div>

    <!-- Journey modal: hiển thị full_journey dạng timeline -->
    <div v-if="journeyModal.visible" class="upt-modal-backdrop" @click.self="closeJourney">
      <div class="upt-modal">
        <div class="upt-modal-header">
          <div class="upt-modal-title">
            <div class="upt-modal-title-main">Hành trình user</div>
            <div class="upt-modal-title-id">{{ journeyModal.userId }}</div>
          </div>
          <div class="upt-modal-stats">
            <span><b>{{ journeyModal.steps.length.toLocaleString('en-US') }}</b> bước</span>
            <span v-if="journeyModal.duration != null">·
              <b>{{ Number(journeyModal.duration).toLocaleString('en-US') }}</b> phút
            </span>
          </div>
          <div class="upt-modal-actions">
            <button class="upt-action-btn" @click="copyJourney">
              {{ journeyCopied ? '✓ Đã copy' : '⧉ Copy' }}
            </button>
            <a
              v-if="canOpenPosthog && journeyModal.sessionId"
              :href="replayUrl(journeyModal.sessionId)"
              target="_blank"
              rel="noopener"
              class="upt-action-btn"
              title="Recording của session mới nhất"
            >▶ Latest</a>
            <a
              v-if="canOpenPosthog && journeyModal.distinctId"
              :href="replayListUrl(journeyModal.distinctId)"
              target="_blank"
              rel="noopener"
              class="upt-action-btn"
              title="Danh sách tất cả recordings"
            >📜 List</a>
            <button class="upt-modal-close" @click="closeJourney">×</button>
          </div>
        </div>
        <div class="upt-modal-body">
          <div
            v-for="(s, i) in journeyModal.steps"
            :key="i"
            class="upt-journey-step"
          >
            <div class="upt-journey-num">{{ String(i + 1).padStart(2, '0') }}</div>
            <div class="upt-journey-content">
              <div class="upt-journey-event">{{ s.event }}</div>
              <div class="upt-journey-time" v-if="s.time">{{ s.time }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.upt-root {
  border-top: 1px solid #e5e7eb;
  background: #fff;
}
.upt-header {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 14px 24px 8px;
}
.upt-title { font-size: 14px; font-weight: 600; color: #111827; }
.upt-title b { color: #4338ca; }
.upt-title-sub { font-weight: 400; color: #6b7280; margin-left: 2px; }
.upt-hint { font-size: 12px; color: #6b7280; }

.upt-index {
  font-variant-numeric: tabular-nums;
  color: #9ca3af;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.upt-th--nosort { cursor: default; }
.upt-th--nosort:hover { background: #f9fafb; }

.upt-table-wrap {
  margin: 0 24px 24px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
.upt-table-wrap--loading .upt-body,
.upt-table-wrap--loading .upt-thead { opacity: 0.3; pointer-events: none; }

.upt-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(2px);
  z-index: 5;
}
.upt-loading-text { font-size: 12px; color: #4338ca; font-weight: 500; }

.upt-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 40px 24px;
}
.upt-empty-illu { font-size: 48px; line-height: 1; }
.upt-empty-title { font-size: 15px; font-weight: 600; color: #111827; }
.upt-empty-desc {
  font-size: 13px;
  color: #6b7280;
  max-width: 460px;
  line-height: 1.55;
}
.upt-spinner {
  width: 26px; height: 26px;
  border: 3px solid #e0e7ff;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: upt-spin 0.7s linear infinite;
}
@keyframes upt-spin {
  to { transform: rotate(360deg); }
}

/* Cuộn ngang chỉ cho body, header sync bằng cách dùng cùng width container */
/* Wrapper scroll ngang cho cả header + body */
.upt-scroll-x {
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
}
.upt-thead {
  display: flex;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  font-size: 12px; font-weight: 600;
  color: #374151;
  user-select: none;
  position: sticky; top: 0; z-index: 1;
}
.upt-th {
  display: flex; align-items: center; gap: 4px;
  padding: 10px 12px;
  cursor: pointer;
  white-space: nowrap;
  border-right: 1px solid #f3f4f6;
}
.upt-th:last-child { border-right: none; }
.upt-th:hover { background: #f3f4f6; }
.upt-th--num { justify-content: flex-end; text-align: right; }
.upt-sort { color: #6366f1; font-size: 10px; }
.upt-th-hint {
  color: #9ca3af;
  font-size: 12px;
  cursor: help;
  user-select: none;
  transition: color 0.12s;
}
.upt-th-hint:hover { color: #4338ca; }

.upt-body {
  overflow-x: hidden;
  overflow-y: auto;
  flex: 1;
}

.upt-tr {
  display: flex;
  border-bottom: 1px solid #f3f4f6;
  font-size: 13px;
  color: #374151;
}
.upt-tr:hover { background: #fafbfc; }
.upt-tr:hover .upt-id-actions { opacity: 1; }

.upt-td {
  padding: 0 12px;
  display: flex; align-items: center;
  white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  border-right: 1px solid #f9fafb;
  gap: 6px;
}
.upt-td:last-child { border-right: none; }
.upt-td--num { justify-content: flex-end; font-variant-numeric: tabular-nums; }

.upt-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #4338ca;
  cursor: pointer;
  overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0;
}
.upt-id:hover { text-decoration: underline; }
.upt-id--focused {
  font-weight: 700;
  color: #312e81;
}
.upt-td--focused { background: #eef2ff; }
.upt-distinct {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #111827;
  overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0;
}
.upt-id-actions {
  display: flex; align-items: center; gap: 6px;
  opacity: 0; transition: opacity 0.12s;
  flex-shrink: 0;
}
.upt-link {
  color: #6366f1; text-decoration: none;
  font-size: 12px;
}
.upt-link:hover { color: #4f46e5; }
.upt-copy {
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
}
.upt-copy--ok { color: #059669; }

.upt-action-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px;
  border: 1px solid #c7d2fe;
  background: #eef2ff;
  border-radius: 4px;
  font-size: 11px;
  color: #4338ca;
  cursor: pointer;
  text-decoration: none;
  font-family: inherit;
}
.upt-action-btn:hover:not(:disabled) {
  background: #c7d2fe;
}
.upt-action-btn:disabled {
  background: #f3f4f6;
  color: #9ca3af;
  border-color: #e5e7eb;
  cursor: not-allowed;
}

/* ---- Journey modal ---- */
.upt-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 2000;
  padding: 24px;
}
.upt-modal {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 640px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.upt-modal-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid #e5e7eb;
  background: #fafbfc;
  flex-wrap: wrap;
}
.upt-modal-title { min-width: 0; flex: 1; }
.upt-modal-title-main {
  font-size: 14px; font-weight: 600; color: #111827;
}
.upt-modal-title-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #6b7280;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.upt-modal-stats {
  font-size: 12px; color: #374151;
  display: flex; gap: 6px;
}
.upt-modal-actions {
  display: flex; align-items: center; gap: 6px;
}
.upt-modal-close {
  border: none; background: transparent;
  font-size: 22px; line-height: 1;
  color: #6b7280; cursor: pointer;
  padding: 0 6px;
}
.upt-modal-close:hover { color: #111827; }

.upt-modal-body {
  overflow-y: auto;
  padding: 12px 18px 18px;
  flex: 1;
}

.upt-journey-step {
  display: flex; gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  position: relative;
}
.upt-journey-step:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 24px; top: 38px; bottom: -8px;
  width: 2px;
  background: #e5e7eb;
}
.upt-journey-step:hover { background: #f9fafb; }
.upt-journey-num {
  width: 28px; height: 28px;
  border-radius: 50%;
  background: #eef2ff;
  color: #4338ca;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
  flex-shrink: 0;
  z-index: 1;
}
.upt-journey-content { flex: 1; min-width: 0; }
.upt-journey-event {
  font-size: 13px; font-weight: 500;
  color: #111827;
  word-break: break-word;
}
.upt-journey-time {
  font-size: 11px; color: #6b7280;
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
