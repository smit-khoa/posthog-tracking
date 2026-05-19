import { ref } from 'vue'

// Map PostHog query response (columns + results) → array of objects
function rowsToObjects(columns, results) {
  return results.map((row) => {
    const obj = {}
    columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

export function usePosthogQuery() {
  const loading = ref(false)
  const error = ref(null)
  const data = ref(null)
  const lastRunAt = ref(null)

  async function run(query) {
    loading.value = true
    error.value = null

    const projectId = import.meta.env.VITE_POSTHOG_PROJECT_ID
    if (!projectId) {
      loading.value = false
      error.value = 'Thiếu VITE_POSTHOG_PROJECT_ID trong .env'
      return null
    }

    try {
      const res = await fetch(`/api/posthog/projects/${projectId}/query/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: { kind: 'HogQLQuery', query },
        }),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`PostHog ${res.status}: ${text.slice(0, 300)}`)
      }

      const json = await res.json()
      const objects = rowsToObjects(json.columns || [], json.results || [])
      data.value = objects
      lastRunAt.value = new Date()
      return objects
    } catch (e) {
      error.value = e.message || String(e)
      return null
    } finally {
      loading.value = false
    }
  }

  return { loading, error, data, lastRunAt, run }
}
