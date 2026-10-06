<template>
  <section class="page" data-module="ventilation">
    <header class="page-head">
      <div>
        <h2>通风系统运维管理</h2>
        <p class="page-desc">环境监测判定超标后，按超标舱室自动排出待开机任务（同舱室只挂一条）；任务与监测页复核清单互链，结论一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出通风机组清单</button>
      </div>
    </header>

    <!-- 超标舱室待开机任务：来自环境监测超标联动，不是人工在这里上报一个数 -->
    <section class="panel">
      <h3>超标舱室 · 待开机任务（环境监测自动排出）</h3>
      <div class="stat-row">
        <article class="stat-card"><span class="stat-label">待开机</span><strong class="stat-value band-warn">{{ countTask('待开机') }}</strong></article>
        <article class="stat-card"><span class="stat-label">运行中</span><strong class="stat-value band-ok">{{ countTask('运行中') }}</strong></article>
        <article class="stat-card"><span class="stat-label">已解除</span><strong class="stat-value">{{ countTask('已解除') }}</strong></article>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>任务编号</th><th>超标舱室</th><th>触发记录</th><th>触发点位</th><th>超标指标</th>
            <th>下发时间</th><th>来源</th><th>任务状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td>{{ task.taskCode }}</td>
            <td><strong>{{ task.cabin }}</strong></td>
            <td>{{ task.triggerRecordCode }}</td>
            <td>{{ task.triggerPointName }}</td>
            <td>
              <span v-for="band of triggerLabels(task)" :key="band.key" class="flag" :class="band.band === '超标' ? 'flag-bad' : 'flag-warn'">
                {{ band.label }}·{{ band.band }}
              </span>
            </td>
            <td>{{ task.issuedAt }}</td>
            <td>{{ task.source }}</td>
            <td><span class="conclusion" :class="task.status === '待开机' ? 'band-warn' : task.status === '运行中' ? 'band-ok' : ''">{{ task.status }}</span></td>
            <td class="row-actions">
              <button v-if="task.status === '待开机'" class="link" type="button" @click="doStart(task.id)">确认开机</button>
              <button v-if="task.status === '运行中'" class="link" type="button" @click="doDismiss(task.id)">登记停机/解除</button>
              <button v-if="task.status === '待开机'" class="link danger" type="button" @click="doDismiss(task.id)">解除任务</button>
            </td>
          </tr>
          <tr v-if="!tasks.length">
            <td colspan="9" class="empty-state">暂无超标舱室，通风系统没有待开机任务</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">规则：仅「超标」档联动通风，「预警」只进复核清单；同一舱室存在待开机/运行中任务时不重复排出；最新监测不再超标时，待开机任务自动解除。</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h3 class="sub-title">通风机组台账</h3>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无通风机组数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条通风机组记录</span>
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
import { dismissTask, listVentilationTasks, startTask } from '@/api/env-service'
import { METRICS } from '@/data/env-rules'
import type { EntryRow } from '@/data/types'
import type { EnvBand, EnvMetricKey, VentilationTask } from '@/data/types'

const meta = moduleMeta('ventilation')
const columns = ['机组编号', '所属舱室', '风机型号', '运行模式', '送风风速', '启停时间', '操作人员', '风机状态']
const actions = ['提交开机', '登记停机', '上报故障']
const statuses = ['待开机', '运行中', '已停机', '故障停机']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const tasks = ref<VentilationTask[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function triggerLabels(task: VentilationTask): { key: EnvMetricKey; label: string; band: EnvBand }[] {
  return METRICS.filter((m) => task.triggerBands[m.key] === '超标' || task.triggerBands[m.key] === '预警').map((m) => ({
    key: m.key,
    label: m.label,
    band: task.triggerBands[m.key] as EnvBand,
  }))
}

function countTask(status: VentilationTask['status']): number {
  return tasks.value.filter((t) => t.status === status).length
}

function doStart(id: number) {
  const result = startTask(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function doDismiss(id: number) {
  const result = dismissTask(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
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
  tasks.value = listVentilationTasks()
  const payload = listEntries(meta.key)
  rows.value = payload.items
  total.value = payload.total
}

onMounted(reload)
</script>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.panel h3 { margin: 0 0 8px; font-size: 15px; }
.sub-title { font-size: 14px; margin: 14px 0 8px; }
.hint { color: var(--muted); font-size: 12px; }
.flag { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 12px; margin-right: 4px; }
.flag-bad { background: #fee4e2; color: #b42318; }
.flag-warn { background: #fef3c7; color: #92400e; }
.conclusion { font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #f2f4f7; }
.band-bad { color: #b42318; }
.band-warn { color: #b54708; }
.band-ok { color: #067647; }
.link.danger { color: #b42318; }
</style>
