<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>群测群防巡查管理</h2>
        <p class="page-desc">一次巡线攒下的记录可勾选多条一次上交，逐条给出结果；环节按 待巡查 → 已巡查 → 发现异常 → 已复核 顺序流转，不许回退、不许跳级。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出群测群防巡查清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="rule-box">
      <p class="rule-title">上交规则（勾选后按环节批量处理）</p>
      <ol class="rule-list">
        <li>巡查人没填或巡查结论空着的记录先<b>暂缓一旁</b>，不挡住同批其他记录。</li>
        <li>巡查结论取到极值（极差 / 极度危险 / 极不稳定）的记录一律<b>退回核对</b>，不流转。</li>
        <li>结论极值与巡查人缺失同时命中时，<b>极值退回优先于暂缓</b>（硬性退回 &gt; 缺项暂缓）。</li>
        <li>同一巡查编号重复提交，<b>只认第一次</b>的结果，后交的判为重复、不覆盖。</li>
        <li>提交成功的巡查结果同步到避险场所台账，台账添一条<b>待核项</b>；巡查人统一读取花名册。</li>
      </ol>
    </div>

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
        <input type="checkbox" :checked="allVisibleSelected" :disabled="!rows.length" @change="toggleAll" />
        全选当前结果（已选 {{ selectedIds.length }} 条）
      </label>
      <div class="batch-actions">
        <button
          v-for="action in actions"
          :key="action"
          class="btn primary"
          type="button"
          :disabled="selectedIds.length === 0 || !canRun(action)"
          @click="runBatch(action)"
        >
          {{ action }}（{{ selectedIds.length }}）
        </button>
        <button class="btn ghost" type="button" :disabled="!selectedIds.length" @click="clearSelection">
          清空勾选
        </button>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">勾选</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-returned': isReturned(row) }">
          <td class="col-check">
            <input type="checkbox" :value="Number(row.id)" v-model="selectedIds" />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '巡查人'">{{ displayInspector(row) || '—' }}</template>
            <template v-else-if="column === '巡查结论'">
              {{ row[column] || '—' }}
              <span v-if="isReturned(row)" class="tag tag-returned">已退回</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span class="status-tag" :class="statusClass(row.status)">{{ row.status }}</span>
            <span v-if="isReturned(row)" class="return-reason">{{ row.退回原因 }}</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无群测群防巡查数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="batchResult" class="result-panel">
      <p class="result-title">
        本次「{{ batchResult.action }}」逐条结果：
        成功 {{ batchResult.success }} 条 ·
        暂缓 {{ batchResult.skipped }} 条 ·
        退回 {{ batchResult.returned }} 条 ·
        重复 {{ batchResult.duplicate }} 条 ·
        拦下 {{ batchResult.rejected }} 条
        （共 {{ batchResult.total }} 条）
      </p>
      <ul class="result-list">
        <li v-for="item in batchResult.items" :key="item.id" :class="`is-${item.state}`">
          <span class="result-state">{{ stateLabel[item.state] }}</span>
          <span class="result-code">{{ item.code }}（记录 {{ item.id }}）</span>
          <span class="result-msg">{{ item.message }}</span>
        </li>
      </ul>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条群测群防巡查记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { batchPatrolAction } from '@/api/patrol-batch'
import { resolveInspector } from '@/data/inspectors'
import type { BatchActionResult, BatchItemState, EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡查编号', '所属隐患点', '巡查人', '巡查日期', '坡面情况', '排水情况', '巡查结论', '巡查状态']
const actions = ['提交巡查', '上报异常', '确认复核']
const statuses = ['待巡查', '已巡查', '发现异常', '已复核']

// 各批量动作只接收对应环节的记录；环节不匹配的交由服务逐条拦下，保证顺序流转。
const ACTION_FROM: Record<string, string> = {
  提交巡查: '待巡查',
  上报异常: '已巡查',
  确认复核: '发现异常',
}

const stateLabel: Record<BatchItemState, string> = {
  success: '成功',
  skipped: '暂缓',
  returned: '退回',
  duplicate: '重复',
  rejected: '拦下',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const batchResult = ref<BatchActionResult | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const monthly = rows.value.filter((row) =>
    String(row['巡查日期'] ?? '').startsWith(currentMonth),
  ).length
  return [
    { label: '待巡查任务', value: rows.value.filter((row) => String(row.status) === '待巡查').length },
    { label: '发现异常次数', value: rows.value.filter((row) => String(row.status) === '发现异常').length },
    { label: '本月巡查次数', value: monthly },
  ]
})

const allVisibleSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)

function isReturned(row: EntryRow): boolean {
  return Boolean(row.退回原因)
}

function displayInspector(row: EntryRow): string {
  // 列表、结果、台账多处读取巡查人，统一走花名册，保证同一份。
  return resolveInspector(row['巡查人'])
}

function statusClass(status: string): string {
  if (status === '发现异常') return 'is-abnormal'
  if (status === '已复核') return 'is-done'
  if (status === '已巡查') return 'is-ok'
  return ''
}

function canRun(action: string): boolean {
  const from = ACTION_FROM[action]
  return rows.value.some(
    (row) => selectedIds.value.includes(Number(row.id)) && String(row.status) === from,
  )
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? rows.value.map((row) => Number(row.id)) : []
}

function clearSelection() {
  selectedIds.value = []
}

function runBatch(action: string) {
  errorMessage.value = ''
  if (selectedIds.value.length === 0) {
    errorMessage.value = '请先勾选要上交的巡查记录'
    return
  }
  try {
    batchResult.value = batchPatrolAction(action, [...selectedIds.value])
    selectedIds.value = []
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批量上交失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 过滤/刷新后，只保留仍在结果集里的勾选。
    const visibleIds = new Set(rows.value.map((row) => Number(row.id)))
    selectedIds.value = selectedIds.value.filter((id) => visibleIds.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '群测群防巡查列表读取失败'
  }
}

onMounted(reload)
</script>
