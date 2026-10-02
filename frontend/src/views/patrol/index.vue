<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>群测群防巡查管理</h2>
        <p class="page-desc">一次巡线勾选多条批量上交：逐条给出受理结果，缺项先搁置、极值退核对、异常可整组上报；状态按 待巡查 → 已巡查 → 发现异常 → 已复核 顺序流转，不许回退。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡查记录</button>
        <button class="btn" type="button" @click="exportRows">导出群测群防巡查清单</button>
        <RouterLink class="btn ghost" to="/refuge">避险场所台账（待核 {{ ledgerPending }}）</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="rules-card">
      <h3>批量上交规则（优先级从上到下）</h3>
      <ol>
        <li><b>顺序流转</b>：待巡查 → 已巡查 → 发现异常 → 已复核，只能逐环前进，任何回退、跳级一律拒绝。</li>
        <li><b>关键项缺失先搁置</b>：巡查人没填或巡查结论空着的记录放到一边、留在「待巡查」，不挡住同批其他记录。</li>
        <li><b>极值退回核对</b>：巡查结论取到量表极值（评级 1「极度危险」或评级 5「一切正常」）一律退回核对，不进入流转。</li>
        <li><b>编号去重</b>：同一巡查编号重复提交，只认第一次的结果（同批次也只受理第一条），后面的直接忽略。</li>
        <li><b>巡查结论与巡查人打架时，结论优先</b>：是否异常、能否流转只看巡查结论；坡面/排水观察仅作旁证，打架的记录照结论受理，同时挂「待复核」标记。</li>
        <li><b>巡查人单一数据源</b>：王队/王建国队长 → 王建国、李姐 → 李秀英、小张/海涛 → 张海涛，所有页面读取到的都是名册里的同一个名字。</li>
        <li><b>收尾同步台账</b>：受理结果同步到避险场所台账生成「待核项」，由场所侧核办核销。</li>
      </ol>
      <p class="rules-scale">
        结论量表：
        <span class="grade extreme">1 极度危险（极值退回）</span>
        <span class="grade abnormal">2 发现异常</span>
        <span class="grade">3 基本稳定</span>
        <span class="grade">4 未见异常</span>
        <span class="grade extreme">5 一切正常（极值退回）</span>
      </p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <label class="select-all">
        <input type="checkbox" :checked="allVisibleSelected" :indeterminate.prop="someVisibleSelected" @change="toggleSelectAll" />
        全选当前列表（{{ rows.length }} 条，已勾 {{ selectedIds.length }} 条）
      </label>
      <span class="batch-spacer"></span>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="submitSelected">
        批量提交巡查（{{ selectedIds.length }}）
      </button>
      <button class="btn warn" type="button" :disabled="!selectedAbnormalIds.length" @click="reportSelectedAbnormal">
        整组上报异常（{{ selectedAbnormalIds.length }}）
      </button>
      <button class="btn" type="button" :disabled="!selectedReviewIds.length" @click="reviewSelected">
        批量确认复核（{{ selectedReviewIds.length }}）
      </button>
      <button class="btn ghost" type="button" :disabled="!selectedIds.length" @click="selectedIds = []">清空勾选</button>
    </div>
    <p v-if="!selectedIds.length" class="batch-hint">勾选后可一次上交多条；缺项、极值、重复编号都会逐条给出结果，互不影响。</p>

    <div v-if="batchResult" class="result-panel">
      <header class="result-head">
        <strong>本次逐条结果</strong>
        <span class="result-summary">
          受理 {{ batchResult.kind === 'submit' ? batchResult.acceptedCount : batchResult.movedCount }} 条
          <template v-if="batchResult.kind === 'submit'">
            · 其中异常 {{ batchResult.abnormalCount }} · 搁置 {{ batchResult.setAsideCount }} · 退回 {{ batchResult.returnedCount }} · 重复 {{ batchResult.duplicateCount }}
          </template>
          · 跳过 {{ batchResult.skippedCount }}
        </span>
        <button class="link" type="button" @click="batchResult = null">收起</button>
      </header>
      <ul class="result-list">
        <li v-for="item in batchResult.items" :key="`${item.rowId}-${item.kind}`" class="result-item">
          <span class="result-tag" :class="`tag-${item.kind}`">{{ kindLabel(item.kind) }}</span>
          <span class="result-code">{{ item.code || `记录#${item.rowId}` }}</span>
          <span class="result-msg">{{ item.message }}</span>
          <span v-if="item.conflict" class="conflict-flag">结论↔观察打架·结论优先</span>
          <button
            v-if="item.kind === 'setAside' || item.kind === 'returned'"
            class="link"
            type="button"
            @click="openEdit(item.rowId)"
          >
            {{ item.kind === 'returned' ? '核对重填' : '补齐补录' }}
          </button>
        </li>
      </ul>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">勾选</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>标记</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-flagged': rowReturnReason(row) }">
          <td class="col-check">
            <input type="checkbox" :value="Number(row.id)" v-model="selectedIds" />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '巡查人'">{{ displayInspector(row) || '—' }}</template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td><span class="status-pill" :class="`st-${String(row.status)}`">{{ row.status }}</span></td>
          <td class="flag-cell">
            <span v-if="row.abnormal" class="flag abnormal">结论异常</span>
            <span v-if="rowConflict(row)" class="flag conflict">打架·结论优先</span>
            <span v-if="rowReturnReason(row)" class="flag returned">已退回核对</span>
          </td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待巡查'"
              class="link"
              type="button"
              @click="openEdit(Number(row.id))"
            >
              补录/核对
            </button>
            <button
              v-if="String(row.status) === '已巡查' && row.abnormal"
              class="link"
              type="button"
              @click="quickGroup('report', [Number(row.id)])"
            >
              上报异常
            </button>
            <button
              v-if="String(row.status) === '发现异常'"
              class="link"
              type="button"
              @click="quickGroup('review', [Number(row.id)])"
            >
              确认复核
            </button>
            <span v-if="String(row.status) === '已复核'" class="muted-text">流程已办结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无群测群防巡查数据，可先登记巡查记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条群测群防巡查记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <form class="modal" @submit.prevent="saveDraft">
        <h3>{{ editing.id ? `补录/核对记录 #${editing.id}` : '登记巡查记录' }}</h3>
        <p class="modal-hint">只有「待巡查」记录能补录；一旦提交进入后续环节，不许回退改单。</p>
        <label v-for="field in editFields" :key="field" class="modal-field">
          <span>{{ field }}</span>
          <input
            v-model="editing.form[field]"
            :placeholder="field === '巡查人' ? '可填别名，保存时按名册归一' : `请填${field}`"
          />
        </label>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="editing = null">取消</button>
          <button class="btn primary" type="submit">保存到待巡查</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  createPatrolDraft,
  displayInspector,
  isCurrentMonth,
  listRows as listPatrolRows,
  pendingLedgerCount,
  reportAbnormalGroup,
  reviewAbnormalGroup,
  rowConflict,
  rowReturnReason,
  savePatrolDraft,
  submitPatrolBatch,
  type BatchSubmitResult,
  type GroupActionResult,
  type ItemOutcome,
  type ItemOutcomeKind,
} from '@/api/patrol-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡查编号', '所属隐患点', '巡查人', '巡查日期', '坡面情况', '排水情况', '巡查结论', '巡查状态']
const editFields = ['巡查编号', '所属隐患点', '巡查人', '巡查日期', '坡面情况', '排水情况', '巡查结论']
const statuses = ['待巡查', '已巡查', '发现异常', '已复核']

type BatchView =
  | ({ kind: 'submit' } & BatchSubmitResult)
  | ({ kind: 'group' } & GroupActionResult & { skippedCount: number; acceptedCount: number; abnormalCount: number; setAsideCount: number; returnedCount: number; duplicateCount: number })

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const batchResult = ref<BatchView | null>(null)
const ledgerPending = ref(0)
const editing = ref<{ id: number | null; form: Record<string, string> } | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const all = listPatrolRows(meta.key)
  const pending = all.filter((row) => String(row.status) === '待巡查').length
  const abnormal = all.filter((row) => row.abnormal).length
  const monthCount = all.filter((row) => {
    if (String(row.status) === '待巡查') {
      return false
    }
    const stamped = String(row._submittedAt ?? '')
    return stamped ? isCurrentMonth(stamped) : isCurrentMonth(row['巡查日期'])
  }).length
  return [
    { label: '待巡查任务', value: pending },
    { label: '发现异常次数', value: abnormal },
    { label: '本月巡查次数', value: monthCount },
  ]
})

const allVisibleSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)
const someVisibleSelected = computed(
  () => rows.value.some((row) => selectedIds.value.includes(Number(row.id))) && !allVisibleSelected.value,
)

const selectedAbnormalIds = computed(() =>
  selectedIds.value.filter((id) => {
    const row = rows.value.find((item) => Number(item.id) === id)
    return row && String(row.status) === '已巡查' && row.abnormal
  }),
)
const selectedReviewIds = computed(() =>
  selectedIds.value.filter((id) => {
    const row = rows.value.find((item) => Number(item.id) === id)
    return row && String(row.status) === '发现异常'
  }),
)

const KIND_LABELS: Record<ItemOutcomeKind, string> = {
  accepted: '已受理',
  abnormal: '异常受理',
  setAside: '已搁置',
  returned: '退回核对',
  duplicate: '重复忽略',
  skipped: '跳过',
  conflict: '打架',
}

function kindLabel(kind: ItemOutcomeKind): string {
  return KIND_LABELS[kind]
}

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const visibleIds = rows.value.map((row) => Number(row.id))
  if (checked) {
    selectedIds.value = Array.from(new Set([...selectedIds.value, ...visibleIds]))
  } else {
    selectedIds.value = selectedIds.value.filter((id) => !visibleIds.includes(id))
  }
}

function submitSelected() {
  errorMessage.value = ''
  try {
    const result = submitPatrolBatch([...selectedIds.value])
    batchResult.value = { kind: 'submit', ...result }
    selectedIds.value = []
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批量提交失败'
  }
}

function reportSelectedAbnormal() {
  errorMessage.value = ''
  try {
    const result = reportAbnormalGroup([...selectedIds.value])
    batchResult.value = toGroupView(result)
    selectedIds.value = []
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '整组上报失败'
  }
}

function reviewSelected() {
  errorMessage.value = ''
  try {
    const result = reviewAbnormalGroup([...selectedIds.value])
    batchResult.value = toGroupView(result)
    selectedIds.value = []
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批量复核失败'
  }
}

function quickGroup(step: 'report' | 'review', ids: number[]) {
  errorMessage.value = ''
  try {
    const result = step === 'report' ? reportAbnormalGroup(ids) : reviewAbnormalGroup(ids)
    batchResult.value = toGroupView(result)
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败'
  }
}

function toGroupView(result: GroupActionResult): BatchView {
  return {
    kind: 'group',
    ...result,
    skippedCount: result.items.filter((item: ItemOutcome) => item.kind === 'skipped').length,
    acceptedCount: result.items.filter((item: ItemOutcome) => item.kind === 'accepted').length,
    abnormalCount: 0,
    setAsideCount: 0,
    returnedCount: 0,
    duplicateCount: 0,
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function emptyForm(): Record<string, string> {
  return Object.fromEntries(editFields.map((field) => [field, '']))
}

function openCreate() {
  errorMessage.value = ''
  editing.value = { id: null, form: emptyForm() }
}

function openEdit(id: number) {
  errorMessage.value = ''
  try {
    const row = listPatrolRows(meta.key).find((item) => Number(item.id) === id)
    if (!row) {
      throw new Error('没有找到这条巡查记录')
    }
    const form: Record<string, string> = {}
    for (const field of editFields) {
      form[field] = String(row[field] ?? '')
    }
    editing.value = { id, form }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '打开补录失败'
  }
}

function saveDraft() {
  if (!editing.value) {
    return
  }
  errorMessage.value = ''
  try {
    const draft = createPatrolDraft(editing.value.form, editing.value.id ?? undefined)
    savePatrolDraft(draft)
    editing.value = null
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存失败'
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledgerPending.value = pendingLedgerCount()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '群测群防巡查列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.page-actions { display: flex; gap: 8px; align-items: center; }
.rules-card { background: #fff; border: 1px solid var(--border); border-left: 4px solid var(--brand); border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
.rules-card h3 { margin: 0 0 6px; font-size: 14px; }
.rules-card ol { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 12.5px; color: #334155; }
.rules-scale { margin: 8px 0 0; font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; }
.grade { background: #eef2f7; border-radius: 999px; padding: 2px 8px; }
.grade.extreme { background: #fee4e2; color: #b42318; }
.grade.abnormal { background: #fff4e0; color: #b54708; }
.batch-bar { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 4px; flex-wrap: wrap; }
.select-all { font-size: 13px; display: flex; gap: 6px; align-items: center; }
.batch-spacer { flex: 1; }
.btn.warn { background: #b54708; border-color: #b54708; color: #fff; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.batch-hint { margin: 0 0 10px; font-size: 12px; color: var(--muted); }
.col-check { width: 42px; text-align: center; }
.result-panel { border: 1px solid var(--border); border-radius: 8px; background: #fbfdff; margin-bottom: 10px; }
.result-head { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px dashed var(--border); font-size: 13px; }
.result-summary { color: var(--muted); font-size: 12px; flex: 1; }
.result-list { list-style: none; margin: 0; padding: 6px 12px; display: grid; gap: 4px; }
.result-item { display: flex; gap: 8px; align-items: center; font-size: 12.5px; flex-wrap: wrap; }
.result-code { font-weight: 600; min-width: 120px; }
.result-msg { color: #334155; flex: 1; }
.result-tag { border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.tag-accepted { background: #dcfae6; color: #067647; }
.tag-abnormal { background: #fff4e0; color: #b54708; }
.tag-setAside { background: #f2f4f7; color: #475467; }
.tag-returned { background: #fee4e2; color: #b42318; }
.tag-duplicate { background: #eef2f7; color: #475467; }
.tag-skipped { background: #f2f4f7; color: #667085; }
.conflict-flag { background: #fef3c7; color: #92400e; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.flag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; margin-right: 4px; }
.flag.abnormal { background: #fff4e0; color: #b54708; }
.flag.conflict { background: #fef3c7; color: #92400e; }
.flag.returned { background: #fee4e2; color: #b42318; }
.row-flagged { background: #fff8f7; }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; background: #eef2f7; }
.st-发现异常 { background: #fee4e2; color: #b42318; }
.st-已复核 { background: #dcfae6; color: #067647; }
.st-已巡查 { background: #e0efff; color: #175cd3; }
.muted-text { color: var(--muted); font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: 560px; max-width: 92vw; max-height: 88vh; overflow: auto; }
.modal h3 { margin: 0 0 4px; font-size: 15px; }
.modal-hint { margin: 0 0 10px; font-size: 12px; color: var(--muted); }
.modal-field { display: block; margin-bottom: 8px; }
.modal-field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.modal-field input { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
</style>
