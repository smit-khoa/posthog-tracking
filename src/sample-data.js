// Sample data — chỉ dùng để preview UI khi chưa kết nối PostHog
export const sampleRawData = [
  // {
  //   person_id: 'eb2c1d84-deb2-5e60-a544-d1ca7d9d8400',
  //   total_steps: 24,
  //   duration_minutes: 331.9,
  //   started_at: '2026-05-17T09:35:00.314000Z',
  //   user_status: '✅ Đã vào dashboard',
  //   scroll_count: 1,
  //   pricing_interest: 0,
  //   clicked_consultation: 0,
  //   clicked_buy: 1,
  //   clicked_dashboard: 7,
  //   full_journey:
  //     '15:May:56\nClick vào dashboard ở trang chủ → 15:May:50\nTruy cập trang chủ → 10:May:26\nClick mua gói Operation → 10:May:00\nClick vào dashboard ở trang bảng giá → 10:May:13\nClick vào dashboard ở trang chủ → 09:May:32\nClick vào dashboard ở trang chủ → 09:May:13\nScroll 25% trang chủ → 10:May:36\nTruy cập trang chủ → 09:May:00\nTruy cập trang chủ → 10:May:08\nTruy cập trang chủ → 10:May:45\nTruy cập trang chủ → 10:May:36\nTruy cập trang chủ → 09:May:11\nTruy cập trang chủ → 10:May:34\nTruy cập trang chủ → 10:May:33\nTruy cập trang chủ → 10:May:32\nTruy cập trang chủ → 10:May:32\nTruy cập trang chủ → 10:May:00\nTruy cập trang chủ → 13:May:38\nClick vào dashboard ở trang chủ → 13:May:53\nClick vào dashboard ở trang chủ → 13:May:04\nClick vào dashboard ở trang chủ → 13:May:51\nTruy cập trang chủ → 13:May:34\nTruy cập trang chủ → 13:May:02\nTruy cập trang chủ',
  // },
  // {
  //   person_id: '4f3d92eb-74b2-5268-99be-ab095d59ead7',
  //   total_steps: 14,
  //   duration_minutes: 7.5,
  //   started_at: '2026-05-17T10:46:03.031000Z',
  //   user_status: '✅ Đã vào dashboard',
  //   scroll_count: 8,
  //   pricing_interest: 0,
  //   clicked_consultation: 0,
  //   clicked_buy: 0,
  //   clicked_dashboard: 2,
  //   full_journey:
  //     '10:May:58\nClick vào dashboard ở trang tính năng → 10:May:20\nClick vào dashboard ở trang tính năng → 10:May:21\nScroll 100% trang chủ → 10:May:14\nScroll 100% trang tính năng → 10:May:15\nScroll 25% trang chủ → 10:May:09\nScroll 25% trang tính năng → 10:May:16\nScroll 50% trang chủ → 10:May:11\nScroll 50% trang tính năng → 10:May:19\nScroll 75% trang chủ → 10:May:12\nScroll 75% trang tính năng → 10:May:10\nTruy cập trang chủ → 10:May:15\nTruy cập trang chủ → 10:May:03\nTruy cập trang chủ → 10:May:33\nTruy cập trang chủ',
  // },
  // {
  //   person_id: '31948b56-909d-5401-8577-adcd5340944c',
  //   total_steps: 8,
  //   duration_minutes: 0.8,
  //   started_at: '2026-05-17T10:38:07.605000Z',
  //   user_status: '💰 Đã click mua',
  //   scroll_count: 4,
  //   pricing_interest: 1,
  //   clicked_consultation: 0,
  //   clicked_buy: 1,
  //   clicked_dashboard: 0,
  //   full_journey:
  //     '10:May:55\nClick mua gói Finance → 10:May:35\nScroll 100% trang tại sao SMIT Agency → 10:May:33\nScroll 25% trang tại sao SMIT Agency → 10:May:33\nScroll 50% trang tại sao SMIT Agency → 10:May:34\nScroll 75% trang tại sao SMIT Agency → 10:May:07\nTruy cập trang chủ → 10:May:14\nTruy cập trang chủ → 10:May:48\nXem cách tính giá',
  // },
]

export const defaultQuery = `WITH website_events AS (
    SELECT
        person_id,
        distinct_id,
        timestamp,
        event,
        properties.$session_id AS session_id,
        -- Giữ toàn bộ properties để aggregate ra cột event_props ở SELECT chính.
        -- Loại bỏ các key system của posthog ($...) để payload nhẹ.
        properties
    FROM events
    WHERE timestamp >= '{{START_TIME}}'
        AND timestamp <= '{{END_TIME}}'
        {{ENV_FILTER}}
        AND event NOT LIKE '$%'
        AND event NOT LIKE 'mcp%'
        AND event NOT LIKE 'posthog_%'
        AND event NOT LIKE 'Application%'
        AND event NOT LIKE 'Deep link%'
)
SELECT
    person_id,
    -- PostHog person page lookup theo distinct_id, không phải person_id (UUID nội bộ).
    -- any() để chọn 1 distinct_id đại diện (1 user có thể có nhiều distinct_id).
    any(distinct_id)                                                     AS distinct_id,
    -- Session ID mới nhất → link thẳng đến replay
    argMax(session_id, timestamp)                                        AS latest_session_id,
    count()                                                              AS total_steps,
    round(dateDiff('second', min(timestamp), max(timestamp)) / 60.0, 1) AS duration_minutes,
    min(timestamp)                                                       AS started_at,
    multiIf(
        sumIf(1, event LIKE '%mua%')       > 0, '💰 Đã click mua',
        sumIf(1, event LIKE '%tư vấn%')    > 0, '🤝 Đã click tư vấn',
        sumIf(1, event LIKE '%dashboard%') > 0, '📊 Xem dashboard',
        sumIf(1, event LIKE '%giá%')       > 0, '👀 Xem giá',
        '🔍 Chỉ xem'
    )                                                                    AS user_status,
    sumIf(1, event LIKE '%Scroll%')                                     AS scroll_count,
    sumIf(1, event LIKE '%giá%')                                        AS pricing_interest,
    sumIf(1, event LIKE '%tư vấn%')                                     AS clicked_consultation,
    sumIf(1, event LIKE '%mua%')                                        AS clicked_buy,
    sumIf(1, event LIKE '%dashboard%')                                  AS clicked_dashboard,
    arrayStringConcat(
        arrayMap(
            x -> concat(
                formatDateTime(toTimeZone(x.1, 'Asia/Ho_Chi_Minh'), '%H:%b:%S'),
                '\n',
                x.2
            ),
            arrayReverse(
                arraySort(
                    x -> toUnixTimestamp(x.1),
                    groupArray((timestamp, event))
                )
            )
        ),
        ' → '
    )                                                                    AS full_journey,
    -- groupArray cặp (event_name, properties_json_string).
    -- Dùng toJSONString() để đảm bảo properties luôn trả về dạng string JSON,
    -- UI parse ra object rồi discover keys + aggregate sum/avg/distribution.
    groupArray(tuple(event, toJSONString(properties)))                   AS event_props_raw
FROM website_events
GROUP BY person_id
ORDER BY started_at ASC
LIMIT {{LIMIT}}`
