<template>
  <section class="page" data-module="ventilation">
    <header class="page-head">
      <div>
        <h2>通风系统运维管理</h2>
        <p class="page-desc">维护通风机组，围绕机组编号、所属舱室、风机型号、运行模式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记通风机组</button>
        <button class="btn" type="button" @click="exportRows">导出通风系统运维清单</button>
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

    <!-- 环境监测超标联动：按超标舱室排出的待开机任务，一舱一条 -->
    <section class="panel">
      <h3 class="panel-title">环境监测联动待开机任务（二级超标舱室自动排出，不只是监测页报一个数）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>任务编号</th><th>超标舱室</th><th>触发指标</th><th>关联记录数</th><th>最近采集时间</th><th>任务状态</th><th>说明</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in linkedTasks" :key="String(task.id)">
            <td>{{ task.机组编号 }}</td>
            <td>{{ task.所属舱室 }}</td>
            <td><span class="grade-badge grade二级超标">{{ task.触发指标 }}</span></td>
            <td>{{ linkedCount(task) }}</td>
            <td>{{ task.启停时间 }}</td>
            <td>{{ task.status }}</td>
            <td>{{ task.任务说明 }}</td>
            <td class="row-actions">
              <button v-if="task.status === '待开机'" class="link" type="button" @click="startLinked(task)">提交开机</button>
              <span v-else class="muted">已处置</span>
            </td>
          </tr>
          <tr v-if="!linkedTasks.length">
            <td colspan="8" class="empty-state">当前没有环境监测联动的通风任务</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无通风系统运维数据，可先登记通风机组</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条通风系统运维记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
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
import { linkedVentTasks, VENT_KEY } from '@/domain/env-service'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ventilation')
const columns = ["机组编号", "所属舱室", "风机型号", "运行模式", "送风风速", "启停时间", "操作人员", "风机状态"]
const actions = ["提交开机", "登记停机", "上报故障"]
const statuses = ["待开机", "运行中", "已停机", "故障停机"]
const stats = [{"label": "运行中风机", "value": 0}, {"label": "已停机风机", "value": 0}, {"label": "故障停机风机", "value": 0}]

const rows = ref<EntryRow[]>([])
const linkedTasks = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

function linkedCount(task: EntryRow): number {
  try {
    return (JSON.parse(String(task.关联记录 ?? '[]')) as unknown[]).length
  } catch {
    return 0
  }
}

/** 联动任务执行开机：直接把该机组流转为运行中（联动任务沿用模块状态机）。 */
function startLinked(task: EntryRow) {
  const all = listRows(VENT_KEY).map((row) =>
    Number(row.id) === Number(task.id)
      ? { ...row, status: '运行中', pending: false, abnormal: false, 风机状态: '运行中' }
      : row,
  )
  saveRows(VENT_KEY, all)
  errorMessage.value = ''
  reload()
}
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '通风机组登记入口尚未接入审批流'
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    linkedTasks.value = linkedVentTasks()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通风系统运维列表读取失败'
  }
}

onMounted(reload)
</script>
