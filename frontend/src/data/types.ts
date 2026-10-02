/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 批量勾选一次上交时，单条记录的处理结论。 */
export type BatchItemState = 'success' | 'skipped' | 'returned' | 'duplicate' | 'rejected'

export type BatchItemResult = {
  id: number
  code: string
  state: BatchItemState
  /** 成功后进入的环节；未成功时保持原环节。 */
  status: string
  message: string
}

export type BatchActionResult = {
  action: string
  total: number
  success: number
  skipped: number
  returned: number
  duplicate: number
  rejected: number
  items: BatchItemResult[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
