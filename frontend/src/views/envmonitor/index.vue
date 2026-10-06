<template>
  <section class="page" data-module="envmonitor">
    <header class="page-head">
      <div>
        <h2>廊内环境监测管理</h2>
        <p class="page-desc">
          四项指标一套口径：点位登记标准闭区间，越界统一分「一级预警 / 二级超标」；
          二级超标按舱室联动通风待开机任务，结论同步复核清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="runBackfill">按下发日期回填存量</button>
        <button class="btn primary" type="button" @click="scrollToSubmit">报送采集值</button>
      </div>
    </header>

    <p class="rule-banner">
      口径版本 <code>{{ RULE_VERSION }}</code> ｜ 冲突兜底：现场实测 &gt; 复核补录 &gt; 历史回填
      ｜ 同点位同采集时间重复报送只认最后一版 ｜ 二级超标才排通风待开机任务（每舱至多一条）
    </p>

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

    <!-- 一、点位标准范围登记（阈值唯一真源） -->
    <section class="panel">
      <h3 class="panel-title">一、监测点位标准范围登记（判定条件与上限只此一份）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>监测点位</th>
            <th>所属舱室</th>
            <th>生效日</th>
            <th v-for="metric in ENV_METRICS" :key="metric">
              {{ metric }}标准范围
              <small class="unit-hint">
                量程 {{ specOf(metric).physicalMin }}~{{ specOf(metric).physicalMax }}{{ specOf(metric).unit }}
                ｜预警带宽 {{ specOf(metric).warnBand }}{{ specOf(metric).unit }}
              </small>
            </th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="draft in standardDrafts" :key="draft.监测点位 + draft._key">
            <td><input v-model="draft.监测点位" :readonly="draft._saved" class="cell-input" /></td>
            <td><input v-model="draft.所属舱室" class="cell-input" /></td>
            <td><input v-model="draft.effectiveDate" type="date" class="cell-input" /></td>
            <td v-for="metric in ENV_METRICS" :key="metric" class="range-cell">
              <input v-model.number="draft.ranges[metric].min" type="number" class="cell-input narrow" />
              <span>~</span>
              <input v-model.number="draft.ranges[metric].max" type="number" class="cell-input narrow" />
              <small>{{ specOf(metric).unit }}</small>
            </td>
            <td>
              <button class="link" type="button" @click="persistStandard(draft)">
                {{ draft._saved ? '保存修改' : '登记生效' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="panel-actions">
        <button class="btn" type="button" @click="addStandardDraft">新增点位标准</button>
      </div>
    </section>

    <!-- 二、采集值报送（两条路径同一管道） -->
    <section ref="submitAnchor" class="panel">
      <h3 class="panel-title">二、采集值报送（现场实测 / 复核补录，同一整笔事务）</h3>
      <form class="submit-grid" @submit.prevent="submitReading">
        <label class="filter-item">
          <span>监测点位</span>
          <select v-model="submitForm.监测点位" required>
            <option value="" disabled>选择已登记点位</option>
            <option v-for="std in standards" :key="std.监测点位" :value="std.监测点位">
              {{ std.监测点位 }}（{{ std.所属舱室 }}）
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>数据来源（取值打架时现场实测为准）</span>
          <select v-model="submitForm.source">
            <option value="现场实测">现场实测</option>
            <option value="复核补录">复核补录</option>
          </select>
        </label>
        <label class="filter-item">
          <span>采集时间（重复报送按它去重）</span>
          <input v-model="submitForm.采集时间" type="datetime-local" required />
        </label>
        <label v-for="metric in ENV_METRICS" :key="metric" class="filter-item">
          <span>{{ metric }}（{{ specOf(metric).unit }}，留空=未采集）</span>
          <input v-model="submitForm.values[metric]" type="number" :step="specOf(metric).precision" />
        </label>
        <div class="panel-actions full-row">
          <button class="btn primary" type="submit">整笔提交并判定</button>
        </div>
      </form>
      <ul class="reject-list">
        <li>不允许保存：空值文本（“正常/--”等）、非数值、越过仪表量程的值——命中即整笔拒收。</li>
        <li>同点位同采集时间重复报送：同来源只认最后一版；低优先级来源不得覆盖现场实测版。</li>
      </ul>
    </section>

    <!-- 三、监测记录列表（结论实时推导，不存档位） -->
    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>按点位 / 舱室检索</span>
        <input v-model="keyword" placeholder="监测点位或所属舱室" />
      </label>
      <label class="filter-item">
        <span>结论筛选</span>
        <select v-model="verdictFilter">
          <option value="">全部</option>
          <option v-for="v in verdictOptions" :key="v" :value="v">{{ v }}</option>
        </select>
      </label>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>监测编号</th>
          <th>监测点位 / 舱室</th>
          <th v-for="metric in ENV_METRICS" :key="metric">{{ metric }}</th>
          <th>采集时间</th>
          <th>来源</th>
          <th>判定结论（统一口径推导）</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in evaluatedRows" :key="String(item.row.id)">
          <td>{{ item.row.监测编号 }}</td>
          <td>{{ item.row.监测点位 }}<br /><small>{{ item.row.所属舱室 }}</small></td>
          <td v-for="metric in ENV_METRICS" :key="metric">
            <span :class="['grade-badge', gradeClass(resultOf(item, metric).grade)]">
              <template v-if="resultOf(item, metric).value !== null">{{ resultOf(item, metric).value }}</template>
              <template v-else>— 缺失</template>
            </span>
          </td>
          <td>{{ item.row.采集时间 }}</td>
          <td>{{ item.row.数据来源 }}<br /><small v-if="item.row.回填批次" class="muted">{{ item.row.回填批次 }}</small></td>
          <td>
            <span :class="['grade-badge', verdictClass(item.evaluation.verdict)]">{{ item.evaluation.verdict }}</span>
            <br /><small class="muted">{{ item.evaluation.summary }}</small>
          </td>
          <td><button class="link" type="button" @click="openDetail(item.row)">查看</button></td>
        </tr>
        <tr v-if="!evaluatedRows.length">
          <td :colspan="11" class="empty-state">暂无符合条件的环境监测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ evaluatedRows.length }} 条；列表与详情面板取同一份数据、同一函数推导</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 四、通风联动待开机任务（按超标舱室，每舱至多一条） -->
    <section class="panel">
      <h3 class="panel-title">三、通风联动待开机任务（判定二级超标后自动排出，不只是报一个数）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>任务编号</th><th>超标舱室</th><th>触发指标</th><th>关联记录数</th><th>最近采集时间</th><th>状态</th><th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in ventTasks" :key="String(task.id)">
            <td>{{ task.机组编号 }}</td>
            <td>{{ task.所属舱室 }}</td>
            <td>{{ task.触发指标 }}</td>
            <td>{{ linkedCount(task) }}</td>
            <td>{{ task.启停时间 }}</td>
            <td><span :class="['grade-badge', task.status === '待开机' ? 'verdict二级超标' : 'grade正常']">{{ task.status }}</span></td>
            <td>{{ task.任务说明 }}</td>
          </tr>
          <tr v-if="!ventTasks.length">
            <td colspan="7" class="empty-state">暂无环境监测联动的通风任务</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 五、复核清单：结论回写，展示时按现值重算并核对 -->
    <section class="panel">
      <h3 class="panel-title">四、其它入口复核清单（结论写回，两处不一致按现值重算）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>复核编号</th><th>点位</th><th>舱室</th><th>采集时间</th><th>来源</th><th>回写结论</th><th>现值重算</th><th>一致性</th><th>残缺字段</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="review in reviewItems" :key="String(review.id)">
            <td>{{ review.复核编号 }}</td>
            <td>{{ review.监测点位 }}</td>
            <td>{{ review.所属舱室 }}</td>
            <td>{{ review.采集时间 }}</td>
            <td>{{ review.数据来源 }}</td>
            <td>{{ review.复核结论 }}</td>
            <td><span class="muted">{{ review.结论摘要 }}</span></td>
            <td>
              <span :class="['grade-badge', review.结论一致 === '是' ? 'grade正常' : 'verdict指标缺失']">
                {{ review.结论一致 }}
              </span>
            </td>
            <td>{{ review.残缺字段 || '—' }}</td>
          </tr>
          <tr v-if="!reviewItems.length">
            <td colspan="9" class="empty-state">复核清单为空，提交采集或回填后自动回写</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 详情面板：与列表行用同一个 evaluateRow 结果结构 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>监测记录详情 · {{ detail.row.监测编号 }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <p class="rule-banner">
          口径版本 {{ detail.row.口径版本 }} ｜ 数据来源 {{ detail.row.数据来源 }}
          ｜ 采集 {{ detail.row.采集时间 }} 报送 {{ detail.row.报送时间 }}
          <template v-if="detail.row.回填批次">｜ {{ detail.row.回填批次 }}</template>
        </p>
        <table class="data-table">
          <thead>
            <tr><th>指标</th><th>实测值</th><th>标准闭区间</th><th>超出量</th><th>分档</th><th>判定依据</th></tr>
          </thead>
          <tbody>
            <tr v-for="result in detail.evaluation.results" :key="result.metric">
              <td>{{ result.metric }}</td>
              <td>
                <span :class="['grade-badge', gradeClass(result.grade)]">
                  {{ result.value === null ? '—（留空）' : result.value + specOf(result.metric).unit }}
                </span>
              </td>
              <td>[{{ result.min }}, {{ result.max }}]</td>
              <td>{{ result.excess }}</td>
              <td><span :class="['grade-badge', gradeClass(result.grade)]">{{ result.grade }}</span></td>
              <td>{{ result.reason }}</td>
            </tr>
          </tbody>
        </table>
        <p class="detail-summary">
          整体结论：<span :class="['grade-badge', verdictClass(detail.evaluation.verdict)]">{{ detail.evaluation.verdict }}</span>
          ｜ {{ detail.evaluation.summary }}
        </p>
        <p v-if="detail.evaluation.missing.length" class="error-text">
          残缺字段已标出并留空：{{ detail.evaluation.missing.join('、') }}（不得判正常）
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import type { EntryRow } from '@/data/types'
import {
  ENV_METRICS,
  METRIC_SPECS,
  RULE_VERSION,
  type EnvMetric,
  type EnvDataSource,
  type PointStandard,
  type RecordEvaluation,
} from '@/domain/env-rules'
import {
  ENV_KEY,
  backfillHistory,
  evaluateRow,
  ingestReadings,
  linkedVentTasks,
  listReviewItems,
  listStandards,
  saveStandard,
} from '@/domain/env-service'
import { listRows } from '@/data/local-store'

const verdictOptions = ['待采集', '指标缺失', '指标正常', '一级预警', '二级超标'] as const

type StandardDraft = PointStandard & { _key: number; _saved: boolean }
type EvaluatedRow = { row: EntryRow; evaluation: RecordEvaluation }

const standards = ref<PointStandard[]>([])
const rows = ref<EntryRow[]>([])
const ventTasks = ref<EntryRow[]>([])
const reviewItems = ref<EntryRow[]>([])
const standardDrafts = ref<StandardDraft[]>([])

const keyword = ref('')
const verdictFilter = ref('')
const message = ref('')
const messageOk = ref(true)
const submitAnchor = ref<HTMLElement | null>(null)
const detail = ref<EvaluatedRow | null>(null)

const submitForm = reactive({
  监测点位: '',
  source: '现场实测' as EnvDataSource,
  采集时间: '',
  values: Object.fromEntries(ENV_METRICS.map((metric) => [metric, ''])) as Record<EnvMetric, string>,
})

function specOf(metric: EnvMetric) {
  return METRIC_SPECS[metric]
}

function resultOf(item: EvaluatedRow, metric: EnvMetric) {
  return item.evaluation.results.find((result) => result.metric === metric)!
}

function gradeClass(grade: string): string {
  if (grade === '正常') return 'grade正常'
  if (grade === '一级预警') return 'grade一级预警'
  if (grade === '二级超标') return 'grade二级超标'
  return 'verdict指标缺失'
}

function verdictClass(verdict: string): string {
  if (verdict === '指标正常') return 'grade正常'
  if (verdict === '一级预警') return 'grade一级预警'
  if (verdict === '二级超标') return 'grade二级超标'
  return 'verdict指标缺失'
}

function linkedCount(task: EntryRow): number {
  try {
    return (JSON.parse(String(task.关联记录 ?? '[]')) as unknown[]).length
  } catch {
    return 0
  }
}

const evaluatedRows = computed<EvaluatedRow[]>(() => {
  const kw = keyword.value.trim()
  return rows.value
    .map((row) => ({
      row,
      evaluation: evaluateRow(row, standards.value.find((std) => std.监测点位 === row.监测点位) ?? null),
    }))
    .filter((item) => {
      if (kw && !`${item.row.监测点位}${item.row.所属舱室}`.includes(kw)) return false
      if (verdictFilter.value && item.evaluation.verdict !== verdictFilter.value) return false
      return true
    })
})

const stats = computed(() => {
  const all = rows.value.map((row) =>
    evaluateRow(row, standards.value.find((std) => std.监测点位 === row.监测点位) ?? null),
  )
  const count = (verdict: string) => all.filter((item) => item.verdict === verdict).length
  return [
    { label: '待采集点位', value: count('待采集') },
    { label: '指标缺失点位', value: count('指标缺失') },
    { label: '指标正常点位', value: count('指标正常') },
    { label: '一级预警点位', value: count('一级预警') },
    { label: '二级超标点位', value: count('二级超标') },
  ]
})

const statusSummary = computed(() =>
  (['待采集', '已采集', '指标正常', '指标超标'] as const).map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function defaultDraft(saved: PointStandard | null, key: number): StandardDraft {
  const base: PointStandard = saved ?? {
    监测点位: '',
    所属舱室: '',
    effectiveDate: '2026-10-06',
    ranges: Object.fromEntries(
      ENV_METRICS.map((metric) => [metric, { min: METRIC_SPECS[metric].defaultMin, max: METRIC_SPECS[metric].defaultMax }]),
    ) as PointStandard['ranges'],
  }
  return {
    ...JSON.parse(JSON.stringify(base)),
    ranges: JSON.parse(JSON.stringify(base.ranges)),
    _key: key,
    _saved: saved !== null,
  }
}

let draftSeq = 0
function syncDrafts() {
  standardDrafts.value = standards.value.map((std) => defaultDraft(std, draftSeq++))
}

function addStandardDraft() {
  standardDrafts.value.push(defaultDraft(null, draftSeq++))
}

function persistStandard(draft: StandardDraft) {
  const { _key, _saved, ...std } = draft
  const result = saveStandard(std)
  flash(result.message, result.ok)
  if (result.ok) reload()
}

function submitReading() {
  const values = {} as Record<EnvMetric, unknown>
  for (const metric of ENV_METRICS) {
    const raw = submitForm.values[metric].trim()
    if (raw !== '') values[metric] = Number(raw)
  }
  const result = ingestReadings([
    {
      监测点位: submitForm.监测点位,
      采集时间: submitForm.采集时间,
      source: submitForm.source,
      values,
    },
  ])
  flash(result.message, result.ok)
  if (result.ok) {
    submitForm.采集时间 = ''
    for (const metric of ENV_METRICS) submitForm.values[metric] = ''
    reload()
  }
}

function runBackfill() {
  const result = backfillHistory()
  flash(result.message, result.ok)
  reload()
}

function openDetail(row: EntryRow) {
  const standard = standards.value.find((std) => std.监测点位 === row.监测点位) ?? null
  // 详情面板与列表使用同一行数据、同一判定函数，取值必然一致。
  detail.value = { row, evaluation: evaluateRow(row, standard) }
}

function closeDetail() {
  detail.value = null
}

function scrollToSubmit() {
  submitAnchor.value?.scrollIntoView({ behavior: 'smooth' })
}

function flash(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

function reload() {
  standards.value = listStandards()
  rows.value = [...listRows(ENV_KEY)]
  ventTasks.value = linkedVentTasks()
  reviewItems.value = listReviewItems()
  syncDrafts()
  // 详情面板若打开，随同一份新数据重算，避免停留在旧版本。
  if (detail.value) {
    const fresh = rows.value.find((row) => Number(row.id) === Number(detail.value!.row.id))
    detail.value = fresh
      ? { row: fresh, evaluation: evaluateRow(fresh, standards.value.find((std) => std.监测点位 === fresh.监测点位) ?? null) }
      : null
  }
}

onMounted(reload)
</script>
