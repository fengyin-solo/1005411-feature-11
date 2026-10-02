import { listRows, saveRows } from '@/data/local-store'
import {
  patrolDomain,
  resolveInspector,
  savePatrolDomain,
  type LedgerItem,
} from '@/data/domain-store'
import type { EntryRow } from '@/data/types'

const KEY = 'patrol'

// 状态机：四个环节严格按顺序前进，任何回退/跳级都会被挡住。
export const PATROL_STATUSES = ['待巡查', '已巡查', '发现异常', '已复核'] as const
export type PatrolStatus = (typeof PATROL_STATUSES)[number]

// 巡查结论评级表：1-5 是一条从极度危险到一切正常的量表。
// 受理范围只取中段（2 异常 / 3 基本稳定 / 4 未见异常），两端极值一律退回核对。
export type ConclusionGrade = {
  code: number
  label: string
  extreme: boolean
  abnormal: boolean
  keywords: RegExp
}

export const CONCLUSION_GRADES: ConclusionGrade[] = [
  { code: 1, label: '极度危险', extreme: true, abnormal: true, keywords: /极度危险|极端危险|极[大其]?险情|特别重大险情/ },
  { code: 2, label: '发现异常', extreme: false, abnormal: true, keywords: /异常|险情|裂缝|滑[坡塌动溜]?|沉降|变形|渗水|堵塞|坍塌|垮/ },
  { code: 3, label: '基本稳定', extreme: false, abnormal: false, keywords: /基本稳定|总体稳定|总体可控/ },
  { code: 4, label: '未见异常', extreme: false, abnormal: false, keywords: /未见异常|无异常|没有异常|正常|稳定|通畅|完好/ },
  { code: 5, label: '一切正常', extreme: false, abnormal: false, keywords: /一切正常|完全正常|绝对安全|毫无问题|十分正常|非常正常/ },
]
// 注意 code 5 自身也是极值，只是它的异常性为否；EXTREME_CODES 单独登记，避免和「异常」混淆。
export const EXTREME_CODES = [1, 5]

const ABNORMAL_SLOPE_SIGNAL = /裂缝|滑[坡塌动溜]?|沉降|变形|渗水|堵塞|坍塌|垮|异常|险情/
const NORMAL_SLOPE_SIGNAL = /正常|无异常|未见异常|通畅|完好|稳定/
// 否定式描述要先整片抹掉再判定：「未见异常」「未见新增裂缝」「无明显变化」都不是异常信号。
const NEGATED_SLOPE_SIGNAL =
  /(?:未见|未发现|没有发现?|无)(?:新增|明显|其他)?(?:异常|险情|裂缝|滑[坡塌动溜]?|沉降|变形|渗水|堵塞|坍塌|垮|变化)?/g

export type ParsedConclusion = {
  code: number
  label: string
  extreme: boolean
  abnormal: boolean
  unrecognized: boolean
}

export function parseConclusion(raw: unknown): ParsedConclusion {
  const text = String(raw ?? '').trim()
  const numeric = /^([1-5])$/.exec(text)
  if (numeric) {
    const grade = CONCLUSION_GRADES.find((item) => item.code === Number(numeric[1]))!
    return { ...grade, extreme: EXTREME_CODES.includes(grade.code), unrecognized: false }
  }
  // 关键词按优先级匹配：极值措辞先于普通措辞（「一切正常」必须先于「正常」，「极度危险」先于「异常」），
  // 「未见异常/无异常」也要先于泛指的「异常」，否则会被错判成发现异常。
  const ordered: ConclusionGrade[] = [
    CONCLUSION_GRADES[0],
    CONCLUSION_GRADES[4],
    CONCLUSION_GRADES[2],
    { ...CONCLUSION_GRADES[3], keywords: /未见异常|无异常|没有异常/ },
    CONCLUSION_GRADES[1],
    CONCLUSION_GRADES[3],
  ]
  for (const grade of ordered) {
    if (grade.keywords.test(text)) {
      return { ...grade, extreme: EXTREME_CODES.includes(grade.code), unrecognized: false }
    }
  }
  // 非空但无法识别的措辞不阻断批量：按「基本稳定」受理，同时挂待核标记交人工复核。
  return { code: 3, label: '基本稳定', extreme: false, abnormal: false, unrecognized: true }
}

// 巡查人填报的坡面/排水情况（巡查人侧的观察信号）与结论是否打架。
export function detectConclusionConflict(row: EntryRow, grade: ParsedConclusion): boolean {
  const observed = `${String(row['坡面情况'] ?? '')} ${String(row['排水情况'] ?? '')}`
  const positive = observed.replace(NEGATED_SLOPE_SIGNAL, '')
  const slopeLooksAbnormal = ABNORMAL_SLOPE_SIGNAL.test(positive)
  const slopeLooksNormal = NORMAL_SLOPE_SIGNAL.test(observed) && !slopeLooksAbnormal
  if (grade.abnormal && !grade.extreme && slopeLooksNormal) {
    return true
  }
  if (!grade.abnormal && slopeLooksAbnormal) {
    return true
  }
  return false
}

export type ItemOutcomeKind =
  | 'accepted' // 受理，已进入「已巡查」，结论正常
  | 'abnormal' // 受理，已进入「已巡查」，结论为异常（可整组上报）
  | 'setAside' // 巡查人/结论等关键信息缺失，先搁置，不挡其他记录
  | 'returned' // 结论取到极值，退回核对
  | 'duplicate' // 同一巡查编号重复提交，只认第一次
  | 'skipped' // 当前状态不允许该动作，跳过
  | 'conflict' // 结论与坡面观察打架（受理时附带提示，不单独占一种终态）

export type ItemOutcome = {
  rowId: number
  code: string
  kind: ItemOutcomeKind
  message: string
  inspector: string
  conclusionLabel: string
  conflict: boolean
}

export type BatchSubmitResult = {
  items: ItemOutcome[]
  acceptedCount: number
  abnormalCount: number
  setAsideCount: number
  returnedCount: number
  duplicateCount: number
  skippedCount: number
  submittedAt: string
}

type RowMetaPatch = {
  status: PatrolStatus
  abnormal?: boolean
  canonicalInspector?: string
  gradeCode?: number
  conflict?: boolean
  returnReason?: string
  submittedAt?: string
}

function applyMeta(row: EntryRow, patch: RowMetaPatch): EntryRow {
  const next: EntryRow = { ...row, status: patch.status }
  next.pending = patch.status !== '已复核'
  next.abnormal = patch.abnormal ?? (patch.status === '发现异常')
  if (patch.canonicalInspector !== undefined) {
    next['巡查人'] = patch.canonicalInspector
  }
  if (patch.gradeCode !== undefined) {
    next._conclusionCode = patch.gradeCode
  }
  if (patch.conflict !== undefined) {
    next._conclusionConflict = patch.conflict
  }
  if (patch.returnReason !== undefined) {
    next._returnReason = patch.returnReason
  }
  if (patch.submittedAt !== undefined) {
    next._submittedAt = patch.submittedAt
  }
  return next
}

function statusIndex(status: string): number {
  return PATROL_STATUSES.indexOf(status as PatrolStatus)
}

// 只许顺序前进：目标状态必须正好是当前状态的下一环。
export function canMoveForward(current: string, target: PatrolStatus): boolean {
  return statusIndex(current) + 1 === statusIndex(target)
}

function nowText(): string {
  return new Date().toISOString()
}

// 批量提交：勾选多条一次上交，逐条给出结果；彼此独立，一条被搁置/退回不影响其他记录。
export function submitPatrolBatch(ids: number[]): BatchSubmitResult {
  const submittedAt = nowText()
  const rows = listRows(KEY)
  const domain = patrolDomain()
  const items: ItemOutcome[] = []
  const seenInBatch = new Set<string>()

  const nextRows = [...rows]
  let domainDirty = false

  for (const id of ids) {
    const index = nextRows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      items.push({ rowId: id, code: '', kind: 'skipped', message: '记录不存在，已跳过', inspector: '', conclusionLabel: '', conflict: false })
      continue
    }
    const row = nextRows[index]
    const code = String(row['巡查编号'] ?? '').trim()

    if (statusIndex(String(row.status)) !== 0) {
      items.push({
        rowId: id,
        code,
        kind: 'skipped',
        message: `当前状态为「${row.status}」，仅「待巡查」记录可提交，已跳过`,
        inspector: displayInspector(row),
        conclusionLabel: String(row['巡查结论'] ?? ''),
        conflict: Boolean(row._conclusionConflict),
      })
      continue
    }

    if (!code) {
      items.push({ rowId: id, code: '', kind: 'setAside', message: '巡查编号缺失，先放到一边，补齐后再提交', inspector: displayInspector(row), conclusionLabel: '', conflict: false })
      continue
    }

    // 同一巡查编号：本批次内先出现的为准；历史已提交过的，永远只认第一次结果。
    const first = domain.firstSubmissions.find((item) => item.code === code)
    if (first) {
      items.push({
        rowId: id,
        code,
        kind: 'duplicate',
        message: `巡查编号 ${code} 已于 ${formatTime(first.submittedAt)} 提交过，结论「${first.conclusionLabel}」，重复提交只认第一次结果`,
        inspector: first.inspector,
        conclusionLabel: first.conclusionLabel,
        conflict: false,
      })
      continue
    }
    if (seenInBatch.has(code)) {
      items.push({
        rowId: id,
        code,
        kind: 'duplicate',
        message: `巡查编号 ${code} 在本次勾选里出现多次，只受理同批次第一条，本条按重复提交忽略`,
        inspector: displayInspector(row),
        conclusionLabel: String(row['巡查结论'] ?? ''),
        conflict: false,
      })
      continue
    }

    // 巡查人统一走名册归一（王队 → 王建国），所有页面读到的都是同一份 canonical 名称。
    const inspector = resolveInspector(row['巡查人'])
    const conclusionRaw = String(row['巡查结论'] ?? '').trim()
    if (!inspector || !conclusionRaw) {
      const missing = [
        inspector ? '' : '巡查人未填',
        conclusionRaw ? '' : '巡查结论空着',
      ]
        .filter(Boolean)
        .join('、')
      items.push({ rowId: id, code, kind: 'setAside', message: `${missing}，先放到一边，补齐后再提交，不影响其他记录`, inspector, conclusionLabel: conclusionRaw, conflict: false })
      continue
    }

    const grade = parseConclusion(conclusionRaw)

    // 极值（极度危险 / 一切正常，或评级 1、5）一律退回核对，状态留在待巡查，不计入首次结果。
    if (grade.extreme) {
      nextRows[index] = applyMeta(row, {
        status: '待巡查',
        abnormal: false,
        returnReason: `巡查结论「${grade.label}」取到量表极值（评级 ${grade.code}），请回到现场核对后重填`,
      })
      items.push({
        rowId: id,
        code,
        kind: 'returned',
        message: `巡查结论「${grade.label}」为极值（评级 ${grade.code}），一律退回核对，本条不进入流转`,
        inspector,
        conclusionLabel: grade.label,
        conflict: detectConclusionConflict(row, grade),
      })
      continue
    }

    seenInBatch.add(code)
    const conflict = detectConclusionConflict(row, grade)
    nextRows[index] = applyMeta(row, {
      status: '已巡查',
      abnormal: grade.abnormal,
      canonicalInspector: inspector,
      gradeCode: grade.code,
      conflict,
      submittedAt,
    })
    if ('_returnReason' in nextRows[index]) {
      delete (nextRows[index] as EntryRow & { _returnReason?: string })._returnReason
    }

    // 提交收尾：首份结果落凭证（后续重提一律忽略），并同步成避险场所台账的待核项。
    const ledgerId = `PATR-${code}`
    domain.firstSubmissions.push({
      code,
      rowId: id,
      submittedAt,
      outcome: grade.abnormal ? 'abnormal' : 'accepted',
      inspector,
      conclusionCode: String(grade.code),
      conclusionLabel: grade.label,
      ledgerEntryId: ledgerId,
    })
    const siteName = String(row['所属隐患点'] ?? '未登记隐患点')
    const noteBits: string[] = []
    if (conflict) {
      noteBits.push('巡查结论与巡查人填报的坡面/排水情况打架，按「结论优先」受理，请现场复核')
    }
    if (grade.unrecognized) {
      noteBits.push('结论措辞未能自动识别，按「基本稳定」受理，请人工核对')
    }
    if (grade.abnormal) {
      noteBits.push('结论为发现异常，需整组上报并跟进避险安置')
    }
    domain.ledger.push({
      id: ledgerId,
      source: 'patrol',
      refCode: code,
      siteName,
      inspector,
      submittedAt,
      conclusionLabel: grade.label,
      abnormal: grade.abnormal,
      note: noteBits.join('；') || '巡查收尾同步，待避险场所台账核办',
      checked: false,
    })
    domainDirty = true

    items.push({
      rowId: id,
      code,
      kind: grade.abnormal ? 'abnormal' : 'accepted',
      message: grade.abnormal
        ? `已受理为「已巡查」，结论「${grade.label}」，可勾选项组上报异常`
        : `已受理为「已巡查」，结论「${grade.label}」，待核项已同步避险场所台账`,
      inspector,
      conclusionLabel: grade.label,
      conflict,
    })
  }

  saveRows(KEY, nextRows)
  if (domainDirty) {
    savePatrolDomain(domain)
  }

  const count = (kind: ItemOutcomeKind) => items.filter((item) => item.kind === kind).length
  return {
    items,
    acceptedCount: count('accepted'),
    abnormalCount: count('abnormal'),
    setAsideCount: count('setAside'),
    returnedCount: count('returned'),
    duplicateCount: count('duplicate'),
    skippedCount: count('skipped'),
    submittedAt,
  }
}

export type GroupActionResult = {
  items: ItemOutcome[]
  movedCount: number
  target: PatrolStatus
}

function runGroupStep(ids: number[], expected: PatrolStatus, target: PatrolStatus, verb: string): GroupActionResult {
  if (!canMoveForward(expected, target)) {
    throw new Error(`状态流转配置错误：${expected} 不能直接跳到 ${target}`)
  }
  const rows = listRows(KEY)
  const nextRows = [...rows]
  const items: ItemOutcome[] = []
  let moved = 0
  for (const id of ids) {
    const index = nextRows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      items.push({ rowId: id, code: '', kind: 'skipped', message: '记录不存在，已跳过', inspector: '', conclusionLabel: '', conflict: false })
      continue
    }
    const row = nextRows[index]
    const code = String(row['巡查编号'] ?? '')
    if (String(row.status) === target) {
      items.push({ rowId: id, code, kind: 'skipped', message: `已经是「${target}」，无需重复${verb}`, inspector: displayInspector(row), conclusionLabel: String(row['巡查结论'] ?? ''), conflict: Boolean(row._conclusionConflict) })
      continue
    }
    if (String(row.status) !== expected || (expected === '已巡查' && !row.abnormal)) {
      const reason = expected === '已巡查' && String(row.status) === expected && !row.abnormal
        ? '结论不是发现异常，不属于异常组'
        : `只有「${expected}」${expected === '已巡查' ? '且结论为异常' : ''}的记录能${verb}`
      items.push({ rowId: id, code, kind: 'skipped', message: `${reason}，当前为「${row.status}」，已跳过`, inspector: displayInspector(row), conclusionLabel: String(row['巡查结论'] ?? ''), conflict: Boolean(row._conclusionConflict) })
      continue
    }
    nextRows[index] = applyMeta(row, {
      status: target,
      abnormal: target === '发现异常',
      submittedAt: nowText(),
    })
    moved += 1
    items.push({ rowId: id, code, kind: 'accepted', message: `已随组${verb}，状态「${target}」`, inspector: displayInspector(row), conclusionLabel: String(row['巡查结论'] ?? ''), conflict: Boolean(row._conclusionConflict) })
  }
  saveRows(KEY, nextRows)
  return { items, movedCount: moved, target }
}

// 发现异常的那几条可以整组上报：已巡查(异常) → 发现异常。
export function reportAbnormalGroup(ids: number[]): GroupActionResult {
  return runGroupStep(ids, '已巡查', '发现异常', '上报异常')
}

// 发现异常 → 已复核，同样按组推进。
export function reviewAbnormalGroup(ids: number[]): GroupActionResult {
  return runGroupStep(ids, '发现异常', '已复核', '确认复核')
}

export { listRows }

export function displayInspector(row: EntryRow): string {
  return resolveInspector(row['巡查人'])
}

export function formatTime(iso: string): string {
  if (!iso) {
    return '—'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function isCurrentMonth(iso: unknown): boolean {
  if (!iso) {
    return false
  }
  const date = new Date(String(iso))
  if (Number.isNaN(date.getTime())) {
    return false
  }
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
}

export function createPatrolDraft(input: Record<string, string>, id?: number): EntryRow {
  const rows = listRows(KEY)
  if (id === undefined) {
    const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    return {
      id: nextId,
      status: '待巡查',
      pending: true,
      abnormal: false,
      巡查编号: input['巡查编号'] ?? '',
      所属隐患点: input['所属隐患点'] ?? '',
      巡查人: (input['巡查人'] ?? '').trim(),
      巡查日期: input['巡查日期'] ?? '',
      坡面情况: input['坡面情况'] ?? '',
      排水情况: input['排水情况'] ?? '',
      巡查结论: input['巡查结论'] ?? '',
      巡查状态: '',
    }
  }
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    throw new Error(`没有找到编号为 ${id} 的巡查记录`)
  }
  const current = rows[index]
  if (String(current.status) !== '待巡查') {
    throw new Error('只有「待巡查」记录允许补录修改，后续环节不许回退改单')
  }
  return {
    ...current,
    巡查编号: input['巡查编号'] ?? current['巡查编号'],
    所属隐患点: input['所属隐患点'] ?? current['所属隐患点'],
    巡查人: (input['巡查人'] ?? '').trim(),
    巡查日期: input['巡查日期'] ?? current['巡查日期'],
    坡面情况: input['坡面情况'] ?? current['坡面情况'],
    排水情况: input['排水情况'] ?? current['排水情况'],
    巡查结论: input['巡查结论'] ?? current['巡查结论'],
    _returnReason: '',
  }
}

export function savePatrolDraft(row: EntryRow): void {
  const rows = listRows(KEY)
  const index = rows.findIndex((item) => Number(item.id) === Number(row.id))
  const cleaned: EntryRow = { ...row }
  if (cleaned._returnReason === '') {
    delete (cleaned as EntryRow & { _returnReason?: string })._returnReason
  }
  if (index < 0) {
    saveRows(KEY, [...rows, cleaned])
    return
  }
  const next = [...rows]
  next[index] = cleaned
  saveRows(KEY, next)
}

// 避险场所台账：巡查收尾同步来的待核项都从这里读，保证多处看到的是同一份。
export function listPatrolLedger(): LedgerItem[] {
  return [...patrolDomain().ledger].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
}

export function pendingLedgerCount(): number {
  return patrolDomain().ledger.filter((item) => !item.checked).length
}

export function checkLedgerItem(ledgerId: string, note: string): boolean {
  const domain = patrolDomain()
  const index = domain.ledger.findIndex((item) => item.id === ledgerId)
  if (index < 0 || domain.ledger[index].checked) {
    return false
  }
  const next = {
    ...domain,
    ledger: domain.ledger.map((item, i) =>
      i === index
        ? { ...item, checked: true, note: note.trim() ? `${item.note}；核办：${note.trim()}` : `${item.note}；已核办`, checkedAt: nowText() }
        : item,
    ),
  }
  savePatrolDomain(next)
  return true
}

export function rowReturnReason(row: EntryRow): string {
  return String(row._returnReason ?? '')
}

export function rowConflict(row: EntryRow): boolean {
  return Boolean(row._conclusionConflict)
}

export function rowSubmittedAt(row: EntryRow): string {
  return String(row._submittedAt ?? '')
}
