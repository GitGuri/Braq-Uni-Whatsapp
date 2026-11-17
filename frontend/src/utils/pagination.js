/**
 * Total row count for server-side antd Table pagination.
 * Uses the API's `total` when present; otherwise (older API without a count) it
 * infers one so the "next page" button stays available while pages come back full.
 */
export function pagedTotal(data, rows, page, pageSize) {
  const total = Number(data?.total)
  if (data?.total != null && Number.isFinite(total)) return total
  const seen = (page - 1) * pageSize + rows.length
  return rows.length >= pageSize ? seen + 1 : seen
}
