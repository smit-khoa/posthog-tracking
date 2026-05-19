// Phát hiện "khách sộp" (high-spend users) từ event_props_raw của mỗi row.
//
// Tiêu chí (OR — chỉ cần thỏa 1):
//   - spend_range === '>100'         (FE/BE đã phân loại sẵn vào bucket cao nhất)
//   - total_spend  >  100000000000 (ngưỡng 100 tỉ VND — tự định nghĩa)
//
// event_props_raw được PostHog trả về dạng:
//   [ [event_name, properties_json_string], ... ]
// trong đó properties_json_string là JSON-string-của-JSON-string
// (do query dùng toJSONString rồi bị serialize 1 lần nữa khi trả về),
// → parse JSON 2 lần mới ra object thật.

// khách sộp > 100 tỷ
const SPEND_THRESHOLD = 100000000000
const SPEND_RANGE_FLAG = '>100'

export const WHALES_CONSTANTS = {
  SPEND_THRESHOLD,
  SPEND_RANGE_FLAG,
}

// Parse chuỗi properties → object. Trả null nếu không parse được.
function safeParse(raw) {
  if (!raw) return null
  try {
    let v = raw
    if (typeof v === 'string') v = JSON.parse(v)
    if (typeof v === 'string') v = JSON.parse(v) // double-encoded
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

// Scan tất cả properties của 1 user → lấy max(total_spend) + spend_range gần nhất.
function summarizeUserSpend(events) {
  let maxSpend = 0
  let spendRange = ''
  let hasFlagRange = false

  for (const ev of events) {
    const props = safeParse(ev?.[1])
    if (!props) continue

    // total_spend: lấy giá trị lớn nhất xuất hiện trong các event của user
    const ts = Number(props.total_spend)
    if (Number.isFinite(ts) && ts > maxSpend) maxSpend = ts

    // spend_range: lưu giá trị đầu tiên gặp; flag riêng nếu hit ngưỡng
    if (props.spend_range != null && spendRange === '') {
      spendRange = String(props.spend_range)
    }
    if (props.spend_range === SPEND_RANGE_FLAG) hasFlagRange = true
  }

  return { maxSpend, spendRange, hasFlagRange }
}

export function extractWhales(rawData) {
  if (!Array.isArray(rawData)) return []

  const whales = []
  for (const row of rawData) {
    const events = row?.event_props_raw
    if (!Array.isArray(events) || events.length === 0) continue

    const { maxSpend, spendRange, hasFlagRange } = summarizeUserSpend(events)
    const overThreshold = maxSpend > SPEND_THRESHOLD
    if (!hasFlagRange && !overThreshold) continue

    whales.push({
      person_id: row.person_id,
      distinct_id: row.distinct_id,
      latest_session_id: row.latest_session_id,
      total_spend: maxSpend,
      spend_range: spendRange || (hasFlagRange ? SPEND_RANGE_FLAG : ''),
      user_status: row.user_status,
      started_at: row.started_at,
      total_steps: row.total_steps,
      reasons: [
        hasFlagRange ? `spend_range = '${SPEND_RANGE_FLAG}'` : null,
        overThreshold ? `total_spend > ${SPEND_THRESHOLD.toLocaleString('vi-VN')}` : null,
      ].filter(Boolean),
    })
  }

  // Spend cao hiển thị trước
  whales.sort((a, b) => b.total_spend - a.total_spend)
  return whales
}
