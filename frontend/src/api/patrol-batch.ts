import { moduleMeta } from './local-service'
import { listRows, saveRows } from '@/data/local-store'
import { inspectorPhone, resolveInspector } from '@/data/inspectors'
import type {
  BatchActionResult,
  BatchItemResult,
  BatchItemState,
  EntryRow,
} from '@/data/types'

/**
 * 群测群防巡查：多选一次上交的专用服务。
 *
 * 环节流转（不许回退、不许跳级，只能按下标顺序前进）：
 *   待巡查 ──提交巡查──▶ 已巡查 ──上报异常──▶ 发现异常 ──确认复核──▶ 已复核
 *
 * 上交时的校验优先级（同一条同时命中多条时，只认排在前面的结论）：
 *   1. 重复提交：同一巡查编号只认第一次的结果。状态已越过该环节（历史已交过）
 *      或本批已有同编号先处理的，一律判重复，不再覆盖。
 *   2. 状态顺序：当前环节与动作要求不符的，跳级的拦下，不存在回退入口。
 *   3. 极值退回：巡查结论取到极值（极差 / 极度危险 / 极不稳定）一律退回核对，记录不流转。
 *   4. 暂缓一旁：巡查人没填或巡查结论空着，先放到一边，不挡住同批其他记录。
 *
 * 「巡查结论」与「巡查人」打架时的优先级：
 *   结论极值是硬性退回，优先于巡查人缺失——两者同时命中按「退回核对」处理，
 *   而不是「暂缓」。退回与暂缓都不改环节，互不影响放行。
 */

const KEY = 'patrol'
const REFUGE_KEY = 'refuge'

// 动作 →（要求的当前环节，目标环节）；目标环节取状态表里的下一槽，天然禁止跳级/回退。
const FLOW: Record<string, { from: string; to: string }> = {
  提交巡查: { from: '待巡查', to: '已巡查' },
  上报异常: { from: '已巡查', to: '发现异常' },
  确认复核: { from: '发现异常', to: '已复核' },
}

// 巡查结论取到这些极值，一律退回核对。
const EXTREME_CONCLUSIONS = ['极差', '极度危险', '极不稳定']

const CODE_FIELD = '巡查编号'
const INSPECTOR_FIELD = '巡查人'
const CONCLUSION_FIELD = '巡查结论'
const DATE_FIELD = '巡查日期'
const HAZARD_FIELD = '所属隐患点'

function codeOf(row: EntryRow): string {
  return String(row[CODE_FIELD] ?? '').trim()
}

function conclusionOf(row: EntryRow): string {
  return String(row[CONCLUSION_FIELD] ?? '').trim()
}

function isExtremeConclusion(row: EntryRow): boolean {
  const conclusion = conclusionOf(row)
  return EXTREME_CONCLUSIONS.some((token) => conclusion.includes(token))
}

/** 同步到避险场所台账：每交成一条「提交巡查」，台账添一条待核项。 */
function syncToRefugeLedger(patrolRow: EntryRow): void {
  const ledger = listRows(REFUGE_KEY)
  const code = codeOf(patrolRow)
  const placeCode = `WCHK-${code}`
  // 同一巡查编号只认第一次，台账也只挂一次，重复上交不会重复挂账。
  if (ledger.some((item) => String(item['场所编号'] ?? '') === placeCode)) {
    return
  }
  const inspector = resolveInspector(patrolRow[INSPECTOR_FIELD])
  const nextId = ledger.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const entry: EntryRow = {
    id: nextId,
    status: '待核验',
    pending: true,
    abnormal: false,
    场所编号: placeCode,
    场所名称: `【待核】${String(patrolRow[HAZARD_FIELD] ?? '')} 巡查复核点`,
    待核项: `巡查编号 ${code}（${String(patrolRow[DATE_FIELD] ?? '')}）已巡查，结论：${conclusionOf(patrolRow)}，待现场复核`,
    可容纳人数: '',
    开放条件: '巡查发现情况待复核核定',
    场所负责人: inspector,
    联系电话: inspectorPhone(inspector),
    启用日期: '',
    场所状态: '待核验',
  }
  saveRows(REFUGE_KEY, [...ledger, entry])
}

function makeItem(
  row: EntryRow,
  state: BatchItemState,
  status: string,
  message: string,
): BatchItemResult {
  return { id: Number(row.id), code: codeOf(row), state, status, message }
}

export function batchPatrolAction(action: string, ids: number[]): BatchActionResult {
  const meta = moduleMeta(KEY)
  const flow = FLOW[action]
  if (!flow) {
    throw new Error(`巡查记录没有登记「${action}」这个动作`)
  }

  const result: BatchActionResult = {
    action,
    total: ids.length,
    success: 0,
    skipped: 0,
    returned: 0,
    duplicate: 0,
    rejected: 0,
    items: [],
  }
  if (ids.length === 0) {
    return result
  }

  const statusOrder = meta.statuses
  const fromIndex = statusOrder.indexOf(flow.from)
  const toIndex = statusOrder.indexOf(flow.to)
  const lastStatus = statusOrder[statusOrder.length - 1]

  const rows = listRows(KEY)
  const byId = new Map(rows.map((row) => [Number(row.id), row]))
  // 本批已出现过的巡查编号：同编号第二次出现起一律重复，只认第一次。
  const seenCodes = new Set<string>()
  let changed = false

  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      result.items.push({
        id,
        code: '—',
        state: 'rejected',
        status: '—',
        message: `没有找到编号为 ${id} 的巡查记录`,
      })
      result.rejected += 1
      continue
    }

    const code = codeOf(row)
    const current = String(row.status)
    const currentIndex = statusOrder.indexOf(current)

    // 优先级 1：同一巡查编号重复提交，只认第一次的结果。
    if (seenCodes.has(code)) {
      result.items.push(
        makeItem(row, 'duplicate', current, '同一巡查编号本批已交过，只认第一次的结果，本条未重复处理'),
      )
      result.duplicate += 1
      continue
    }

    // 历史上同编号记录已越过当前环节，同样按重复拦截。
    const alreadyDone = rows.some(
      (item) =>
        Number(item.id) !== Number(row.id) &&
        codeOf(item) === code &&
        statusOrder.indexOf(String(item.status)) > fromIndex,
    )
    if (alreadyDone) {
      result.items.push(
        makeItem(row, 'duplicate', current, '该巡查编号此前已提交成功，只认第一次的结果，本条不再覆盖'),
      )
      result.duplicate += 1
      continue
    }

    // 优先级 2：环节只能顺序前进。
    //   - 已越过本环节（currentIndex > fromIndex）：本动作此前已交过，按重复提交处理，只认第一次；
    //     线性状态机下不存在“回到旧环节”的入口，任何往回的尝试都落在这里。
    //   - 还没走到本环节（currentIndex < fromIndex）：前置环节未完成，属跳级，拦下。
    if (currentIndex > fromIndex) {
      result.items.push(
        makeItem(row, 'duplicate', current, `该巡查编号已完成过「${action}」，只认第一次的结果，本条不重复处理、环节不回退`),
      )
      result.duplicate += 1
      continue
    }
    if (currentIndex < fromIndex) {
      result.items.push(
        makeItem(row, 'rejected', current, `当前环节为「${current}」，须先完成前置环节才能${action}，不许跳级`),
      )
      result.rejected += 1
      continue
    }

    // 走到这里才算「第一次受理」该编号：状态被拦的不占位，同编号的有效记录仍可按第一次受理。
    seenCodes.add(code)

    // 「提交巡查」做内容校验；其余整组动作按状态机流转。
    if (action === '提交巡查') {
      // 优先级 3（结论优先于人）：巡查结论取到极值，一律退回核对。
      if (isExtremeConclusion(row)) {
        const returnedRow: EntryRow = {
          ...row,
          abnormal: true,
          退回原因: `巡查结论「${conclusionOf(row)}」取到极值，退回核对`,
        }
        byId.set(Number(row.id), returnedRow)
        changed = true
        result.items.push(
          makeItem(row, 'returned', current, `巡查结论「${conclusionOf(row)}」为极值结论，一律退回核对，暂不流转`),
        )
        result.returned += 1
        continue
      }

      // 优先级 4：巡查人没填或巡查结论空着，先放到一边，不挡其他记录。
      const inspector = resolveInspector(row[INSPECTOR_FIELD])
      const conclusion = conclusionOf(row)
      const missing: string[] = []
      if (inspector === '') {
        missing.push('巡查人')
      }
      if (conclusion === '') {
        missing.push('巡查结论')
      }
      if (missing.length > 0) {
        result.items.push(
          makeItem(row, 'skipped', current, `${missing.join('、')}未填，先放到一边补齐再交，不影响同批其他记录`),
        )
        result.skipped += 1
        continue
      }
    }

    // 放行：顺序流转到下一环节；巡查人统一按花名册归一后再落库（多处读取同一份）。
    const target = flow.to
    const updated: EntryRow = {
      ...row,
      status: target,
      pending: target !== lastStatus,
      abnormal: target === '发现异常',
      [INSPECTOR_FIELD]: resolveInspector(row[INSPECTOR_FIELD]) || row[INSPECTOR_FIELD],
    }
    delete updated.退回原因
    byId.set(Number(row.id), updated)
    changed = true

    if (action === '提交巡查') {
      syncToRefugeLedger(updated)
    }

    result.items.push(makeItem(row, 'success', target, `已${action}，环节流转为「${target}」`))
    result.success += 1
  }

  if (changed) {
    saveRows(
      KEY,
      rows.map((row) => byId.get(Number(row.id)) ?? row),
    )
  }
  return result
}
