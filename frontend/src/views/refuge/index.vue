<template>
  <section class="page" data-module="refuge">
    <header class="page-head">
      <div>
        <h2>避险场所管理</h2>
        <p class="page-desc">维护避险场所，围绕场所编号、场所名称、可容纳人数、开放条件做登记、筛选与状态流转。巡查批量提交收尾同步来的待核项在下方台账核办。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记避险场所</button>
        <button class="btn" type="button" @click="exportRows">导出避险场所清单</button>
        <RouterLink class="btn ghost" to="/patrol">返回群测群防巡查</RouterLink>
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

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <section class="ledger-card">
      <header class="ledger-head">
        <h3>巡查同步待核台账</h3>
        <span class="ledger-count">待核 {{ pendingCount }} 项 · 已核 {{ checkedCount }} 项</span>
        <label class="ledger-filter">
          <input type="checkbox" v-model="showAll" />
          显示已核项
        </label>
      </header>
      <table class="data-table ledger-table">
        <thead>
          <tr>
            <th>来源巡查编号</th>
            <th>待核场所/隐患点</th>
            <th>巡查人（名册归一）</th>
            <th>巡查结论</th>
            <th>同步时间</th>
            <th>待核说明</th>
            <th>核办状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in visibleLedger" :key="item.id" :class="{ 'ledger-abnormal': item.abnormal && !item.checked }">
            <td>{{ item.refCode }}</td>
            <td>{{ item.siteName }}</td>
            <td>{{ item.inspector }}</td>
            <td>
              <span :class="['conclusion-tag', item.abnormal ? 'is-abnormal' : '']">{{ item.conclusionLabel }}</span>
            </td>
            <td>{{ formatTime(item.submittedAt) }}</td>
            <td class="ledger-note">{{ item.note }}</td>
            <td>
              <template v-if="item.checked">
                <span class="done-text">已核办{{ item.checkedAt ? ` · ${formatTime(item.checkedAt)}` : '' }}</span>
              </template>
              <button v-else class="btn small" type="button" @click="openCheck(item.id)">登记核办</button>
            </td>
          </tr>
          <tr v-if="!visibleLedger.length">
            <td colspan="7" class="empty-state">暂无巡查同步的待核项；在群测群防巡查页面批量提交后，受理结果会自动同步到这里。</td>
          </tr>
        </tbody>
      </table>
    </section>

    <h3 class="section-title">避险场所档案</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无避险场所数据，可先登记避险场所</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险场所记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="checkingId" class="modal-mask" @click.self="checkingId = null">
      <form class="modal" @submit.prevent="confirmCheck">
        <h3>登记待核项核办结果</h3>
        <label class="modal-field">
          <span>核办说明（可选）</span>
          <input v-model="checkNote" placeholder="例如：场所容量可覆盖该隐患点转移人数，开放条件已确认" />
        </label>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="checkingId = null">取消</button>
          <button class="btn primary" type="submit">确认核办，从待核清单销项</button>
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
  runAction as applyAction,
} from '@/api/local-service'
import {
  checkLedgerItem,
  formatTime,
  listPatrolLedger,
} from '@/api/patrol-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('refuge')
const columns = ['场所编号', '场所名称', '可容纳人数', '开放条件', '场所负责人', '联系电话', '启用日期', '场所状态']
const actions = ['提交核验', '确认启用', '办理关闭']
const statuses = ['待核验', '可启用', '已启用', '已关闭']
const stats = [{ label: '可启用场所', value: 0 }, { label: '已启用场所', value: 0 }, { label: '可容纳人数合计', value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const ledger = ref(listPatrolLedger())
const showAll = ref(false)
const checkingId = ref<string | null>(null)
const checkNote = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const pendingCount = computed(() => ledger.value.filter((item) => !item.checked).length)
const checkedCount = computed(() => ledger.value.filter((item) => item.checked).length)
const visibleLedger = computed(() =>
  showAll.value ? ledger.value : ledger.value.filter((item) => !item.checked),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '避险场所登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openCheck(id: string) {
  checkingId.value = id
  checkNote.value = ''
}

function confirmCheck() {
  if (!checkingId.value) {
    return
  }
  errorMessage.value = ''
  const ok = checkLedgerItem(checkingId.value, checkNote.value)
  if (!ok) {
    errorMessage.value = '该待核项不存在或已被核办'
  }
  checkingId.value = null
  checkNote.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledger.value = listPatrolLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险场所列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.section-title { font-size: 14px; margin: 16px 0 8px; }
.ledger-card { background: #fff; border: 1px solid var(--border); border-left: 4px solid #b54708; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
.ledger-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.ledger-head h3 { margin: 0; font-size: 14px; }
.ledger-count { font-size: 12px; color: var(--muted); }
.ledger-filter { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; gap: 4px; align-items: center; }
.ledger-table { border-radius: 6px; }
.ledger-abnormal td { background: #fff8f0; }
.ledger-note { color: #475467; font-size: 12.5px; }
.conclusion-tag { border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #eef2f7; }
.conclusion-tag.is-abnormal { background: #fff4e0; color: #b54708; }
.done-text { color: #067647; font-size: 12.5px; }
.btn.small { padding: 3px 10px; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: 480px; max-width: 92vw; }
.modal h3 { margin: 0 0 10px; font-size: 15px; }
.modal-field { display: block; margin-bottom: 8px; }
.modal-field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.modal-field input { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
</style>
