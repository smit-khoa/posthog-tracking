<script setup>
import { computed, ref } from "vue";
import { WHALES_CONSTANTS } from "../composables/extract-whales.js";

// Component thông báo "khách sộp" — hiện trên đầu UserPathsTable.
// Props:
//   - whales: mảng đã được extractWhales() lọc sẵn
// Events:
//   - focus-user: emit person_id khi user click vào tên — App sẽ focus chart như flow cũ

const props = defineProps({
  whales: { type: Array, default: () => [] },
});
const emit = defineEmits(["focus-user"]);

// PostHog deep-link helpers — đồng nhất với user-paths-table.vue
const POSTHOG_HOST = (
  import.meta.env.VITE_POSTHOG_HOST || "https://us.posthog.com"
).replace(/\/$/, "");
const POSTHOG_PROJECT_ID = import.meta.env.VITE_POSTHOG_PROJECT_ID || "";
const canOpenPosthog = !!POSTHOG_PROJECT_ID;

function personUrl(id) {
  if (!canOpenPosthog || !id) return "#";
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/person/${encodeURIComponent(id)}`;
}
function replayUrl(sessionId) {
  if (!canOpenPosthog || !sessionId) return "";
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/replay/${encodeURIComponent(sessionId)}`;
}

function formatMoney(v) {
  if (!Number.isFinite(v)) return "—";
  // Hiển thị gọn: tỉ / triệu — dễ scan trong card
  if (v >= 1000000000)
    return `${(v / 1000000000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tỉ`;
  if (v >= 1000000)
    return `${(v / 1000000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu`;
  return v.toLocaleString("vi-VN");
}

// Quyết định nội dung cột Spend trong card:
//   - Nếu total_spend > 0: hiển thị giá trị tiền thật
//   - Nếu chỉ có spend_range (declared lúc tạo doanh nghiệp, chưa có giao dịch):
//     hiển thị '>100' + chú thích "từ tạo doanh nghiệp" để phân biệt với spend thực
function spendDisplay(w) {
  const real = Number(w?.total_spend);
  if (Number.isFinite(real) && real > 0) {
    return { value: formatMoney(real), note: "", isDeclared: false };
  }
  if (w?.spend_range) {
    return {
      value: w.spend_range,
      note: "từ tạo doanh nghiệp",
      isDeclared: true,
    };
  }
  return { value: "—", note: "", isDeclared: false };
}

const collapsed = ref(false);
const copiedId = ref("");

async function copyId(id) {
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = id;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {}
    document.body.removeChild(ta);
  }
  copiedId.value = id;
  setTimeout(() => {
    if (copiedId.value === id) copiedId.value = "";
  }, 1200);
}

// Tổng spend chỉ cộng các user có total_spend thực (> 0), bỏ qua user
// chỉ có spend_range declared — vì không phải con số tiền thật.
const totalSpend = computed(() =>
  props.whales.reduce((sum, w) => {
    const s = Number(w.total_spend);
    return sum + (Number.isFinite(s) && s > 0 ? s : 0);
  }, 0),
);

// Đếm số user "đã chi tiêu thật" (total_spend > 0) vs "chỉ declared"
const realSpendCount = computed(
  () => props.whales.filter((w) => Number(w.total_spend) > 0).length,
);
const declaredOnlyCount = computed(
  () => props.whales.length - realSpendCount.value,
);
</script>

<template>
  <div v-if="whales.length > 0" class="wha-root">
    <div class="wha-header" @click="collapsed = !collapsed">
      <div class="wha-title">
        <span class="wha-icon">💎</span>
        <span class="wha-title-text">
          Phát hiện <b>{{ whales.length }}</b> khách "sộp" cần theo dõi
        </span>
        <span
          v-if="realSpendCount > 0"
          class="wha-sum"
          :title="`Tổng spend thực của ${realSpendCount} user có total_spend > 0`"
        >
          · Tổng spend ~ <b>{{ formatMoney(totalSpend) }}</b>
          <span v-if="realSpendCount !== whales.length" class="wha-sum-detail">
            ({{ realSpendCount }} đã chi · {{ declaredOnlyCount }} chỉ declared)
          </span>
        </span>
        <span
          v-else
          class="wha-sum wha-sum--declared"
          :title="`${whales.length} user chỉ có spend_range declared, chưa có giao dịch thật`"
        >
          · <b>{{ declaredOnlyCount }}</b> user chỉ declared
        </span>
      </div>
      <button class="wha-toggle" :title="collapsed ? 'Mở' : 'Thu gọn'">
        {{ collapsed ? "▼" : "▲" }}
      </button>
    </div>

    <div class="wha-hint" v-if="!collapsed">
      Tiêu chí:
      <code>spend_range = '{{ WHALES_CONSTANTS.SPEND_RANGE_FLAG }}'</code> hoặc
      <code
        >total_spend &gt;
        {{ WHALES_CONSTANTS.SPEND_THRESHOLD.toLocaleString("vi-VN") }}</code
      >
      (đọc từ properties của event). Click tên user để focus luồng trong chart
      bên trên.
    </div>

    <div v-if="!collapsed" class="wha-grid">
      <div
        v-for="w in whales"
        :key="w.person_id || w.distinct_id"
        class="wha-card"
        @click="emit('focus-user', w.person_id)"
      >
        <div class="wha-card-top">
          <div class="wha-card-name" :title="w.distinct_id">
            {{ w.distinct_id || w.person_id || "—" }}
          </div>
          <span class="wha-badge" v-if="w.spend_range">{{
            w.spend_range
          }}</span>
        </div>

        <div class="wha-spend">
          <span class="wha-spend-label">Spend</span>
          <span
            class="wha-spend-value"
            :class="{ 'wha-spend-value--declared': spendDisplay(w).isDeclared }"
            >{{ spendDisplay(w).value }}</span
          >
          <span v-if="spendDisplay(w).note" class="wha-spend-note">
            ({{ spendDisplay(w).note }})
          </span>
        </div>

        <div class="wha-meta">
          <span v-if="w.user_status">{{ w.user_status }}</span>
          <span v-if="w.total_steps != null">· {{ w.total_steps }} bước</span>
        </div>

        <div class="wha-reasons">
          <span v-for="r in w.reasons" :key="r" class="wha-reason">{{
            r
          }}</span>
        </div>

        <div class="wha-actions" @click.stop>
          <button
            class="wha-link"
            :title="copiedId === w.distinct_id ? 'Đã copy' : 'Copy distinct_id'"
            @click="copyId(w.distinct_id || w.person_id)"
          >
            {{
              copiedId === (w.distinct_id || w.person_id)
                ? "✓ Copied"
                : "⧉ Copy"
            }}
          </button>
          <a
            v-if="canOpenPosthog && w.latest_session_id"
            :href="replayUrl(w.latest_session_id)"
            target="_blank"
            rel="noopener"
            class="wha-link"
            title="Recording session mới nhất"
            >▶ Replay</a
          >
          <a
            v-if="canOpenPosthog"
            :href="personUrl(w.distinct_id || w.person_id)"
            target="_blank"
            rel="noopener"
            class="wha-link"
            title="Trang person trên PostHog"
            >↗ Person</a
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wha-root {
  margin: 12px 24px 0;
  border: 1px solid #fcd34d;
  background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(217, 119, 6, 0.08);
}
.wha-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  gap: 12px;
}
.wha-header:hover {
  background: rgba(252, 211, 77, 0.18);
}
.wha-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #78350f;
  flex-wrap: wrap;
}
.wha-icon {
  font-size: 18px;
}
.wha-title-text b {
  color: #92400e;
}
.wha-sum {
  color: #92400e;
  font-size: 13px;
}
.wha-toggle {
  border: none;
  background: transparent;
  color: #92400e;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
}

.wha-hint {
  padding: 0 16px 8px;
  font-size: 12px;
  color: #92400e;
  line-height: 1.6;
}
.wha-hint code {
  background: rgba(146, 64, 14, 0.1);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}

.wha-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
  padding: 4px 16px 16px;
}
.wha-card {
  background: #fff;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s,
    transform 0.12s;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wha-card:hover {
  border-color: #f59e0b;
  box-shadow: 0 4px 12px rgba(217, 119, 6, 0.15);
  transform: translateY(-1px);
}

.wha-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.wha-card-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #111827;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wha-badge {
  font-size: 11px;
  font-weight: 700;
  color: #92400e;
  background: #fde68a;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

.wha-spend {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.wha-spend-label {
  font-size: 11px;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.wha-spend-value {
  font-size: 18px;
  font-weight: 700;
  color: #b45309;
  font-variant-numeric: tabular-nums;
}
/* Spend declared (chưa có giao dịch thật) — xám nhạt + font nhỏ hơn để phân biệt */
.wha-spend-value--declared {
  font-size: 14px;
  color: #6b7280;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.wha-spend-note {
  font-size: 11px;
  color: #9ca3af;
  font-style: italic;
}

.wha-sum-detail {
  font-size: 11px;
  color: #92400e;
  font-weight: 400;
}
.wha-sum--declared {
  color: #78350f;
}

.wha-meta {
  font-size: 12px;
  color: #4b5563;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.wha-reasons {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.wha-reason {
  font-size: 10px;
  color: #78350f;
  background: #fef3c7;
  border: 1px solid #fde68a;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.wha-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  border-top: 1px dashed #fde68a;
  padding-top: 8px;
}
.wha-link {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fde68a;
  padding: 3px 8px;
  border-radius: 4px;
  text-decoration: none;
  cursor: pointer;
  font-family: inherit;
}
.wha-link:hover {
  background: #fde68a;
  border-color: #f59e0b;
}
</style>
