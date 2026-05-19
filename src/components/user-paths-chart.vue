<script setup>
import {
  computed,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";

const props = defineProps({
  rawData: { type: Array, required: true },
  loading: { type: Boolean, default: false },
});

const dedup = ref(true);
const maxSteps = ref(50);
const topN = ref(10);
const cardWidth = ref(220);
const columnGap = ref(80); // khoảng cách trống giữa cuối card cột trước → bar cột sau

// Tuỳ chỉnh — danh sách event bị ẩn (loại khỏi journeys trước khi build graph)
const hiddenEvents = ref(new Set());
const showCustomize = ref(false);
const customizeSearch = ref("");

// ---- Presets: lưu/load danh sách event đã ẩn vào localStorage ----
const PRESETS_KEY = "user-paths-viewer:hidden-events-presets";
const ACTIVE_PRESET_KEY = "user-paths-viewer:hidden-events-active";

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
const presets = ref(loadPresets()); // { name: [event, ...] }
const activePresetName = ref(localStorage.getItem(ACTIVE_PRESET_KEY) || "");

// Tự động restore preset đang active khi load lại trang
if (activePresetName.value && presets.value[activePresetName.value]) {
  hiddenEvents.value = new Set(presets.value[activePresetName.value]);
}

function persistPresets() {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets.value));
  } catch {}
}
function setActivePreset(name) {
  activePresetName.value = name;
  try {
    if (name) localStorage.setItem(ACTIVE_PRESET_KEY, name);
    else localStorage.removeItem(ACTIVE_PRESET_KEY);
  } catch {}
}

function savePreset() {
  const suggestion =
    activePresetName.value || `Preset ${Object.keys(presets.value).length + 1}`;
  const name = window.prompt("Tên preset:", suggestion);
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (
    presets.value[trimmed] &&
    !window.confirm(`Preset "${trimmed}" đã tồn tại. Ghi đè?`)
  )
    return;
  presets.value = {
    ...presets.value,
    [trimmed]: Array.from(hiddenEvents.value),
  };
  persistPresets();
  setActivePreset(trimmed);
}

function loadPreset(name) {
  const list = presets.value[name];
  if (!list) return;
  hiddenEvents.value = new Set(list);
  setActivePreset(name);
}

function deletePreset(name) {
  if (!window.confirm(`Xoá preset "${name}"?`)) return;
  const next = { ...presets.value };
  delete next[name];
  presets.value = next;
  persistPresets();
  if (activePresetName.value === name) setActivePreset("");
}

const presetNames = computed(() => Object.keys(presets.value).sort());

const tooltip = ref({ visible: false, x: 0, y: 0, html: "" });

// Hover state — node được hover, dùng để highlight downstream
const hoveredNode = ref(null); // { stepIdx, name } | null

// Popover state — khi click vào step card
// visible: pin highlight (luôn true khi click bar/card)
// showList: hiển thị UI popover (chỉ true khi click card)
const popover = ref({
  visible: false,
  showList: false,
  x: 0,
  y: 0,
  stepIdx: 0,
  name: "",
  userIds: [],
});

// PostHog link helpers — đọc từ env, fallback an toàn
const POSTHOG_HOST = (
  import.meta.env.VITE_POSTHOG_HOST || "https://us.posthog.com"
).replace(/\/$/, "");
const POSTHOG_PROJECT_ID = import.meta.env.VITE_POSTHOG_PROJECT_ID || "";
const canOpenPosthog = !!POSTHOG_PROJECT_ID;

function personUrl(id) {
  if (!canOpenPosthog) return "#";
  const lookupId = personIdToDistinctId.value.get(id) || id;
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/person/${encodeURIComponent(lookupId)}`;
}
// Replay session cụ thể: /replay/{session_id}
function replayUrl(personId) {
  if (!canOpenPosthog) return "#";
  const sid = personIdToSessionId.value.get(personId);
  if (!sid) return "";
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/replay/${encodeURIComponent(sid)}`;
}
// Replay list của user — dùng person page tab sessionRecordings (PostHog tự load đúng list)
function replayListUrl(personId) {
  if (!canOpenPosthog) return "#";
  const did = personIdToDistinctId.value.get(personId) || personId;
  return `${POSTHOG_HOST}/project/${POSTHOG_PROJECT_ID}/person/${encodeURIComponent(did)}?activeTab=sessionRecordings`;
}

// Map person_id (UI display) → { distinct_id, session_id } cho URL
const personIdToDistinctId = computed(() => {
  const map = new Map();
  props.rawData.forEach((u) => {
    const pid = u.person_id || u.distinct_id || u.user_id;
    const did = u.distinct_id || u.person_id || u.user_id;
    if (pid) map.set(pid, did);
  });
  return map;
});
const personIdToSessionId = computed(() => {
  const map = new Map();
  props.rawData.forEach((u) => {
    const pid = u.person_id || u.distinct_id || u.user_id;
    const sid = u.latest_session_id || u.session_id;
    if (pid && sid) map.set(pid, sid);
  });
  return map;
});
const popoverSearch = ref("");
const copiedId = ref(null);
const copiedAll = ref(false);

// Map event_props_raw → object { eventName: [propsObj, ...] }
// PostHog trả tuple [eventName, propertiesJsonString].
// Properties có thể bị double-encoded (toJSONString + JSON response wrap),
// nên parse loop tới khi ra object thật (max 3 lần phòng infinite loop).
function buildUserEventProps(rawList) {
  const out = {};
  if (!Array.isArray(rawList)) return out;
  rawList.forEach((tuple) => {
    if (!Array.isArray(tuple) || tuple.length < 2) return;
    const [eventName, rawProps] = tuple;
    if (!eventName) return;
    let props = rawProps;
    for (let i = 0; i < 3 && typeof props === "string"; i++) {
      try {
        props = JSON.parse(props);
      } catch {
        return;
      }
    }
    if (!props || typeof props !== "object") return;
    // Lọc bỏ key system ($...)
    const clean = {};
    Object.keys(props).forEach((k) => {
      if (k.startsWith("$")) return;
      clean[k] = props[k];
    });
    if (Object.keys(clean).length === 0) return;
    if (!out[eventName]) out[eventName] = [];
    out[eventName].push(clean);
  });
  return out;
}

// ---- Parse journeys ----
// Trả về [{ personId, steps, eventProps }] — eventProps là object dynamic theo event
// Nếu `endStep` truyền vào → chỉ giữ user có chạm endStep, truncate chuỗi tại vị trí đó
function parseJourneys(data, dedupFlag, hidden, endStep) {
  const journeys = [];
  data.forEach((user, idx) => {
    const personId =
      user.person_id || user.distinct_id || user.user_id || `user-${idx}`;
    if (!user.full_journey) return;

    let steps = user.full_journey
      .split(" → ")
      .map((step) => {
        const parts = step.split("\n");
        return parts.length > 1 ? parts[1].trim() : step.trim();
      })
      .reverse();

    if (hidden && hidden.size > 0) {
      steps = steps.filter((s) => !hidden.has(s));
    }

    if (dedupFlag) {
      const out = [];
      steps.forEach((s) => {
        if (out.length === 0 || out[out.length - 1] !== s) out.push(s);
      });
      steps = out;
    }

    // End step filter: cắt journey tại lần xuất hiện đầu tiên của endStep (inclusive)
    if (endStep) {
      const endIdx = steps.indexOf(endStep);
      if (endIdx === -1) return; // user không có endStep → bỏ qua hoàn toàn
      steps = steps.slice(0, endIdx + 1);
    }

    journeys.push({
      personId,
      steps,
      eventProps: buildUserEventProps(user.event_props_raw),
    });
  });
  return journeys;
}

// Map: personId → eventProps (để lookup nhanh khi click node)
const personIdToEventProps = computed(() => {
  const map = new Map();
  props.rawData.forEach((u, idx) => {
    const pid = u.person_id || u.distinct_id || u.user_id || `user-${idx}`;
    map.set(pid, buildUserEventProps(u.event_props_raw));
  });
  return map;
});

// Danh sách tất cả event xuất hiện trong data (không lọc hidden) — dùng cho panel tuỳ chỉnh
const allEvents = computed(() => {
  const map = new Map(); // name -> count
  props.rawData.forEach((u) => {
    if (!u.full_journey) return;
    u.full_journey.split(" → ").forEach((s) => {
      const parts = s.split("\n");
      const name = parts.length > 1 ? parts[1].trim() : s.trim();
      map.set(name, (map.get(name) || 0) + 1);
    });
  });
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
});

const filteredEvents = computed(() => {
  const q = customizeSearch.value.trim().toLowerCase();
  if (!q) return allEvents.value;
  return allEvents.value.filter((e) => e.name.toLowerCase().includes(q));
});

function toggleEvent(name) {
  const s = new Set(hiddenEvents.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  hiddenEvents.value = s;
}
function showAllEvents() {
  hiddenEvents.value = new Set();
}
function hideAllFiltered() {
  const s = new Set(hiddenEvents.value);
  filteredEvents.value.forEach((e) => s.add(e.name));
  hiddenEvents.value = s;
}

// ---- Build graph (kèm danh sách person_id cho từng node + link) ----
function buildGraph(journeys, max, top) {
  const stepCounts = []; // [stepIdx] -> Map(action -> { count, ids: Set })
  const linkData = {}; // key -> { count, ids: Set }

  journeys.forEach(({ personId, steps }) => {
    const trimmed = steps.slice(0, max);
    trimmed.forEach((action, idx) => {
      if (!stepCounts[idx]) stepCounts[idx] = new Map();
      const entry = stepCounts[idx].get(action) || { count: 0, ids: new Set() };
      entry.count += 1;
      entry.ids.add(personId);
      stepCounts[idx].set(action, entry);
    });
    for (let i = 0; i < trimmed.length - 1; i++) {
      const key = `${i}|||${trimmed[i]}|||${trimmed[i + 1]}`;
      const entry = linkData[key] || { count: 0, ids: new Set() };
      entry.count += 1;
      entry.ids.add(personId);
      linkData[key] = entry;
    }
  });

  const stepNodes = stepCounts.map((m, stepIdx) =>
    Array.from(m.entries())
      .map(([name, { count, ids }]) => ({
        stepIdx,
        name,
        count,
        userIds: Array.from(ids),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
  );

  const visibleNames = stepNodes.map((arr) => new Set(arr.map((n) => n.name)));
  const links = [];
  Object.keys(linkData).forEach((key) => {
    const [stepStr, src, tgt] = key.split("|||");
    const step = parseInt(stepStr, 10);
    if (
      visibleNames[step] &&
      visibleNames[step + 1] &&
      visibleNames[step].has(src) &&
      visibleNames[step + 1].has(tgt)
    ) {
      const { count, ids } = linkData[key];
      links.push({
        step,
        source: src,
        target: tgt,
        value: count,
        userIds: ids,
      });
    }
  });

  return { stepNodes, links };
}

const layout = computed(() => {
  const journeys = parseJourneys(
    props.rawData,
    dedup.value,
    hiddenEvents.value,
    endStepName.value,
  );
  const { stepNodes, links } = buildGraph(journeys, maxSteps.value, topN.value);

  const NODE_WIDTH = 14;
  const CARD_WIDTH = cardWidth.value;
  // COLUMN_WIDTH = bar + 8px gap + card + columnGap (khoảng trống cho dải nối)
  const COLUMN_WIDTH = NODE_WIDTH + 8 + CARD_WIDTH + columnGap.value;
  const CARD_HEIGHT = 44;
  const NODE_MIN_HEIGHT = 36;
  const NODE_GAP = 14;
  const PADDING_TOP = 24;
  const PADDING_LEFT = 24;
  const PADDING_RIGHT = 24;
  const PADDING_BOTTOM = 24;
  const AVAILABLE_HEIGHT = 520;

  const totalPerStep = stepNodes.map((arr) =>
    arr.reduce((s, n) => s + n.count, 0),
  );
  const maxTotal = Math.max(...totalPerStep, 1);
  const pixelsPerUser =
    (AVAILABLE_HEIGHT - NODE_GAP * (topN.value - 1)) / maxTotal;

  const nodeLayout = {};
  stepNodes.forEach((arr, stepIdx) => {
    let y = PADDING_TOP + CARD_HEIGHT + 12;
    arr.forEach((n) => {
      const h = Math.max(NODE_MIN_HEIGHT, n.count * pixelsPerUser);
      const x = PADDING_LEFT + stepIdx * COLUMN_WIDTH;
      nodeLayout[`${stepIdx}|${n.name}`] = {
        x,
        y,
        h,
        w: NODE_WIDTH,
        count: n.count,
        name: n.name,
        stepIdx,
        userIds: n.userIds,
      };
      y += h + NODE_GAP;
    });
  });

  // Ports allocation
  const outgoing = {};
  const incoming = {};
  links.forEach((l) => {
    const sk = `${l.step}|${l.source}`;
    const tk = `${l.step + 1}|${l.target}`;
    (outgoing[sk] = outgoing[sk] || []).push(l);
    (incoming[tk] = incoming[tk] || []).push(l);
  });
  Object.keys(outgoing).forEach((k) => {
    outgoing[k].sort((a, b) => {
      const ya = nodeLayout[`${a.step + 1}|${a.target}`]?.y ?? 0;
      const yb = nodeLayout[`${b.step + 1}|${b.target}`]?.y ?? 0;
      return ya - yb;
    });
  });
  Object.keys(incoming).forEach((k) => {
    incoming[k].sort((a, b) => {
      const ya = nodeLayout[`${a.step}|${a.source}`]?.y ?? 0;
      const yb = nodeLayout[`${b.step}|${b.source}`]?.y ?? 0;
      return ya - yb;
    });
  });

  const linkGeom = [];
  links.forEach((l) => {
    const src = nodeLayout[`${l.step}|${l.source}`];
    const tgt = nodeLayout[`${l.step + 1}|${l.target}`];
    if (!src || !tgt) return;

    const outs = outgoing[`${l.step}|${l.source}`];
    const totalOutValue = outs.reduce((s, x) => s + x.value, 0);
    const srcScale = src.h / Math.max(1, totalOutValue);
    let yAcc = 0;
    let y1 = src.y;
    for (const o of outs) {
      const t = o.value * srcScale;
      if (o === l) {
        y1 = src.y + yAcc + t / 2;
        break;
      }
      yAcc += t;
    }
    const srcThickness = l.value * srcScale;

    const ins = incoming[`${l.step + 1}|${l.target}`];
    const totalInValue = ins.reduce((s, x) => s + x.value, 0);
    const tgtScale = tgt.h / Math.max(1, totalInValue);
    let yAcc2 = 0;
    let y2 = tgt.y;
    for (const i of ins) {
      const t = i.value * tgtScale;
      if (i === l) {
        y2 = tgt.y + yAcc2 + t / 2;
        break;
      }
      yAcc2 += t;
    }
    const tgtThickness = l.value * tgtScale;

    linkGeom.push({
      link: l,
      x1: src.x + src.w,
      y1,
      x2: tgt.x,
      y2,
      srcThickness,
      tgtThickness,
    });
  });

  const nodes = Object.values(nodeLayout);
  const maxColumnHeight = Math.max(
    ...nodes.map((n) => n.y + n.h),
    PADDING_TOP + CARD_HEIGHT + 60,
  );

  // totalW = padding trái + (n-1) cột + bar + gap 8 + card cuối + padding phải
  const totalW =
    PADDING_LEFT +
    Math.max(0, stepNodes.length - 1) * COLUMN_WIDTH +
    NODE_WIDTH +
    8 +
    CARD_WIDTH +
    PADDING_RIGHT;
  const totalH = maxColumnHeight + PADDING_BOTTOM;

  return {
    nodes,
    linkGeom,
    totalW,
    totalH,
    CARD_WIDTH,
    CARD_HEIGHT,
  };
});

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// Active node = node được click (pinned) hoặc node đang hover
// Pin có ưu tiên: khi popover đang mở, hover chỉ là gợi ý tạm, vẫn giữ highlight pin
const activeNode = computed(() => {
  if (popover.value.visible) {
    return { stepIdx: popover.value.stepIdx, name: popover.value.name };
  }
  return hoveredNode.value;
});

// ---- Hover/pin highlight: từ active node, trace downstream theo userIds ----
// Trả về { activeNodes: Set, activeLinks: Set, activeUserIds: Set } để CSS-class
const highlight = computed(() => {
  const empty = {
    activeNodes: new Set(),
    activeLinks: new Set(),
    upstreamNodes: new Set(),
    upstreamLinks: new Set(),
    activeUserIds: new Set(),
  };
  if (!activeNode.value) return empty;

  const { stepIdx, name } = activeNode.value;
  const startKey = `${stepIdx}|${name}`;
  const startNode = layout.value.nodes.find(
    (n) => `${n.stepIdx}|${n.name}` === startKey,
  );
  if (!startNode) return empty;

  const activeUserIds = new Set(startNode.userIds);
  // Downstream (đậm) — luôn gồm node được pin
  const activeNodes = new Set([startKey]);
  const activeLinks = new Set();
  // Upstream (nhạt) — KHÔNG gồm node pin để giữ nó là focal point
  const upstreamNodes = new Set();
  const upstreamLinks = new Set();

  // Helper: check link có chứa user của activeUserIds
  function linkSharesUser(link) {
    for (const id of link.userIds) {
      if (activeUserIds.has(id)) return true;
    }
    return false;
  }

  // Forward sweep: downstream
  let frontier = new Set([startKey]);
  while (frontier.size > 0) {
    const nextFrontier = new Set();
    layout.value.linkGeom.forEach((g) => {
      const { link } = g;
      const srcKey = `${link.step}|${link.source}`;
      const tgtKey = `${link.step + 1}|${link.target}`;
      if (!frontier.has(srcKey)) return;
      if (!linkSharesUser(link)) return;
      activeLinks.add(`${link.step}|${link.source}|${link.target}`);
      activeNodes.add(tgtKey);
      nextFrontier.add(tgtKey);
    });
    frontier = nextFrontier;
  }

  // Backward sweep: upstream — đi ngược từ node pin
  let backFrontier = new Set([startKey]);
  while (backFrontier.size > 0) {
    const nextFrontier = new Set();
    layout.value.linkGeom.forEach((g) => {
      const { link } = g;
      const srcKey = `${link.step}|${link.source}`;
      const tgtKey = `${link.step + 1}|${link.target}`;
      if (!backFrontier.has(tgtKey)) return;
      if (!linkSharesUser(link)) return;
      upstreamLinks.add(`${link.step}|${link.source}|${link.target}`);
      upstreamNodes.add(srcKey);
      nextFrontier.add(srcKey);
    });
    backFrontier = nextFrontier;
  }

  return {
    activeNodes,
    activeLinks,
    upstreamNodes,
    upstreamLinks,
    activeUserIds,
  };
});

// Trả về 'active' (đậm) | 'upstream' (nhạt) | 'dim' | null
function nodeState(n) {
  if (!activeNode.value) return null;
  const key = `${n.stepIdx}|${n.name}`;
  if (highlight.value.activeNodes.has(key)) return "active";
  if (highlight.value.upstreamNodes.has(key)) return "upstream";
  return "dim";
}
function linkState(g) {
  if (!activeNode.value) return null;
  const key = `${g.link.step}|${g.link.source}|${g.link.target}`;
  if (highlight.value.activeLinks.has(key)) return "active";
  if (highlight.value.upstreamLinks.has(key)) return "upstream";
  return "dim";
}

// Giữ lại helpers cũ (backward-compat) — để chỗ khác trong template không vỡ
function isNodeActive(n) {
  const state = nodeState(n);
  if (state === null) return null;
  return state === "active" || state === "upstream";
}

// ---- Stats cho node được pin (popover) ----
// - prev_step_total: tổng user của step trước (để tính % conversion từ prev)
// - first_step_total: tổng user của step 0
// - prev_breakdown: user đến node này từ những node nào ở step-1
// - dropoff: số user ở step-1 nhưng KHÔNG tiếp tục lên step này
// ---- Phân tích drop-off toàn biểu đồ ----
// Quét qua tất cả step, tìm những node có drop-off vs step trước > threshold.
// Mỗi entry: { stepIdx, name, count, prevTotal, dropPct, leaversTop, dropped }
const DROPOFF_THRESHOLD = 40;

const dropoffAlerts = computed(() => {
  const nodes = layout.value.nodes;
  const linkGeom = layout.value.linkGeom;
  if (nodes.length === 0) return [];

  function totalAtStep(idx) {
    return nodes
      .filter((n) => n.stepIdx === idx)
      .reduce((s, n) => s + n.count, 0);
  }

  const alerts = [];
  // Tính theo từng cột (step) — so total step với step trước
  const stepIndices = [...new Set(nodes.map((n) => n.stepIdx))].sort(
    (a, b) => a - b,
  );
  stepIndices.forEach((stepIdx) => {
    if (stepIdx === 0) return;
    const prevTotal = totalAtStep(stepIdx - 1);
    const currentTotal = totalAtStep(stepIdx);
    if (prevTotal === 0) return;
    const dropPct = ((prevTotal - currentTotal) / prevTotal) * 100;
    if (dropPct < DROPOFF_THRESHOLD) return;

    // Tìm node ở step-1 nào đóng góp drop-off lớn
    const prevNodes = nodes.filter((n) => n.stepIdx === stepIdx - 1);
    const sourceBreakdown = prevNodes
      .map((prevNode) => {
        // Tổng user của prevNode đã đi tiếp vào step hiện tại
        let continued = 0;
        const continuedSet = new Set();
        linkGeom.forEach((g) => {
          const l = g.link;
          if (l.step !== stepIdx - 1 || l.source !== prevNode.name) return;
          l.userIds.forEach((id) => continuedSet.add(id));
        });
        continued = continuedSet.size;
        const dropped = Math.max(0, prevNode.count - continued);
        return {
          source: prevNode.name,
          totalAtSource: prevNode.count,
          continuedCount: continued,
          droppedCount: dropped,
          dropPct: prevNode.count > 0 ? (dropped / prevNode.count) * 100 : 0,
        };
      })
      .filter((x) => x.droppedCount > 0)
      .sort((a, b) => b.droppedCount - a.droppedCount);

    alerts.push({
      stepIdx,
      prevTotal,
      currentTotal,
      dropped: prevTotal - currentTotal,
      dropPct,
      sourceBreakdown,
    });
  });
  return alerts.sort((a, b) => b.dropPct - a.dropPct);
});

const popoverStats = computed(() => {
  if (!popover.value.visible) return null;
  const { stepIdx, name, userIds } = popover.value;
  const nodes = layout.value.nodes;
  const linkGeom = layout.value.linkGeom;

  const userIdSet = new Set(userIds);
  const currentCount = userIds.length;

  // Total per step (đếm theo nodes hiển thị)
  function totalAtStep(idx) {
    return nodes
      .filter((n) => n.stepIdx === idx)
      .reduce((s, n) => s + n.count, 0);
  }
  const firstStepTotal = totalAtStep(0);
  const prevStepTotal = stepIdx > 0 ? totalAtStep(stepIdx - 1) : 0;

  // Tỷ lệ rơi rụng / chuyển đổi
  const pctFromStart =
    firstStepTotal > 0 ? (currentCount / firstStepTotal) * 100 : null;
  const pctFromPrev =
    prevStepTotal > 0 ? (currentCount / prevStepTotal) * 100 : null;
  const dropoffFromPrev = prevStepTotal > 0 ? prevStepTotal - currentCount : 0;
  const dropoffPctFromPrev =
    prevStepTotal > 0 ? (dropoffFromPrev / prevStepTotal) * 100 : null;

  // "Trước đó" — các link từ step-1 vào node hiện tại
  // Mỗi entry kèm userIds để hiển thị nhóm theo nguồn
  const prevBreakdown = [];
  const usersFromKnownSource = new Set();
  if (stepIdx > 0) {
    linkGeom.forEach((g) => {
      const l = g.link;
      if (l.step !== stepIdx - 1 || l.target !== name) return;
      const ids = Array.from(l.userIds || []);
      ids.forEach((id) => usersFromKnownSource.add(id));
      prevBreakdown.push({
        source: l.source,
        count: l.value,
        pct: currentCount > 0 ? (l.value / currentCount) * 100 : 0,
        userIds: ids,
      });
    });
    prevBreakdown.sort((a, b) => b.count - a.count);
  }

  // User không có nguồn ở step-1 (vì node nguồn bị ẩn do top-N, hoặc đây là step 0)
  const orphanUsers = userIds.filter((id) => !usersFromKnownSource.has(id));

  // ---- Drop-off analysis: user của bước N-1 ĐI ĐÂU thay vì vào node hiện tại ----
  // (Chỉ tính khi không phải step 0)
  let leaversOtherBranches = []; // [{ target, count, pct }]
  let leaversDropped = 0; // số user step-1 không xuất hiện ở step-N
  let dropoffSourcesBreakdown = []; // các node N-1 đóng góp drop-off lớn
  if (stepIdx > 0 && prevStepTotal > 0) {
    // Tập user ở step N-1 (theo nodes hiển thị)
    const prevUserIds = new Set();
    nodes
      .filter((n) => n.stepIdx === stepIdx - 1)
      .forEach((n) => n.userIds.forEach((id) => prevUserIds.add(id)));

    // Tập user ở step N (toàn bộ nodes hiển thị)
    const currentStepUserIds = new Set();
    nodes
      .filter((n) => n.stepIdx === stepIdx)
      .forEach((n) => n.userIds.forEach((id) => currentStepUserIds.add(id)));

    // Other branches: các node khác ở step N (cùng cột, khác node)
    const branchMap = new Map(); // target name -> Set<id>
    linkGeom.forEach((g) => {
      const l = g.link;
      if (l.step !== stepIdx - 1) return;
      if (l.target === name) return; // bỏ qua chính node hiện tại
      const ids = branchMap.get(l.target) || new Set();
      l.userIds.forEach((id) => ids.add(id));
      branchMap.set(l.target, ids);
    });
    leaversOtherBranches = Array.from(branchMap.entries())
      .map(([target, ids]) => ({
        target,
        count: ids.size,
        pct: prevStepTotal > 0 ? (ids.size / prevStepTotal) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // Dừng hẳn: user ở step N-1 nhưng KHÔNG có ở step N (mọi node)
    leaversDropped = Array.from(prevUserIds).filter(
      (id) => !currentStepUserIds.has(id),
    ).length;

    // Breakdown drop-off theo nguồn: ở mỗi node N-1, bao nhiêu user
    // tiếp tục vào node hiện tại vs rớt
    const prevNodesAtStep = nodes.filter((n) => n.stepIdx === stepIdx - 1);
    dropoffSourcesBreakdown = prevNodesAtStep
      .map((prevNode) => {
        const continuedIds =
          prevBreakdown.find((b) => b.source === prevNode.name)?.userIds || [];
        const continuedCount = continuedIds.length;
        const droppedCount = Math.max(0, prevNode.count - continuedCount);
        return {
          source: prevNode.name,
          totalAtSource: prevNode.count,
          continuedCount,
          droppedCount,
          dropPct:
            prevNode.count > 0 ? (droppedCount / prevNode.count) * 100 : 0,
        };
      })
      .filter((x) => x.droppedCount > 0)
      .sort((a, b) => b.droppedCount - a.droppedCount);
  }

  // ---- Heuristic insights theo tên event ----
  const insights = [];
  const lower = name.toLowerCase();
  if (
    lower.includes("thất bại") ||
    lower.includes("error") ||
    lower.includes("failed")
  ) {
    insights.push(
      "Event này biểu thị lỗi → drop-off cao là tự nhiên, nhưng cần giảm số lỗi.",
    );
  }
  if (
    lower.includes("login") ||
    lower.includes("đăng nhập") ||
    lower.includes("signup") ||
    lower.includes("đăng ký")
  ) {
    insights.push(
      "Bước auth thường rớt nhiều — kiểm tra form, social login, OTP delay.",
    );
  }
  if (
    lower.includes("giá") ||
    lower.includes("pricing") ||
    lower.includes("payment") ||
    lower.includes("thanh toán")
  ) {
    insights.push(
      "Bước giá / thanh toán nhạy cảm — xem giá, phương thức thanh toán, niềm tin.",
    );
  }
  if (lower.includes("onboarding") || lower.includes("intro")) {
    insights.push("Onboarding nên ngắn — giảm số bước, cho phép skip.");
  }
  if (lower.includes("đồng bộ") || lower.includes("sync")) {
    insights.push(
      "Đồng bộ chậm có thể khiến user bỏ — kiểm tra thời gian sync, có loading rõ ràng không.",
    );
  }

  return {
    currentCount,
    firstStepTotal,
    prevStepTotal,
    pctFromStart,
    pctFromPrev,
    dropoffFromPrev,
    dropoffPctFromPrev,
    prevBreakdown,
    orphanUsers,
    userIdSet,
    leaversOtherBranches,
    leaversDropped,
    dropoffSourcesBreakdown,
    insights,
  };
});

function fmtPct(v) {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

// Property keys luôn ẩn (nhạy cảm / không có giá trị phân tích)
const HIDDEN_PROP_KEYS = new Set(["token", "error_type", "error_message"]);

// Property keys luôn hiển thị như string (không aggregate dù value là số) — vd ID
const STRING_FORCED_KEYS = new Set([
  "business_id",
  "person_id",
  "distinct_id",
  "user_id",
  "profile_fbid",
  "fbid",
  "session_id",
]);

// ---- Properties stats cho node được pin (dynamic theo event) ----
// Trả về { records, stats, recordCount, reason? }
// `reason` được set khi không có stats để render → UI show message tương ứng.
const nodePropertiesStats = computed(() => {
  if (!popover.value.visible) return null;
  const { name: eventName, userIds } = popover.value;
  if (!userIds || userIds.length === 0) return null;

  const records = [];
  userIds.forEach((id) => {
    const eventProps = personIdToEventProps.value.get(id);
    if (!eventProps) return;
    const list = eventProps[eventName];
    if (!list) return;
    records.push(list[0]);
  });
  if (records.length === 0) {
    return { records: [], stats: [], recordCount: 0, reason: "no-records" };
  }

  // Discover keys (loại key bị ẩn)
  const keysSet = new Set();
  records.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (HIDDEN_PROP_KEYS.has(k)) return;
      keysSet.add(k);
    });
  });
  if (keysSet.size === 0) {
    return { records, stats: [], recordCount: records.length, reason: "no-keys" };
  }

  const stats = Array.from(keysSet)
    .map((key) => {
      const values = records
        .map((r) => r[key])
        .filter((v) => v != null && v !== "");
      if (values.length === 0) return { key, kind: "empty" };

      // Force string mode cho ID keys
      if (STRING_FORCED_KEYS.has(key)) {
        const freq = new Map();
        values.forEach((v) => {
          const k = String(v);
          freq.set(k, (freq.get(k) || 0) + 1);
        });
        const top = Array.from(freq.entries())
          .map(([value, count]) => ({
            value,
            count,
            pct: (count / values.length) * 100,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);
        return { key, kind: "string", count: values.length, top };
      }

      // Detect type tự động
      const nums = values
        .map((v) => (typeof v === "number" ? v : Number(v)))
        .filter((n) => Number.isFinite(n));
      const isNumeric = nums.length === values.length && values.length > 0;

      if (isNumeric) {
        const sum = nums.reduce((s, n) => s + n, 0);
        const avg = sum / nums.length;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        return { key, kind: "number", count: nums.length, sum, avg, min, max };
      }

      const freq = new Map();
      values.forEach((v) => {
        const k = String(v);
        freq.set(k, (freq.get(k) || 0) + 1);
      });
      const top = Array.from(freq.entries())
        .map(([value, count]) => ({
          value,
          count,
          pct: (count / values.length) * 100,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return { key, kind: "string", count: values.length, top };
    })
    .filter((s) => s.kind !== "empty");

  // Sort: business_id luôn đầu → các ID khác → number → còn lại
  const KEY_PRIORITY = [
    "business_id",
    "distinct_id",
    "person_id",
    "user_id",
    "profile_fbid",
    "fbid",
    "session_id",
  ];
  stats.sort((a, b) => {
    const ia = KEY_PRIORITY.indexOf(a.key);
    const ib = KEY_PRIORITY.indexOf(b.key);
    if (ia !== -1 || ib !== -1) {
      // Cả 2 có trong priority
      if (ia !== -1 && ib !== -1) return ia - ib;
      return ia !== -1 ? -1 : 1;
    }
    // Number trước string
    if (a.kind !== b.kind) return a.kind === "number" ? -1 : 1;
    return 0;
  });

  return { records, stats, recordCount: records.length };
});

// Format value của 1 property cell trong bảng chi tiết user
function formatPropValue(key, value) {
  if (value == null || value === "") return "—";
  if (STRING_FORCED_KEYS.has(key)) return String(value);
  const n = Number(value);
  if (Number.isFinite(n) && typeof value !== "boolean") {
    return n.toLocaleString("en-US");
  }
  return String(value);
}

// Format số gọn: 12345 → 12.3K, 1234567 → 1.23M
function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}

// Format số nguyên với phân tách hàng nghìn (1234567 → "1,234,567")
function fmtInt(n) {
  if (n == null) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString("en-US");
}

// Drop-off color scale: 0% = xanh (#10b981) → 20% = vàng/cam (#f59e0b) → 40%+ = đỏ (#dc2626)
// Trả về { bg, border, text } để inline style.
function dropoffColor(pct) {
  if (pct == null) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  let r, g, b;
  if (clamped <= 20) {
    const t = clamped / 20;
    // #10b981 → #f59e0b
    r = Math.round(16 + (245 - 16) * t);
    g = Math.round(185 + (158 - 185) * t);
    b = Math.round(129 + (11 - 129) * t);
  } else if (clamped <= 40) {
    const t = (clamped - 20) / 20;
    // #f59e0b → #dc2626
    r = Math.round(245 + (220 - 245) * t);
    g = Math.round(158 + (38 - 158) * t);
    b = Math.round(11 + (38 - 11) * t);
  } else {
    // 40%+ → đỏ
    r = 220;
    g = 38;
    b = 38;
  }
  const rgb = `${r}, ${g}, ${b}`;
  return {
    bg: `rgba(${rgb}, 0.08)`,
    border: `rgba(${rgb}, 0.45)`,
    text: `rgb(${rgb})`,
  };
}
function isLinkActive(g) {
  if (!activeNode.value) return null;
  return highlight.value.activeLinks.has(
    `${g.link.step}|${g.link.source}|${g.link.target}`,
  );
}

function onNodeEnter(node, e) {
  hoveredNode.value = { stepIdx: node.stepIdx, name: node.name };
  showTooltip(
    `<b>${fmtInt(node.count)}</b> user · Bước ${node.stepIdx + 1}<br>${node.name}`,
    e,
  );
}
function onNodeLeave() {
  hoveredNode.value = null;
  hideTooltip();
}

function linkPath(g) {
  const { x1, y1, x2, y2, srcThickness, tgtThickness } = g;
  const cx = (x1 + x2) / 2;
  const top = `M ${x1} ${y1 - srcThickness / 2} C ${cx} ${y1 - srcThickness / 2}, ${cx} ${y2 - tgtThickness / 2}, ${x2} ${y2 - tgtThickness / 2}`;
  const bottom = `L ${x2} ${y2 + tgtThickness / 2} C ${cx} ${y2 + tgtThickness / 2}, ${cx} ${y1 + srcThickness / 2}, ${x1} ${y1 + srcThickness / 2} Z`;
  return top + " " + bottom;
}

function showTooltip(html, e) {
  tooltip.value = { visible: true, x: e.clientX + 12, y: e.clientY + 12, html };
}
function moveTooltip(e) {
  tooltip.value.x = e.clientX + 12;
  tooltip.value.y = e.clientY + 12;
}
function hideTooltip() {
  tooltip.value.visible = false;
}

// ---- Popover ----
function openPopover(node, e) {
  e.stopPropagation();
  hideTooltip();
  // Đặt popover ngay cạnh vị trí click
  popover.value = {
    visible: true,
    showList: true,
    x: e.clientX,
    y: e.clientY,
    stepIdx: node.stepIdx,
    name: node.name,
    userIds: node.userIds || [],
  };
  popoverSearch.value = "";
  copiedId.value = null;
  copiedAll.value = false;
  hoveredUserId.value = null;
  // Reposition sau khi DOM render — nếu tràn cạnh phải/dưới thì lùi lại
  nextTick(() => {
    const el = popoverRef.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 12;
    let nx = popover.value.x;
    let ny = popover.value.y;
    if (rect.right > window.innerWidth - pad) {
      nx = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (rect.bottom > window.innerHeight - pad) {
      ny = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    popover.value.x = nx;
    popover.value.y = ny;
  });
}

// Pin highlight nhưng KHÔNG hiển thị popover UI — dùng cho click vào bar
function pinHighlight(node, e) {
  e.stopPropagation();
  popover.value = {
    visible: true,
    showList: false,
    x: e.clientX,
    y: e.clientY,
    stepIdx: node.stepIdx,
    name: node.name,
    userIds: node.userIds || [],
  };
}

function closePopover() {
  popover.value.visible = false;
  popover.value.showList = false;
  showAnalysisModal.value = false;
  showUserDetailModal.value = false;
}

// Click vào alert → scroll tới bar của bước đó và pin highlight node lớn nhất
function focusAlert(alert) {
  const nodes = layout.value.nodes.filter((n) => n.stepIdx === alert.stepIdx);
  if (nodes.length === 0) return;
  const target = nodes.reduce(
    (max, n) => (n.count > max.count ? n : max),
    nodes[0],
  );
  popover.value = {
    visible: true,
    showList: false,
    x: 0,
    y: 0,
    stepIdx: target.stepIdx,
    name: target.name,
    userIds: target.userIds || [],
  };
  // Scroll horizontal đến bar của node đó
  nextTick(() => {
    const wrap = document.querySelector(".upc-chart-wrap");
    if (!wrap) return;
    const scrollLeft = Math.max(0, target.x - 80);
    wrap.scrollTo({ left: scrollLeft, behavior: "smooth" });
  });
}

const filteredUserIds = computed(() => {
  const q = popoverSearch.value.trim().toLowerCase();
  if (!q) return popover.value.userIds;
  return popover.value.userIds.filter((id) => id.toLowerCase().includes(q));
});

// Map person_id → source (tên node ở bước trước mà user đó đi qua để vào node hiện tại)
// Dùng để khi hover id thì highlight source tương ứng trong "User đến từ"
const userIdToSource = computed(() => {
  const map = new Map();
  if (!popoverStats.value) return map;
  popoverStats.value.prevBreakdown.forEach((b) => {
    (b.userIds || []).forEach((id) => map.set(id, b.source));
  });
  return map;
});

const hoveredUserId = ref(null);
// hoveredDonutSource: source được hover trực tiếp trên donut/legend (ưu tiên)
const hoveredDonutSource = ref(null);
const hoveredSource = computed(() => {
  if (hoveredDonutSource.value) return hoveredDonutSource.value;
  if (!hoveredUserId.value) return null;
  return userIdToSource.value.get(hoveredUserId.value) || null;
});

// Modal phân tích nhanh — bật từ button trong popover
const showAnalysisModal = ref(false);

// Modal "Xem chi tiết user" — bảng person_id × property keys
const showUserDetailModal = ref(false);
const userDetailSort = ref({ key: "", dir: "desc" });

// Bộ lọc cho modal — mỗi filter: { key, op, value }
// op cho số: '>', '>=', '<', '<=', '=', '!='
// op cho chuỗi: 'contains', 'equals', 'not_contains'
// op chung: 'is_empty', 'not_empty'
const userDetailFilters = ref([]);

const NUMERIC_OPS = [
  { value: ">", label: ">" },
  { value: ">=", label: "≥" },
  { value: "<", label: "<" },
  { value: "<=", label: "≤" },
  { value: "=", label: "=" },
  { value: "!=", label: "≠" },
];
const STRING_OPS = [
  { value: "contains", label: "chứa" },
  { value: "equals", label: "=" },
  { value: "not_contains", label: "không chứa" },
];
const EMPTY_OPS = [
  { value: "is_empty", label: "trống" },
  { value: "not_empty", label: "có giá trị" },
];

function addUserDetailFilter() {
  const keys = userDetailTable.value?.keys || [];
  userDetailFilters.value.push({
    key: keys[0] || "",
    op: ">",
    value: "",
  });
}

function removeUserDetailFilter(idx) {
  userDetailFilters.value.splice(idx, 1);
}

function clearUserDetailFilters() {
  userDetailFilters.value = [];
}

// Khi đóng modal hoặc đổi node → reset filter để tránh áp filter cũ vào key không tồn tại
watch(showUserDetailModal, (v) => {
  if (!v) userDetailFilters.value = [];
});
watch(
  () => popover.value.name,
  () => {
    userDetailFilters.value = [];
  },
);

// Detect kind của value tại 1 key (number nếu mọi giá trị non-null đều numeric)
// Dùng allRows (trước filter) để không phụ thuộc vào filter hiện tại
function detectKeyKind(key) {
  if (!userDetailTable.value || !key) return "string";
  if (STRING_FORCED_KEYS.has(key)) return "string";
  const rows = userDetailTable.value.allRows || userDetailTable.value.rows;
  let hasValue = false;
  for (const r of rows) {
    const v = r.props?.[key];
    if (v == null || v === "") continue;
    hasValue = true;
    if (typeof v === "boolean") return "string";
    if (!Number.isFinite(Number(v))) return "string";
  }
  return hasValue ? "number" : "string";
}

function toggleUserDetailSort(key) {
  if (userDetailSort.value.key === key) {
    userDetailSort.value.dir =
      userDetailSort.value.dir === "asc" ? "desc" : "asc";
  } else {
    userDetailSort.value = { key, dir: "desc" };
  }
}

// Kiểm tra 1 row có pass filter không
function rowPassesFilter(row, filter) {
  const { key, op, value } = filter;
  if (!key) return true;
  const raw = row.props?.[key];

  // Op không cần value
  if (op === "is_empty") return raw == null || raw === "";
  if (op === "not_empty") return raw != null && raw !== "";

  if (raw == null || raw === "") return false;

  // Numeric ops
  if ([">", ">=", "<", "<=", "=", "!="].includes(op)) {
    const a = Number(raw);
    const b = Number(value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (op) {
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case "=":
        return a === b;
      case "!=":
        return a !== b;
    }
  }

  // String ops
  const s = String(raw).toLowerCase();
  const q = String(value ?? "").toLowerCase();
  if (op === "contains") return s.includes(q);
  if (op === "equals") return s === q;
  if (op === "not_contains") return !s.includes(q);

  return true;
}

// Bảng chi tiết: rows = mỗi user, cols = property keys
const userDetailTable = computed(() => {
  if (!popover.value.visible) return null;
  const { name: eventName, userIds } = popover.value;
  if (!userIds || userIds.length === 0) return null;

  // Collect rows
  const rows = [];
  userIds.forEach((id) => {
    const eventProps = personIdToEventProps.value.get(id);
    const list = eventProps?.[eventName];
    rows.push({
      personId: id,
      props: list?.[0] || null, // record đầu tiên (xem helper trong popoverStats)
    });
  });

  // Discover keys (exclude hidden)
  const keysSet = new Set();
  rows.forEach((r) => {
    if (!r.props) return;
    Object.keys(r.props).forEach((k) => {
      if (HIDDEN_PROP_KEYS.has(k)) return;
      keysSet.add(k);
    });
  });
  const keys = Array.from(keysSet);

  // Apply filters (chỉ áp filter có key tồn tại trong keys)
  const activeFilters = userDetailFilters.value.filter(
    (f) => f.key && keys.includes(f.key),
  );
  const totalCount = rows.length;
  let filteredRows = rows;
  if (activeFilters.length > 0) {
    filteredRows = rows.filter((r) =>
      activeFilters.every((f) => rowPassesFilter(r, f)),
    );
  }

  // Sort
  let sortedRows = filteredRows;
  const sortKey = userDetailSort.value.key;
  if (sortKey) {
    const dir = userDetailSort.value.dir === "asc" ? 1 : -1;
    sortedRows = [...filteredRows].sort((a, b) => {
      const va = a.props?.[sortKey];
      const vb = b.props?.[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const na = Number(va);
      const nb = Number(vb);
      if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  return {
    rows: sortedRows,
    keys,
    totalCount,
    filteredCount: sortedRows.length,
    allRows: rows,
  };
});

// Palette cho donut "User đến từ" — vòng lặp 8 màu rồi quay lại
const PREV_PALETTE = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#a855f7",
  "#84cc16",
  "#f97316",
];

// Tính các arc cho donut chart từ prevBreakdown
// SVG arc dùng stroke-dasharray trên circle (cách đơn giản nhất, không cần arc path)
const prevBreakdownArcs = computed(() => {
  if (!popoverStats.value) return [];
  const items = popoverStats.value.prevBreakdown;
  const total = items.reduce((s, it) => s + it.count, 0);
  if (total === 0) return [];

  const CIRCUMFERENCE = 2 * Math.PI * 32; // bán kính 32
  let offset = 0;
  return items.map((it, i) => {
    const fraction = it.count / total;
    const dash = fraction * CIRCUMFERENCE;
    const arc = {
      ...it,
      color: PREV_PALETTE[i % PREV_PALETTE.length],
      dash,
      gap: CIRCUMFERENCE - dash,
      offset,
      // % so với total user của node hiện tại (giữ nguyên `pct` có sẵn)
    };
    offset += dash;
    return arc;
  });
});

// End step: nếu set, chart chỉ vẽ các luồng DẪN TỚI event này
// (truncate mỗi journey tại lần xuất hiện đầu tiên của endStepName)
const endStepName = ref(null);
function setEndStep(name) {
  endStepName.value = name;
  closePopover();
}
function clearEndStep() {
  endStepName.value = null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {}
    document.body.removeChild(ta);
  }
}

async function copySingle(id) {
  await copyText(id);
  copiedId.value = id;
  setTimeout(() => {
    if (copiedId.value === id) copiedId.value = null;
  }, 1400);
}

async function copyAll() {
  await copyText(filteredUserIds.value.join("\n"));
  copiedAll.value = true;
  setTimeout(() => (copiedAll.value = false), 1400);
}

// Click outside / Esc để đóng popover
const popoverRef = ref(null);

// ---- Drag popover ----
const dragState = ref({ active: false, offsetX: 0, offsetY: 0 });

function startDragPopover(e) {
  // Bỏ qua nếu click vào nút × hoặc bất kỳ button/input nào trong header
  if (e.target.closest("button, input, a")) return;
  const rect = popoverRef.value?.getBoundingClientRect();
  if (!rect) return;
  dragState.value = {
    active: true,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", endDragPopover);
  e.preventDefault();
}
function onDragMove(e) {
  if (!dragState.value.active) return;
  const pad = 8;
  const w = popoverRef.value?.offsetWidth || 380;
  const h = popoverRef.value?.offsetHeight || 200;
  let nx = e.clientX - dragState.value.offsetX;
  let ny = e.clientY - dragState.value.offsetY;
  // Constrain trong viewport
  nx = Math.max(pad, Math.min(window.innerWidth - w - pad, nx));
  ny = Math.max(pad, Math.min(window.innerHeight - h - pad, ny));
  popover.value.x = nx;
  popover.value.y = ny;
}
function endDragPopover() {
  dragState.value.active = false;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", endDragPopover);
}
function handleDocClick(e) {
  if (!popover.value.visible) return;
  if (popoverRef.value && popoverRef.value.contains(e.target)) return;
  closePopover();
}
function handleKey(e) {
  if (e.key === "Escape") closePopover();
}
onMounted(() => {
  document.addEventListener("mousedown", handleDocClick);
  document.addEventListener("keydown", handleKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", handleDocClick);
  document.removeEventListener("keydown", handleKey);
});

watch(
  () => props.rawData,
  () => {
    hideTooltip();
    closePopover();
  },
);

// Khi đổi bộ lọc events, đóng popover (node được pin có thể đã bị ẩn)
watch(hiddenEvents, () => {
  closePopover();
});
</script>

<template>
  <div class="upc-root">
    <div class="upc-controls">
      <label class="upc-control">
        <input type="checkbox" v-model="dedup" />
        Gộp bước trùng liên tiếp
      </label>
      <label class="upc-control">
        Số bước tối đa
        <input type="number" v-model.number="maxSteps" min="2" max="100" />
      </label>
      <label class="upc-control">
        Top N path / bước
        <input type="number" v-model.number="topN" min="1" max="20" />
      </label>
      <label class="upc-control">
        Card width
        <input
          type="number"
          v-model.number="cardWidth"
          min="120"
          max="400"
          step="10"
        />
      </label>
      <label class="upc-control">
        Column gap
        <input
          type="number"
          v-model.number="columnGap"
          min="20"
          max="240"
          step="10"
        />
      </label>
      <button class="upc-customize-btn" @click="showCustomize = !showCustomize">
        ⚙ Tuỳ chỉnh
        <span v-if="hiddenEvents.size > 0" class="upc-customize-badge"
          >{{ hiddenEvents.size }} ẩn</span
        >
      </button>
      <div class="upc-meta">
        {{ props.rawData.length }} records · Hover trace · Click pin
        <span v-if="popover.visible" class="upc-pinned-tag">📌 đang pin</span>
      </div>
    </div>

    <!-- Panel tuỳ chỉnh events -->
    <div v-if="showCustomize" class="upc-customize-panel">
      <div class="upc-customize-header">
        <input
          v-model="customizeSearch"
          type="text"
          placeholder="Tìm event…"
          class="upc-customize-search"
        />
        <button
          class="upc-customize-action"
          @click="showAllEvents"
          :disabled="hiddenEvents.size === 0"
        >
          Hiện tất cả
        </button>
        <button class="upc-customize-action" @click="hideAllFiltered">
          Ẩn kết quả lọc
        </button>
        <button class="upc-customize-close" @click="showCustomize = false">
          ×
        </button>
      </div>

      <!-- Presets toolbar -->
      <div class="upc-presets-bar">
        <span class="upc-presets-label">Preset:</span>
        <select
          class="upc-presets-select"
          :value="activePresetName"
          @change="
            (e) =>
              e.target.value ? loadPreset(e.target.value) : setActivePreset('')
          "
        >
          <option value="">— Không dùng —</option>
          <option v-for="name in presetNames" :key="name" :value="name">
            {{ name }}
          </option>
        </select>
        <button class="upc-customize-action" @click="savePreset">
          💾 Lưu {{ activePresetName ? "(ghi đè)" : "mới" }}
        </button>
        <button
          v-if="activePresetName"
          class="upc-customize-action upc-customize-action--danger"
          @click="deletePreset(activePresetName)"
        >
          Xoá
        </button>
        <span class="upc-presets-info">
          {{ hiddenEvents.size }} event đang ẩn
        </span>
      </div>

      <div class="upc-customize-list">
        <label
          v-for="ev in filteredEvents"
          :key="ev.name"
          class="upc-customize-item"
        >
          <input
            type="checkbox"
            :checked="!hiddenEvents.has(ev.name)"
            @change="toggleEvent(ev.name)"
          />
          <span class="upc-customize-name" :title="ev.name">{{ ev.name }}</span>
          <span class="upc-customize-count">{{ fmtInt(ev.count) }}</span>
        </label>
        <div v-if="filteredEvents.length === 0" class="upc-customize-empty">
          Không có event khớp
        </div>
      </div>
    </div>

    <!-- Banner End step -->
    <div v-if="endStepName" class="upc-endstep-banner">
      <span class="upc-endstep-icon">🎯</span>
      <span class="upc-endstep-label">End step:</span>
      <span class="upc-endstep-name">{{ endStepName }}</span>
      <span class="upc-endstep-hint">Chỉ vẽ luồng dẫn tới event này</span>
      <button class="upc-endstep-clear" @click="clearEndStep">Bỏ chọn</button>
    </div>

    <!-- Loading skeleton cho khối phân tích nhanh -->
    <div
      v-if="props.loading"
      class="upc-analysis-banner upc-analysis-banner--loading"
    >
      <div class="upc-analysis-banner-header">
        <div class="upc-spinner upc-spinner--sm"></div>
        <span
          class="upc-analysis-banner-title upc-analysis-banner-title--muted"
        >
          Đang phân tích các bước rơi rụng…
        </span>
      </div>
      <div class="upc-analysis-banner-list">
        <div
          v-for="i in 3"
          :key="i"
          class="upc-analysis-card upc-analysis-card--skeleton"
        >
          <div class="upc-skeleton-bar upc-skeleton-bar--short"></div>
          <div class="upc-skeleton-bar"></div>
          <div class="upc-skeleton-bar upc-skeleton-bar--medium"></div>
        </div>
      </div>
    </div>

    <!-- Phân tích nhanh: bước nào rớt > 40% -->
    <div v-else-if="dropoffAlerts.length > 0" class="upc-analysis-banner">
      <div class="upc-analysis-banner-header">
        <span class="upc-analysis-banner-icon">⚠️</span>
        <span class="upc-analysis-banner-title">
          Phân tích nhanh: phát hiện <b>{{ dropoffAlerts.length }}</b> bước rơi
          rụng &gt; {{ DROPOFF_THRESHOLD }}%
        </span>
        <span class="upc-analysis-banner-hint"
          >Click vào card để pin highlight luồng</span
        >
      </div>
      <div class="upc-analysis-banner-list">
        <div
          v-for="alert in dropoffAlerts"
          :key="alert.stepIdx"
          class="upc-analysis-card"
          @click="focusAlert(alert)"
        >
          <div class="upc-analysis-card-head">
            <span class="upc-analysis-step">Bước {{ alert.stepIdx + 1 }}</span>
            <span class="upc-analysis-pct">−{{ fmtPct(alert.dropPct) }}</span>
          </div>
          <div class="upc-analysis-card-meta">
            {{ fmtInt(alert.dropped) }} / {{ fmtInt(alert.prevTotal) }} user rời
            bỏ
          </div>
          <div
            v-if="alert.sourceBreakdown.length > 0"
            class="upc-analysis-card-sources"
          >
            <div class="upc-analysis-card-sources-label">Top nguồn rớt:</div>
            <div
              v-for="(s, i) in alert.sourceBreakdown.slice(0, 2)"
              :key="i"
              class="upc-analysis-card-source"
              :title="s.source"
            >
              <span class="upc-analysis-card-source-name">{{ s.source }}</span>
              <span class="upc-analysis-card-source-num"
                >{{ fmtInt(s.droppedCount) }} ({{ fmtPct(s.dropPct) }})</span
              >
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      class="upc-chart-wrap"
      :class="{ 'upc-chart-wrap--loading': props.loading }"
    >
      <div v-if="props.loading" class="upc-loading-overlay">
        <div class="upc-spinner"></div>
        <div class="upc-loading-text">Đang tải dữ liệu từ PostHog…</div>
      </div>
      <svg
        :width="layout.totalW"
        :height="layout.totalH"
        :viewBox="`0 0 ${layout.totalW} ${layout.totalH}`"
      >
        <!-- Links -->
        <g>
          <path
            v-for="(g, i) in layout.linkGeom"
            :key="'l' + i"
            :d="linkPath(g)"
            class="upc-link"
            :class="{
              'upc-link--active': linkState(g) === 'active',
              'upc-link--upstream': linkState(g) === 'upstream',
              'upc-link--dim': linkState(g) === 'dim',
            }"
            @mouseenter="
              showTooltip(
                `<b>${fmtInt(g.link.value)}</b> user · ${truncate(g.link.source, 40)} → ${truncate(g.link.target, 40)}`,
                $event,
              )
            "
            @mousemove="moveTooltip"
            @mouseleave="hideTooltip"
          />
        </g>

        <!-- Bars -->
        <g>
          <rect
            v-for="n in layout.nodes"
            :key="`bar-${n.stepIdx}-${n.name}`"
            :x="n.x"
            :y="n.y"
            :width="n.w"
            :height="n.h"
            rx="3"
            class="upc-bar"
            :class="{
              'upc-bar--active': nodeState(n) === 'active',
              'upc-bar--upstream': nodeState(n) === 'upstream',
              'upc-bar--dim': nodeState(n) === 'dim',
            }"
            @mouseenter="onNodeEnter(n, $event)"
            @mousemove="moveTooltip"
            @mouseleave="onNodeLeave"
            @click="pinHighlight(n, $event)"
          />
        </g>

        <!-- Cards -->
        <g>
          <g
            v-for="n in layout.nodes"
            :key="`card-${n.stepIdx}-${n.name}`"
            class="upc-card"
            :class="{
              'upc-card--active': nodeState(n) === 'active',
              'upc-card--upstream': nodeState(n) === 'upstream',
              'upc-card--dim': nodeState(n) === 'dim',
            }"
            @mouseenter="onNodeEnter(n, $event)"
            @mousemove="moveTooltip"
            @mouseleave="onNodeLeave"
            @click="openPopover(n, $event)"
          >
            <rect
              :x="n.x + n.w + 8"
              :y="n.y"
              :width="layout.CARD_WIDTH"
              :height="Math.max(layout.CARD_HEIGHT, Math.min(n.h, 64))"
              rx="6"
              class="upc-card-bg"
              :class="{
                'upc-card-bg--active':
                  popover.visible &&
                  popover.stepIdx === n.stepIdx &&
                  popover.name === n.name,
              }"
            />
            <rect
              :x="n.x + n.w + 16"
              :y="n.y + 8"
              width="22"
              height="18"
              rx="4"
              class="upc-step-badge"
            />
            <text
              :x="n.x + n.w + 27"
              :y="n.y + 21"
              text-anchor="middle"
              class="upc-step-text"
            >
              {{ String(n.stepIdx + 1).padStart(2, "0") }}
            </text>
            <text :x="n.x + n.w + 44" :y="n.y + 22" class="upc-label">
              {{ truncate(n.name, 24) }}
            </text>
            <text
              :x="n.x + n.w + 8 + layout.CARD_WIDTH - 10"
              :y="n.y + 22"
              text-anchor="end"
              class="upc-count"
            >
              {{ fmtInt(n.count) }}
            </text>
          </g>
        </g>
      </svg>
    </div>

    <div
      v-show="tooltip.visible && !popover.visible"
      class="upc-tooltip"
      :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
      v-html="tooltip.html"
    ></div>

    <!-- Popover: danh sách user của step (chỉ hiện khi click vào card) -->
    <div
      v-show="popover.visible && popover.showList"
      ref="popoverRef"
      class="upc-popover"
      :style="{ left: popover.x + 'px', top: popover.y + 'px' }"
    >
      <div
        class="upc-pop-header"
        :class="{ 'upc-pop-header--dragging': dragState.active }"
        @mousedown="startDragPopover"
      >
        <div class="upc-pop-title">
          <span class="upc-pop-badge">{{
            String(popover.stepIdx + 1).padStart(2, "0")
          }}</span>
          <span class="upc-pop-name">{{ popover.name }}</span>
        </div>
        <button class="upc-pop-close" @click="closePopover" aria-label="Đóng">
          ×
        </button>
      </div>
      <div class="upc-pop-body">
        <!-- Stats: conversion từ bước trước & từ bước đầu, breakdown trước đó -->
        <div v-if="popoverStats" class="upc-pop-stats">
          <div class="upc-pop-stat-row">
            <div class="upc-pop-stat">
              <div class="upc-pop-stat-label">User ở step này</div>
              <div class="upc-pop-stat-value">
                {{ fmtInt(popoverStats.currentCount) }}
              </div>
            </div>
            <div class="upc-pop-stat" v-if="popover.stepIdx > 0">
              <div class="upc-pop-stat-label">Từ bước trước</div>
              <div class="upc-pop-stat-value">
                {{ fmtPct(popoverStats.pctFromPrev) }}
                <span class="upc-pop-stat-sub"
                  >/ {{ fmtInt(popoverStats.prevStepTotal) }}</span
                >
              </div>
            </div>
            <div class="upc-pop-stat" v-if="popover.stepIdx > 0">
              <div class="upc-pop-stat-label">Từ bước 1</div>
              <div class="upc-pop-stat-value">
                {{ fmtPct(popoverStats.pctFromStart) }}
                <span class="upc-pop-stat-sub"
                  >/ {{ fmtInt(popoverStats.firstStepTotal) }}</span
                >
              </div>
            </div>
            <div
              v-if="popover.stepIdx > 0"
              class="upc-pop-stat upc-pop-stat--scale"
              :style="{
                borderColor: dropoffColor(popoverStats.dropoffPctFromPrev)
                  ?.border,
                background: dropoffColor(popoverStats.dropoffPctFromPrev)?.bg,
              }"
            >
              <div class="upc-pop-stat-label">Rơi rụng vs prev</div>
              <div
                class="upc-pop-stat-value"
                :style="{
                  color: dropoffColor(popoverStats.dropoffPctFromPrev)?.text,
                }"
              >
                {{ fmtPct(popoverStats.dropoffPctFromPrev) }}
                <span class="upc-pop-stat-sub"
                  >/ {{ fmtInt(popoverStats.dropoffFromPrev) }} user</span
                >
              </div>
            </div>
          </div>

          <!-- Properties stats: dynamic theo event -->
          <div v-if="nodePropertiesStats" class="upc-pop-props">
            <div class="upc-pop-props-title">
              📋 Chỉ số ở bước này
              <span class="upc-pop-props-meta"
                >({{ fmtInt(nodePropertiesStats.recordCount) }}/{{
                  fmtInt(popover.userIds.length)
                }}
                user có data)</span
              >
            </div>
            <div
              v-if="nodePropertiesStats.stats.length === 0"
              class="upc-pop-props-empty"
            >
              <template v-if="nodePropertiesStats.reason === 'no-records'">
                Event này không có custom properties được track. PostHog chỉ ghi
                các thuộc tính hệ thống ($browser, $session_id…) — không có chỉ
                số để tổng hợp.
              </template>
              <template v-else-if="nodePropertiesStats.reason === 'no-keys'">
                Tất cả properties của event này nằm trong danh sách ẩn (token /
                error_*). Chưa có chỉ số public để tổng hợp.
              </template>
            </div>
            <div v-else class="upc-pop-props-grid">
              <div
                v-for="s in nodePropertiesStats.stats"
                :key="s.key"
                class="upc-pop-prop"
                :class="{ 'upc-pop-prop--wide': s.kind === 'string' }"
              >
                <div class="upc-pop-prop-key">{{ s.key }}</div>
                <template v-if="s.kind === 'number'">
                  <div class="upc-pop-prop-main">
                    <span class="upc-pop-prop-label">Tổng</span>
                    <span class="upc-pop-prop-value">{{ fmtNum(s.sum) }}</span>
                  </div>
                </template>
                <template v-else-if="s.kind === 'string'">
                  <div
                    v-for="(t, i) in s.top"
                    :key="i"
                    class="upc-pop-prop-dist-row"
                    :title="t.value"
                  >
                    <span
                      class="upc-pop-prop-dist-bar"
                      :style="{ width: t.pct + '%' }"
                    ></span>
                    <span class="upc-pop-prop-dist-val">{{ t.value }}</span>
                    <span class="upc-pop-prop-dist-num"
                      >{{ fmtInt(t.count) }} · {{ fmtPct(t.pct) }}</span
                    >
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- Action buttons -->
          <div class="upc-pop-action-row">
            <button
              v-if="endStepName !== popover.name"
              class="upc-pop-action-btn"
              @click="setEndStep(popover.name)"
              title="Chỉ vẽ các luồng dẫn tới event này"
            >
              🎯 Đặt làm End step
            </button>
            <button
              v-else
              class="upc-pop-action-btn upc-pop-action-btn--active"
              @click="clearEndStep"
            >
              ✓ Đang là End step · Bỏ
            </button>
            <button
              v-if="
                popover.stepIdx > 0 && popoverStats.dropoffPctFromPrev != null
              "
              class="upc-pop-action-btn"
              :class="{
                'upc-pop-action-btn--alert':
                  popoverStats.dropoffPctFromPrev > 40,
              }"
              @click="showAnalysisModal = true"
            >
              <span v-if="popoverStats.dropoffPctFromPrev > 40">⚠️</span>
              <span v-else>📊</span>
              Phân tích
            </button>
            <button
              v-if="nodePropertiesStats"
              class="upc-pop-action-btn"
              @click="showUserDetailModal = true"
            >
              📋 Chi tiết user
            </button>
          </div>

          <div v-if="prevBreakdownArcs.length > 0" class="upc-pop-prev">
            <div class="upc-pop-prev-title">
              User đến từ (bước {{ popover.stepIdx }})
            </div>
            <div class="upc-pop-donut-wrap">
              <!-- Donut SVG -->
              <svg
                class="upc-pop-donut"
                viewBox="0 0 80 80"
                width="100"
                height="100"
              >
                <!-- Background ring (nhạt) -->
                <circle
                  cx="40"
                  cy="40"
                  r="32"
                  fill="none"
                  stroke="#f3f4f6"
                  stroke-width="14"
                />
                <!-- Slices: dùng stroke-dasharray rotate quanh tâm -->
                <g transform="rotate(-90 40 40)">
                  <circle
                    v-for="(arc, i) in prevBreakdownArcs"
                    :key="i"
                    cx="40"
                    cy="40"
                    r="32"
                    fill="none"
                    :stroke="arc.color"
                    stroke-width="14"
                    :stroke-dasharray="`${arc.dash} ${arc.gap}`"
                    :stroke-dashoffset="-arc.offset"
                    :class="[
                      'upc-pop-donut-slice',
                      {
                        'upc-pop-donut-slice--dim':
                          hoveredSource && hoveredSource !== arc.source,
                      },
                    ]"
                    @mouseenter="hoveredDonutSource = arc.source"
                    @mouseleave="hoveredDonutSource = null"
                  />
                </g>
                <!-- Center label: tổng user -->
                <text
                  x="40"
                  y="38"
                  text-anchor="middle"
                  class="upc-pop-donut-total"
                >
                  {{ fmtInt(popoverStats.currentCount) }}
                </text>
                <text
                  x="40"
                  y="50"
                  text-anchor="middle"
                  class="upc-pop-donut-sub"
                >
                  user
                </text>
              </svg>

              <!-- Legend -->
              <div class="upc-pop-donut-legend">
                <div
                  v-for="(arc, i) in prevBreakdownArcs"
                  :key="i"
                  class="upc-pop-legend-row"
                  :class="{
                    'upc-pop-legend-row--active': hoveredSource === arc.source,
                  }"
                  :title="arc.source"
                  @mouseenter="hoveredDonutSource = arc.source"
                  @mouseleave="hoveredDonutSource = null"
                >
                  <span
                    class="upc-pop-legend-dot"
                    :style="{ background: arc.color }"
                  ></span>
                  <span class="upc-pop-legend-name">{{ arc.source }}</span>
                  <span class="upc-pop-legend-num"
                    >{{ fmtInt(arc.count) }} · {{ fmtPct(arc.pct) }}</span
                  >
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="upc-pop-toolbar">
          <input
            v-model="popoverSearch"
            type="text"
            placeholder="Lọc theo person_id…"
            class="upc-pop-search"
          />
          <button
            class="upc-pop-btn"
            :class="{ 'upc-pop-btn--ok': copiedAll }"
            @click="copyAll"
            :disabled="filteredUserIds.length === 0"
          >
            {{
              copiedAll
                ? "Đã copy"
                : `Copy all (${fmtInt(filteredUserIds.length)})`
            }}
          </button>
        </div>
        <div class="upc-pop-list">
          <div v-if="filteredUserIds.length === 0" class="upc-pop-empty">
            Không có user khớp
          </div>
          <div
            v-for="id in filteredUserIds"
            :key="id"
            class="upc-pop-row"
            :title="id"
            @mouseenter="hoveredUserId = id"
            @mouseleave="hoveredUserId = null"
          >
            <span class="upc-pop-id" @click="copySingle(id)">{{ id }}</span>
            <div class="upc-pop-actions">
              <a
                v-if="canOpenPosthog && replayUrl(id)"
                :href="replayUrl(id)"
                target="_blank"
                rel="noopener"
                class="upc-pop-link"
                title="Mở recording của session mới nhất"
                @click.stop
                >▶ Latest</a
              >
              <a
                v-if="canOpenPosthog"
                :href="replayListUrl(id)"
                target="_blank"
                rel="noopener"
                class="upc-pop-link"
                title="Danh sách tất cả recordings của user"
                @click.stop
                >📜 List</a
              >
              <a
                v-if="canOpenPosthog"
                :href="personUrl(id)"
                target="_blank"
                rel="noopener"
                class="upc-pop-link"
                title="Trang person trong PostHog"
                @click.stop
                >↗</a
              >
              <span
                class="upc-pop-copy"
                :class="{ 'upc-pop-copy--ok': copiedId === id }"
                @click="copySingle(id)"
                >{{ copiedId === id ? "✓ Copied" : "Copy" }}</span
              >
            </div>
          </div>
        </div>
      </div>
      <!-- end .upc-pop-body -->
    </div>

    <!-- Modal Phân tích nhanh — bật từ button trong popover -->
    <div
      v-if="showAnalysisModal && popoverStats && popover.visible"
      class="upc-analysis-modal-backdrop"
      @click.self="showAnalysisModal = false"
    >
      <div class="upc-analysis-modal">
        <div class="upc-analysis-modal-header">
          <div>
            <div class="upc-analysis-modal-title">
              <span v-if="popoverStats.dropoffPctFromPrev > 40">⚠️</span>
              <span v-else>📊</span>
              Phân tích nhanh
            </div>
            <div class="upc-analysis-modal-sub">
              Bước {{ popover.stepIdx + 1 }} · {{ popover.name }}
            </div>
          </div>
          <button class="upc-pop-close" @click="showAnalysisModal = false">
            ×
          </button>
        </div>

        <div class="upc-analysis-modal-body">
          <div class="upc-pop-analysis-line">
            <span
              class="upc-pop-analysis-num"
              :style="{
                color: dropoffColor(popoverStats.dropoffPctFromPrev)?.text,
                background: dropoffColor(popoverStats.dropoffPctFromPrev)?.bg,
              }"
              >{{ fmtInt(popoverStats.dropoffFromPrev) }}</span
            >
            user từ <b>bước {{ popover.stepIdx }}</b> đã không vào "<b>{{
              popover.name
            }}</b
            >" ({{ fmtPct(popoverStats.dropoffPctFromPrev) }}).
          </div>

          <div
            v-if="popoverStats.leaversOtherBranches.length > 0"
            class="upc-pop-analysis-section"
          >
            <div class="upc-pop-analysis-section-title">
              ↗ Họ chuyển sang nhánh khác:
            </div>
            <div
              v-for="(b, i) in popoverStats.leaversOtherBranches.slice(0, 8)"
              :key="i"
              class="upc-pop-analysis-row"
              :title="b.target"
            >
              <span
                class="upc-pop-analysis-bar"
                :style="{ width: Math.min(100, b.pct) + '%' }"
              ></span>
              <span class="upc-pop-analysis-name">{{ b.target }}</span>
              <span class="upc-pop-analysis-meta"
                >{{ fmtInt(b.count) }} user</span
              >
            </div>
          </div>

          <div
            v-if="popoverStats.leaversDropped > 0"
            class="upc-pop-analysis-section"
          >
            <div class="upc-pop-analysis-section-title">
              ⛔ Dừng hẳn (không có event tiếp theo):
            </div>
            <div class="upc-pop-analysis-row upc-pop-analysis-row--danger">
              <span class="upc-pop-analysis-name">User rời bỏ hành trình</span>
              <span class="upc-pop-analysis-meta"
                >{{ fmtInt(popoverStats.leaversDropped) }} user</span
              >
            </div>
          </div>

          <div
            v-if="popoverStats.dropoffSourcesBreakdown.length > 0"
            class="upc-pop-analysis-section"
          >
            <div class="upc-pop-analysis-section-title">
              🔍 Nguồn drop-off lớn nhất:
            </div>
            <div
              v-for="(s, i) in popoverStats.dropoffSourcesBreakdown.slice(0, 5)"
              :key="i"
              class="upc-pop-analysis-row"
              :title="s.source"
            >
              <span class="upc-pop-analysis-name">{{ s.source }}</span>
              <span class="upc-pop-analysis-meta">
                {{ fmtInt(s.droppedCount) }}/{{ fmtInt(s.totalAtSource) }} rớt
                ({{ fmtPct(s.dropPct) }})
              </span>
            </div>
          </div>

          <div
            v-if="popoverStats.insights.length > 0"
            class="upc-pop-analysis-section"
          >
            <div class="upc-pop-analysis-section-title">💡 Gợi ý:</div>
            <ul class="upc-pop-analysis-insights">
              <li v-for="(ins, i) in popoverStats.insights" :key="i">
                {{ ins }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal Chi tiết user × property — bảng để xem từng user có chỉ số gì -->
    <div
      v-if="showUserDetailModal && userDetailTable && popover.visible"
      class="upc-analysis-modal-backdrop"
      @click.self="showUserDetailModal = false"
    >
      <div class="upc-analysis-modal upc-user-detail-modal">
        <div class="upc-analysis-modal-header">
          <div>
            <div class="upc-analysis-modal-title">
              📋 Chi tiết user × property
            </div>
            <div class="upc-analysis-modal-sub">
              Bước {{ popover.stepIdx + 1 }} · {{ popover.name }} ·
              <b>{{ fmtInt(userDetailTable.filteredCount) }}</b>
              <template v-if="userDetailFilters.length > 0">
                / {{ fmtInt(userDetailTable.totalCount) }}
              </template>
              user
            </div>
          </div>
          <button class="upc-pop-close" @click="showUserDetailModal = false">
            ×
          </button>
        </div>

        <!-- Filter bar -->
        <div class="upc-udt-filter-bar">
          <div class="upc-udt-filter-head">
            <span class="upc-udt-filter-title">🔍 Bộ lọc</span>
            <button class="upc-udt-filter-add" @click="addUserDetailFilter">
              + Thêm điều kiện
            </button>
            <button
              v-if="userDetailFilters.length > 0"
              class="upc-udt-filter-clear"
              @click="clearUserDetailFilters"
            >
              Xoá tất cả
            </button>
          </div>
          <div v-if="userDetailFilters.length > 0" class="upc-udt-filter-list">
            <div
              v-for="(f, i) in userDetailFilters"
              :key="i"
              class="upc-udt-filter-row"
            >
              <select v-model="f.key" class="upc-udt-filter-select">
                <option value="" disabled>— chọn cột —</option>
                <option v-for="k in userDetailTable.keys" :key="k" :value="k">
                  {{ k }}
                </option>
              </select>
              <select v-model="f.op" class="upc-udt-filter-op">
                <optgroup v-if="detectKeyKind(f.key) === 'number'" label="Số">
                  <option
                    v-for="op in NUMERIC_OPS"
                    :key="op.value"
                    :value="op.value"
                  >
                    {{ op.label }}
                  </option>
                </optgroup>
                <optgroup v-else label="Chuỗi">
                  <option
                    v-for="op in STRING_OPS"
                    :key="op.value"
                    :value="op.value"
                  >
                    {{ op.label }}
                  </option>
                </optgroup>
                <optgroup label="Khác">
                  <option
                    v-for="op in EMPTY_OPS"
                    :key="op.value"
                    :value="op.value"
                  >
                    {{ op.label }}
                  </option>
                </optgroup>
              </select>
              <input
                v-if="!['is_empty', 'not_empty'].includes(f.op)"
                v-model="f.value"
                :type="detectKeyKind(f.key) === 'number' ? 'number' : 'text'"
                class="upc-udt-filter-input"
                placeholder="Giá trị"
              />
              <button
                class="upc-udt-filter-remove"
                @click="removeUserDetailFilter(i)"
                title="Xoá điều kiện"
              >
                ×
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="userDetailTable.rows.length === 0"
          class="upc-udt-empty-state"
        >
          Không có user nào khớp với bộ lọc.
          <button class="upc-udt-filter-clear" @click="clearUserDetailFilters">
            Xoá bộ lọc
          </button>
        </div>
        <div v-else class="upc-user-detail-table-wrap">
          <table class="upc-user-detail-table">
            <thead>
              <tr>
                <th class="upc-udt-id-col">person_id</th>
                <th
                  v-for="key in userDetailTable.keys"
                  :key="key"
                  class="upc-udt-prop-col"
                  @click="toggleUserDetailSort(key)"
                >
                  <span>{{ key }}</span>
                  <span class="upc-udt-sort" v-if="userDetailSort.key === key">
                    {{ userDetailSort.dir === "asc" ? "▲" : "▼" }}
                  </span>
                </th>
                <th class="upc-udt-action-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in userDetailTable.rows" :key="row.personId">
                <td class="upc-udt-id" :title="row.personId">
                  {{ row.personId }}
                </td>
                <td
                  v-for="key in userDetailTable.keys"
                  :key="key"
                  class="upc-udt-cell"
                  :class="{
                    'upc-udt-cell--num':
                      typeof row.props?.[key] === 'number' ||
                      Number.isFinite(Number(row.props?.[key])),
                  }"
                >
                  <template v-if="row.props && row.props[key] != null">
                    <span>{{ formatPropValue(key, row.props[key]) }}</span>
                  </template>
                  <span v-else class="upc-udt-empty">—</span>
                </td>
                <td class="upc-udt-actions">
                  <a
                    v-if="canOpenPosthog && replayUrl(row.personId)"
                    :href="replayUrl(row.personId)"
                    target="_blank"
                    rel="noopener"
                    class="upc-pop-link"
                    title="Recording"
                    >▶</a
                  >
                  <a
                    v-if="canOpenPosthog"
                    :href="replayListUrl(row.personId)"
                    target="_blank"
                    rel="noopener"
                    class="upc-pop-link"
                    title="List recordings"
                    >📜</a
                  >
                  <a
                    v-if="canOpenPosthog"
                    :href="personUrl(row.personId)"
                    target="_blank"
                    rel="noopener"
                    class="upc-pop-link"
                    title="PostHog person"
                    >↗</a
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.upc-root {
  position: relative;
}
.upc-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.upc-control {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}
.upc-control input[type="number"] {
  width: 60px;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
}
.upc-meta {
  margin-left: auto;
  font-size: 12px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 8px;
}
.upc-pinned-tag {
  font-size: 11px;
  font-weight: 600;
  color: #4338ca;
  background: #eef2ff;
  padding: 2px 6px;
  border-radius: 4px;
}

/* Nút Tuỳ chỉnh */
.upc-customize-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
}
.upc-customize-btn:hover {
  background: #f9fafb;
  border-color: #9ca3af;
}
.upc-customize-badge {
  background: #6366f1;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 9999px;
}

/* Panel tuỳ chỉnh */
.upc-customize-panel {
  border-bottom: 1px solid #e5e7eb;
  background: #fafbfc;
  max-height: 360px;
  display: flex;
  flex-direction: column;
}
.upc-customize-header {
  display: flex;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid #f3f4f6;
  align-items: center;
}
.upc-customize-search {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
}
.upc-customize-search:focus {
  outline: none;
  border-color: #6366f1;
}
.upc-customize-action {
  padding: 5px 10px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.upc-customize-action:hover:not(:disabled) {
  background: #f3f4f6;
}
.upc-customize-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.upc-customize-action--danger {
  color: #991b1b;
  border-color: #fecaca;
}
.upc-customize-action--danger:hover {
  background: #fef2f2;
}

/* Presets bar */
.upc-presets-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #f3f4f6;
}
.upc-presets-label {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
}
.upc-presets-select {
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  background: #fff;
  min-width: 140px;
}
.upc-presets-select:focus {
  outline: none;
  border-color: #6366f1;
}
.upc-presets-info {
  margin-left: auto;
  font-size: 11px;
  color: #6b7280;
}
.upc-customize-close {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: #6b7280;
  cursor: pointer;
  padding: 0 6px;
}
.upc-customize-close:hover {
  color: #111827;
}

.upc-customize-list {
  overflow-y: auto;
  padding: 4px 8px 8px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 2px;
}
.upc-customize-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.upc-customize-item:hover {
  background: #f3f4f6;
}
.upc-customize-item input {
  cursor: pointer;
}
.upc-customize-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}
.upc-customize-count {
  font-size: 11px;
  color: #6b7280;
  background: #f3f4f6;
  padding: 1px 6px;
  border-radius: 4px;
}
.upc-customize-empty {
  padding: 16px;
  color: #9ca3af;
  font-size: 12px;
  text-align: center;
}
/* Banner End step */
.upc-endstep-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: linear-gradient(90deg, #eef2ff 0%, #f5f3ff 100%);
  border-bottom: 1px solid #c7d2fe;
  font-size: 13px;
  color: #312e81;
  flex-wrap: wrap;
}
.upc-endstep-icon {
  font-size: 16px;
}
.upc-endstep-label {
  font-weight: 600;
}
.upc-endstep-name {
  font-weight: 700;
  background: #fff;
  border: 1px solid #c7d2fe;
  padding: 2px 8px;
  border-radius: 4px;
  color: #4338ca;
}
.upc-endstep-hint {
  font-size: 11px;
  color: #6b7280;
}
.upc-endstep-clear {
  margin-left: auto;
  padding: 4px 10px;
  background: #fff;
  border: 1px solid #c7d2fe;
  border-radius: 6px;
  font-size: 12px;
  color: #4338ca;
  cursor: pointer;
}
.upc-endstep-clear:hover {
  background: #e0e7ff;
}

/* Banner phân tích nhanh */
.upc-analysis-banner {
  padding: 12px 16px;
  background: linear-gradient(135deg, #fffbeb 0%, #fef2f2 100%);
  border-bottom: 1px solid #fde68a;
}
.upc-analysis-banner-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.upc-analysis-banner-icon {
  font-size: 16px;
}
.upc-analysis-banner-title {
  font-size: 13px;
  font-weight: 600;
  color: #92400e;
}
.upc-analysis-banner-title b {
  color: #b91c1c;
}
.upc-analysis-banner-hint {
  margin-left: auto;
  font-size: 11px;
  color: #92400e;
}
.upc-analysis-banner-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}
.upc-analysis-card {
  background: #fff;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s,
    transform 0.12s;
}
.upc-analysis-card:hover {
  border-color: #f59e0b;
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.18);
  transform: translateY(-1px);
}
.upc-analysis-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 4px;
}
.upc-analysis-step {
  font-size: 11px;
  font-weight: 600;
  color: #92400e;
  background: #fef3c7;
  padding: 1px 6px;
  border-radius: 4px;
}
.upc-analysis-pct {
  font-size: 14px;
  font-weight: 700;
  color: #b91c1c;
  font-variant-numeric: tabular-nums;
}
.upc-analysis-card-meta {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 6px;
}
.upc-analysis-card-sources-label {
  font-size: 10px;
  font-weight: 600;
  color: #92400e;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}
.upc-analysis-card-source {
  display: flex;
  align-items: center;
  font-size: 11px;
  padding: 2px 0;
  gap: 6px;
}
.upc-analysis-card-source-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}
.upc-analysis-card-source-num {
  flex-shrink: 0;
  color: #b91c1c;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.upc-chart-wrap {
  overflow-x: auto;
  overflow-y: hidden;
  background: #fafbfc;
  position: relative;
  min-height: 200px;
}
.upc-chart-wrap--loading svg {
  opacity: 0.3;
  pointer-events: none;
}

.upc-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(250, 251, 252, 0.7);
  backdrop-filter: blur(2px);
  z-index: 10;
}
.upc-loading-text {
  font-size: 13px;
  color: #4338ca;
  font-weight: 500;
}
.upc-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #e0e7ff;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: upc-spin 0.7s linear infinite;
}
.upc-spinner--sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
}
@keyframes upc-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Skeleton cho banner phân tích nhanh khi loading */
.upc-analysis-banner--loading {
  background: linear-gradient(135deg, #fffbeb 0%, #f5f3ff 100%);
  border-bottom-color: #e0e7ff;
}
.upc-analysis-banner-title--muted {
  color: #6b7280;
  font-weight: 500;
}
.upc-analysis-card--skeleton {
  cursor: default;
  border-color: #e5e7eb;
  pointer-events: none;
}
.upc-analysis-card--skeleton:hover {
  transform: none;
  box-shadow: none;
  border-color: #e5e7eb;
}
.upc-skeleton-bar {
  height: 10px;
  border-radius: 4px;
  margin: 4px 0;
  background: linear-gradient(90deg, #f3f4f6 0%, #e5e7eb 50%, #f3f4f6 100%);
  background-size: 200% 100%;
  animation: upc-skeleton-shimmer 1.4s linear infinite;
}
.upc-skeleton-bar--short {
  width: 40%;
}
.upc-skeleton-bar--medium {
  width: 70%;
}
@keyframes upc-skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
.upc-bar {
  fill: #6366f1;
  cursor: pointer;
  transition:
    fill 0.15s,
    opacity 0.15s;
}
.upc-bar--active {
  fill: #4338ca;
}
.upc-bar--upstream {
  fill: #818cf8;
  opacity: 0.7;
}
.upc-bar--dim {
  opacity: 0.2;
}

.upc-link {
  fill: #6366f1;
  fill-opacity: 0.25;
  transition:
    fill-opacity 0.15s,
    fill 0.15s;
}
.upc-link:hover {
  fill-opacity: 0.55;
}
.upc-link--active {
  fill: #4338ca;
  fill-opacity: 0.65;
}
.upc-link--upstream {
  fill: #818cf8;
  fill-opacity: 0.3;
}
.upc-link--dim {
  fill-opacity: 0.04;
}

.upc-card {
  cursor: pointer;
  transition: opacity 0.15s;
}
.upc-card--dim {
  opacity: 0.3;
}
.upc-card-bg {
  fill: #fff;
  stroke: #e5e7eb;
  stroke-width: 1;
  transition:
    stroke 0.12s,
    fill 0.12s;
}
.upc-card:hover .upc-card-bg {
  stroke: #6366f1;
  stroke-width: 1.5;
}
.upc-card--active .upc-card-bg {
  stroke: #4338ca;
  stroke-width: 2;
  fill: #eef2ff;
}
.upc-card--upstream .upc-card-bg {
  stroke: #c7d2fe;
  stroke-width: 1.5;
  fill: #f5f3ff;
}
.upc-card-bg--active {
  stroke: #4f46e5;
  stroke-width: 2;
}
.upc-step-badge {
  fill: #f3f4f6;
}
.upc-step-text {
  fill: #6b7280;
  font-size: 11px;
  font-weight: 600;
}
.upc-label {
  fill: #111827;
  font-size: 12px;
  font-weight: 500;
}
.upc-count {
  fill: #111827;
  font-size: 12px;
  font-weight: 600;
}
</style>

<style>
/* Tooltip & popover dùng position fixed → giữ ngoài scoped để dễ override */
.upc-tooltip {
  position: fixed;
  pointer-events: none;
  background: #111827;
  color: #fff;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  white-space: nowrap;
  z-index: 1000;
}

.upc-popover {
  position: fixed;
  width: 380px;
  max-height: 80vh;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16);
  z-index: 1100;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: 13px;
  color: #111827;
}
.upc-pop-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* Reset margin-top của các block bên trong body (đã có gap) */
.upc-pop-body > * {
  margin-top: 0 !important;
}
.upc-pop-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid #f3f4f6;
  gap: 8px;
  cursor: grab;
  user-select: none;
  background: #fafbfc;
}
.upc-pop-header--dragging {
  cursor: grabbing;
}
.upc-pop-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.upc-pop-badge {
  background: #f3f4f6;
  color: #6b7280;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.upc-pop-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upc-pop-close {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: #6b7280;
  cursor: pointer;
  padding: 0 4px;
}
.upc-pop-close:hover {
  color: #111827;
}

/* Stats */
.upc-pop-stats {
  padding: 12px;
  border-bottom: 1px solid #f3f4f6;
  background: #fafbfc;
}
.upc-pop-stat-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.upc-pop-stat {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 6px 8px;
}
.upc-pop-stat--danger {
  border-color: #fecaca;
  background: #fef2f2;
}
.upc-pop-stat-label {
  font-size: 10px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.upc-pop-stat-value {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin-top: 2px;
}
.upc-pop-stat--danger .upc-pop-stat-value {
  color: #991b1b;
}
.upc-pop-stat-sub {
  font-size: 10px;
  font-weight: 500;
  color: #9ca3af;
  margin-left: 4px;
}

/* Properties stats dynamic */
.upc-pop-props {
  margin-top: 10px;
  padding: 10px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}
.upc-pop-props-title {
  font-size: 11px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.upc-pop-props-meta {
  font-size: 10px;
  font-weight: 500;
  color: #9ca3af;
  text-transform: none;
  letter-spacing: 0;
  margin-left: 4px;
}
.upc-pop-props-empty {
  font-size: 11px;
  color: #6b7280;
  line-height: 1.5;
  padding: 8px 10px;
  background: #f9fafb;
  border: 1px dashed #e5e7eb;
  border-radius: 5px;
}
.upc-pop-props-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.upc-pop-prop {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 5px;
  padding: 6px 8px;
}
.upc-pop-prop--wide {
  grid-column: span 2;
}
.upc-pop-prop-key {
  font-size: 10px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upc-pop-prop-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.upc-pop-prop-label {
  font-size: 10px;
  color: #9ca3af;
}
.upc-pop-prop-value {
  font-size: 14px;
  font-weight: 700;
  color: #4338ca;
  font-variant-numeric: tabular-nums;
}
.upc-pop-prop-row {
  display: flex;
  gap: 8px;
  font-size: 10.5px;
  color: #6b7280;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  flex-wrap: wrap;
}
.upc-pop-prop-row b {
  color: #111827;
}

.upc-pop-prop-dist-row {
  position: relative;
  display: flex;
  align-items: center;
  font-size: 11px;
  padding: 2px 4px;
  margin-bottom: 1px;
  border-radius: 3px;
  overflow: hidden;
}
.upc-pop-prop-dist-bar {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: #eef2ff;
  z-index: 0;
}
.upc-pop-prop-dist-val {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}
.upc-pop-prop-dist-num {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  margin-left: 6px;
  font-size: 10.5px;
  color: #4338ca;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Action buttons trong popover */
.upc-pop-action-row {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.upc-pop-action-btn {
  flex: 1;
  min-width: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 10px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: #374151;
  cursor: pointer;
  transition:
    background 0.12s,
    border-color 0.12s,
    color 0.12s;
  white-space: nowrap;
}
.upc-pop-action-btn:hover {
  background: #f9fafb;
  border-color: #9ca3af;
}
.upc-pop-action-btn--alert {
  border-color: #fcd34d;
  background: linear-gradient(135deg, #fffbeb 0%, #fef2f2 100%);
  color: #92400e;
}
.upc-pop-action-btn--alert:hover {
  border-color: #f59e0b;
  background: linear-gradient(135deg, #fef3c7 0%, #fee2e2 100%);
}
.upc-pop-action-btn--active {
  border-color: #6366f1;
  background: #eef2ff;
  color: #4338ca;
}
.upc-pop-action-btn--active:hover {
  border-color: #4f46e5;
  background: #e0e7ff;
}

/* Modal Phân tích nhanh */
.upc-analysis-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 24px;
}
.upc-analysis-modal {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 560px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.upc-analysis-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #e5e7eb;
  background: #fafbfc;
  gap: 12px;
}
.upc-analysis-modal-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: #111827;
}
.upc-analysis-modal-sub {
  font-size: 11px;
  color: #6b7280;
  margin-top: 2px;
}
.upc-analysis-modal-body {
  overflow-y: auto;
  padding: 14px 18px 18px;
  flex: 1;
  font-size: 13px;
  color: #374151;
}

/* User detail modal — rộng hơn để chứa bảng */
.upc-user-detail-modal {
  max-width: 1100px;
  min-height: 200px;
}
.upc-user-detail-table-wrap {
  overflow: auto;
  flex: 1;
  padding: 0;
}
.upc-user-detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.upc-user-detail-table thead th {
  position: sticky;
  top: 0;
  background: #f9fafb;
  font-weight: 600;
  color: #374151;
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.upc-user-detail-table thead th:hover {
  background: #f3f4f6;
}
.upc-udt-sort {
  color: #6366f1;
  font-size: 10px;
  margin-left: 4px;
}
.upc-udt-id-col {
  min-width: 280px;
}
.upc-udt-prop-col {
  min-width: 120px;
}
.upc-udt-action-col {
  width: 90px;
  cursor: default !important;
}
.upc-udt-action-col:hover {
  background: #f9fafb !important;
}

.upc-user-detail-table tbody td {
  padding: 6px 12px;
  border-bottom: 1px solid #f3f4f6;
  white-space: nowrap;
}
.upc-user-detail-table tbody tr:hover {
  background: #fafbfc;
}
.upc-udt-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #4338ca;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upc-udt-cell {
  font-size: 12px;
  color: #111827;
}
.upc-udt-cell--num {
  /* text-align: right; */
  font-variant-numeric: tabular-nums;
}
.upc-udt-empty {
  color: #d1d5db;
}
.upc-udt-actions {
  display: flex;
  gap: 8px;
  font-size: 14px;
}

/* Filter bar trong modal Chi tiết user */
.upc-udt-filter-bar {
  padding: 10px 16px;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.upc-udt-filter-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.upc-udt-filter-title {
  font-size: 12px;
  font-weight: 600;
  color: #374151;
}
.upc-udt-filter-add {
  padding: 4px 10px;
  border: 1px dashed #6366f1;
  background: #fff;
  color: #4338ca;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.upc-udt-filter-add:hover {
  background: #eef2ff;
}
.upc-udt-filter-clear {
  padding: 4px 10px;
  border: 1px solid #fecaca;
  background: #fff;
  color: #991b1b;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.upc-udt-filter-clear:hover {
  background: #fef2f2;
}
.upc-udt-filter-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.upc-udt-filter-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.upc-udt-filter-select,
.upc-udt-filter-op,
.upc-udt-filter-input {
  padding: 5px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  color: #111827;
}
.upc-udt-filter-select {
  min-width: 160px;
}
.upc-udt-filter-op {
  min-width: 110px;
}
.upc-udt-filter-input {
  flex: 1;
  min-width: 140px;
}
.upc-udt-filter-select:focus,
.upc-udt-filter-op:focus,
.upc-udt-filter-input:focus {
  outline: none;
  border-color: #6366f1;
}
.upc-udt-filter-remove {
  width: 26px;
  height: 26px;
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 6px;
  color: #6b7280;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.upc-udt-filter-remove:hover {
  background: #fef2f2;
  border-color: #fca5a5;
  color: #991b1b;
}
.upc-udt-empty-state {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: #6b7280;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

/* Phân tích nhanh — block-level styles (giữ cho ngữ cảnh trong modal) */
.upc-pop-analysis {
  margin-top: 12px;
  padding: 10px 12px;
  background: linear-gradient(135deg, #fef3c7 0%, #fef2f2 100%);
  border: 1px solid #fcd34d;
  border-radius: 6px;
}
.upc-pop-analysis-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.upc-pop-analysis-icon {
  font-size: 16px;
}
.upc-pop-analysis-title {
  font-size: 12px;
  font-weight: 600;
  color: #92400e;
}
.upc-pop-analysis-title b {
  color: #b91c1c;
}
.upc-pop-analysis-body {
  font-size: 12px;
  color: #374151;
}
.upc-pop-analysis-line {
  margin-bottom: 8px;
  line-height: 1.5;
}
.upc-pop-analysis-num {
  display: inline-block;
  font-weight: 700;
  color: #b91c1c;
  background: #fee2e2;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 4px;
}
.upc-pop-analysis-section {
  margin-top: 10px;
  background: #fff;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #fde68a;
}
.upc-pop-analysis-section-title {
  font-size: 11px;
  font-weight: 600;
  color: #92400e;
  margin-bottom: 6px;
}
.upc-pop-analysis-row {
  position: relative;
  display: flex;
  align-items: center;
  padding: 3px 6px;
  margin-bottom: 2px;
  border-radius: 3px;
  font-size: 11px;
  overflow: hidden;
}
.upc-pop-analysis-bar {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: #fef3c7;
  z-index: 0;
}
.upc-pop-analysis-name {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}
.upc-pop-analysis-meta {
  position: relative;
  z-index: 1;
  font-size: 11px;
  color: #92400e;
  font-weight: 600;
  flex-shrink: 0;
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}
.upc-pop-analysis-row--danger {
  background: #fee2e2;
}
.upc-pop-analysis-row--danger .upc-pop-analysis-name,
.upc-pop-analysis-row--danger .upc-pop-analysis-meta {
  color: #991b1b;
}
.upc-pop-analysis-insights {
  margin: 0;
  padding-left: 18px;
  font-size: 11px;
  color: #92400e;
  line-height: 1.5;
}
.upc-pop-analysis-insights li {
  margin-bottom: 2px;
}

.upc-pop-prev-title {
  font-size: 11px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.upc-pop-prev-row {
  position: relative;
  padding: 4px 8px;
  margin-bottom: 2px;
  border-radius: 4px;
  background: #fff;
  border: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  font-size: 12px;
  overflow: hidden;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.upc-pop-prev-row--active {
  border-color: #4338ca;
  box-shadow: 0 0 0 2px rgba(67, 56, 202, 0.18);
}
.upc-pop-prev-row--active .upc-pop-prev-bar {
  background: #c7d2fe;
}
.upc-pop-prev-row--active .upc-pop-prev-name {
  color: #4338ca;
  font-weight: 600;
}
.upc-pop-prev-bar {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: #eef2ff;
  z-index: 0;
}
.upc-pop-prev-name {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}
.upc-pop-prev-num {
  position: relative;
  z-index: 1;
  font-size: 11px;
  color: #4338ca;
  font-weight: 600;
  flex-shrink: 0;
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}

/* Donut chart cho "User đến từ" */
.upc-pop-donut-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}
.upc-pop-donut {
  flex-shrink: 0;
}
.upc-pop-donut-slice {
  transition: opacity 0.15s;
  cursor: pointer;
}
.upc-pop-donut-slice--dim {
  opacity: 0.25;
}
.upc-pop-donut-total {
  font-size: 14px;
  font-weight: 700;
  fill: #111827;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.upc-pop-donut-sub {
  font-size: 9px;
  fill: #6b7280;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}

.upc-pop-donut-legend {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 120px;
  overflow-y: auto;
}
.upc-pop-legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 11px;
  color: #374151;
  cursor: pointer;
  transition: background 0.12s;
  border: 1px solid transparent;
}
.upc-pop-legend-row:hover {
  background: #f9fafb;
}
.upc-pop-legend-row--active {
  background: #eef2ff;
  border-color: #c7d2fe;
}
.upc-pop-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
.upc-pop-legend-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upc-pop-legend-num {
  font-size: 10.5px;
  font-weight: 600;
  color: #4338ca;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.upc-pop-toolbar {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #f3f4f6;
}
.upc-pop-search {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
}
.upc-pop-search:focus {
  outline: none;
  border-color: #6366f1;
}
.upc-pop-btn {
  padding: 5px 10px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.upc-pop-btn:hover:not(:disabled) {
  background: #f9fafb;
}
.upc-pop-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.upc-pop-btn--ok {
  background: #ecfdf5;
  border-color: #10b981;
  color: #065f46;
}

.upc-pop-list {
  padding: 4px 0;
  /* không overflow ở đây — body wrapper đã scroll */
}
.upc-pop-row {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  gap: 8px;
  min-height: 28px;
}
.upc-pop-row:hover {
  background: #f9fafb;
}
.upc-pop-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 0;
  min-width: 0;
  cursor: pointer;
}
.upc-pop-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s;
}
.upc-pop-row:hover .upc-pop-actions {
  opacity: 1;
}
.upc-pop-link {
  font-size: 11px;
  color: #6366f1;
  text-decoration: none;
  cursor: pointer;
}
.upc-pop-link:hover {
  text-decoration: underline;
  color: #4f46e5;
}
.upc-pop-copy {
  font-size: 11px;
  color: #6b7280;
  cursor: pointer;
}
.upc-pop-copy:hover {
  color: #4f46e5;
}
.upc-pop-copy--ok {
  color: #059669 !important;
  opacity: 1 !important;
}
.upc-pop-empty {
  padding: 16px 12px;
  color: #9ca3af;
  font-size: 12px;
  text-align: center;
}
</style>
