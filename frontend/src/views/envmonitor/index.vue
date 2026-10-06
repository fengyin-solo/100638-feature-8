<template>
  <section class="page" data-module="envmonitor">
    <header class="page-head">
      <div>
        <h2>廊内环境监测管理</h2>
        <p class="page-desc">温度、湿度、氧气、有害气体四项指标按同一套口径自动分档；超标自动按舱室排通风待开机任务。判定条件与阈值全局只有一份。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openLive">现场报送</button>
        <button class="btn" type="button" @click="openPoint">登记点位标准</button>
        <button class="btn" type="button" @click="openBackfill">历史记录回填</button>
        <button class="btn ghost" type="button" @click="resetAll">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">有效记录</span>
        <strong class="stat-value">{{ records.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超标（已联动通风）</span>
        <strong class="stat-value band-bad">{{ countOf('超标') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">预警</span>
        <strong class="stat-value band-warn">{{ countOf('预警') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待复核（含残缺/伪正常）</span>
        <strong class="stat-value">{{ reviews.filter((r) => !r.handled).length }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">统一规则：{{ ruleText }}</span>
    </p>

    <!-- 点位标准与阈值口径（唯一一份） -->
    <section class="panel">
      <h3>点位标准范围与分档阈值</h3>
      <p class="hint">标准范围按点位登记；预警带/超标的判定条件全平台共用，页面、详情、复核、通风联动读的都是这同一份。</p>
      <div v-for="point in points" :key="point.id" class="point-block">
        <div class="point-head">
          <strong>{{ point.code }} · {{ point.name }}</strong>
          <span class="tag">所属舱室：{{ point.cabin }}</span>
        </div>
        <table class="data-table inner">
          <thead>
            <tr>
              <th>指标</th>
              <th>单位</th>
              <th>标准范围（闭区间）</th>
              <th>预警带（标准两侧外扩）</th>
              <th>超标线</th>
              <th>量程/登记允许区间（越界不允许保存）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in summaryOf(point)" :key="row.key">
              <td>{{ row.label }}</td>
              <td>{{ row.unit }}</td>
              <td>{{ row.range.standardMin }} ~ {{ row.range.standardMax }}</td>
              <td>{{ row.boundary.warnLow }} ~ {{ row.boundary.warnHigh }}（±{{ row.boundary.margin }}）</td>
              <td>&lt; {{ row.boundary.warnLow }} 或 &gt; {{ row.boundary.warnHigh }}</td>
              <td>量程 {{ row.physicalMin }}~{{ row.physicalMax }}；标准可登记 {{ row.registerMin }}~{{ row.registerMax }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 监测记录列表：取值来自 getRecordView/listRecords，详情面板调同一个函数 -->
    <section class="panel">
      <h3>监测记录（同点同刻只认最后一版）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>监测编号</th>
            <th>监测点位 / 舱室</th>
            <th>环境温度℃</th>
            <th>空气湿度%RH</th>
            <th>氧气浓度%VOL</th>
            <th>有害气体%LEL</th>
            <th>采集时间</th>
            <th>来源</th>
            <th>自动判定结论</th>
            <th>标记</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in records" :key="row.id">
            <td>{{ row.code }}</td>
            <td>{{ row.pointName }}<br /><span class="hint">{{ row.cabin }}</span></td>
            <td :class="bandClass(row.bands.temperature)">{{ cell(row, 'temperature') }}</td>
            <td :class="bandClass(row.bands.humidity)">{{ cell(row, 'humidity') }}</td>
            <td :class="bandClass(row.bands.oxygen)">{{ cell(row, 'oxygen') }}</td>
            <td :class="bandClass(row.bands.gas)">{{ cell(row, 'gas') }}</td>
            <td>{{ row.collectedAt }}</td>
            <td>{{ row.source }}</td>
            <td><span class="conclusion" :class="conclusionClass(row.evaluated)">{{ row.evaluated }}</span></td>
            <td>
              <span v-if="row.suspectFalseNormal" class="flag flag-bad">伪正常</span>
              <span v-if="row.missing.length" class="flag flag-miss">残缺{{ row.missing.length }}</span>
            </td>
            <td><button class="link" type="button" @click="openDetail(row.id)">详情/复核</button></td>
          </tr>
          <tr v-if="!records.length">
            <td colspan="11" class="empty-state">暂无有效监测记录</td>
          </tr>
        </tbody>
      </table>
      <div v-if="supersededRecords.length" class="superseded">
        <details>
          <summary>被最后一版替代的历史报送（{{ supersededRecords.length }} 条，只留痕、不参与判定）</summary>
          <ul>
            <li v-for="row in supersededRecords" :key="row.id">
              {{ row.code }} · {{ row.pointName }} · 采集 {{ row.collectedAt }} · 收到 {{ row.receivedAt }} — {{ row.note }}
            </li>
          </ul>
        </details>
      </div>
    </section>

    <!-- 复核清单：评估结论写回这里，通风页看到的是同一批 -->
    <section class="panel">
      <h3>复核清单（与通风系统运维页共用同一份结论）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th><th>点位/舱室</th><th>采集时间</th><th>结论</th><th>判定依据</th><th>通风任务</th><th>来源</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviews" :key="item.id">
            <td>{{ item.recordCode }}</td>
            <td>{{ item.pointName }}<br /><span class="hint">{{ item.cabin }}</span></td>
            <td>{{ item.collectedAt }}</td>
            <td><span class="conclusion" :class="conclusionClass(item.conclusion)">{{ item.conclusion }}</span></td>
            <td>{{ item.reason }}</td>
            <td>
              <span v-if="item.ventilationTaskId" class="flag flag-bad">已排待开机 #{{ item.ventilationTaskId }}</span>
              <span v-else class="hint">—</span>
            </td>
            <td>{{ item.source }}</td>
            <td>{{ item.handled ? '已复核' : '待复核' }}</td>
            <td>
              <button v-if="!item.handled" class="link" type="button" @click="doResolve(item.id)">确认复核</button>
              <span v-else class="hint">已处理</span>
            </td>
          </tr>
          <tr v-if="!reviews.length">
            <td colspan="9" class="empty-state">暂无待复核项</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 现场报送弹层 -->
    <div v-if="liveOpen" class="modal-mask" @click.self="liveOpen = false">
      <div class="modal">
        <h3>现场实测报送</h3>
        <p class="hint">现场路径四项指标必填，任一不合法整笔退回；同一点位同一采集时间重复报送，只认最后一版（实测覆盖回填）。</p>
        <label class="form-row"><span>监测点位</span>
          <select v-model="liveForm.pointId">
            <option v-for="p in points" :key="p.id" :value="p.id">{{ p.code }} · {{ p.name }}</option>
          </select>
        </label>
        <label class="form-row"><span>采集时间</span><input v-model="liveForm.collectedAt" placeholder="如 2026-10-06 08:00" /></label>
        <label v-for="m in metricDefs" :key="m.key" class="form-row">
          <span>{{ m.label }}（{{ m.unit }}）</span>
          <input v-model="liveForm.values[m.key]" :placeholder="`量程 ${m.physicalMin}~${m.physicalMax}，必填`" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="liveOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitLive">提交报送</button>
        </div>
      </div>
    </div>

    <!-- 点位标准登记弹层 -->
    <div v-if="pointOpen" class="modal-mask" @click.self="pointOpen = false">
      <div class="modal wide">
        <h3>登记监测点位标准范围</h3>
        <p class="hint">每个点位登记四项指标的标准闭区间；区间倒挂或超出可登记范围一律拒绝。分档阈值不由点位决定，全平台共用。</p>
        <label class="form-row"><span>点位编号</span><input v-model="pointForm.code" placeholder="POINT-004" /></label>
        <label class="form-row"><span>点位名称</span><input v-model="pointForm.name" placeholder="如 4号水信舱·D段监测点" /></label>
        <label class="form-row"><span>所属舱室</span><input v-model="pointForm.cabin" placeholder="如 4号水信舱D段" /></label>
        <table class="data-table inner">
          <thead><tr><th>指标</th><th>标准下限</th><th>标准上限</th><th>允许区间</th></tr></thead>
          <tbody>
            <tr v-for="m in metricDefs" :key="m.key">
              <td>{{ m.label }}</td>
              <td><input v-model="pointForm.ranges[m.key].min" class="cell-input" /></td>
              <td><input v-model="pointForm.ranges[m.key].max" class="cell-input" /></td>
              <td class="hint">{{ registerBounds(m.key) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="pointOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitPoint">登记点位</button>
        </div>
      </div>
    </div>

    <!-- 历史回填弹层 -->
    <div v-if="backfillOpen" class="modal-mask" @click.self="backfillOpen = false">
      <div class="modal wide">
        <h3>历史监测记录按下发日期一次性回填</h3>
        <p class="hint">
          一行一条，字段用「|」分隔：点位编号|采集时间|旧系统状态|温度|湿度|氧气|有害气体。
          残缺字段留空并标出；旧状态写了「正常」但任一指标未采集的，裁决为「伪正常」并按现有口径重判；
          同点同刻已有现场实测的不覆盖（实测优先）。
        </p>
        <label class="form-row"><span>下发日期</span><input v-model="issueDate" placeholder="2026-10-06" /></label>
        <textarea v-model="backfillText" rows="8" class="backfill-input"
          placeholder="POINT-001|2026-08-01 08:00|指标正常||||&#10;POINT-002|2026-08-03 08:00|已采集|26.5|68|20.8|4"></textarea>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <p v-if="backfillReport" class="report-text">
          回填完成：新增 {{ backfillReport.inserted }} 条，跳过 {{ backfillReport.skipped }} 条，
          识别伪正常 {{ backfillReport.falseNormal }} 条，残缺标注 {{ backfillReport.missingMarked }} 条。
        </p>
        <ul v-if="backfillReport" class="report-detail">
          <li v-for="(d, i) in backfillReport.details" :key="i">{{ d }}</li>
        </ul>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="backfillOpen = false">关闭</button>
          <button class="btn primary" type="button" @click="submitBackfill">一次性回填</button>
        </div>
      </div>
    </div>

    <!-- 详情面板：取值同样来自 getRecordView，与列表单元格逐值一致 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = undefined">
      <div class="modal wide">
        <h3>监测详情 · {{ detail.code }}</h3>
        <div class="detail-grid">
          <span class="hint">点位</span><strong>{{ detail.pointName }}（{{ detail.cabin }}）</strong>
          <span class="hint">采集时间</span><strong>{{ detail.collectedAt }}</strong>
          <span class="hint">收到时间</span><strong>{{ detail.receivedAt }}</strong>
          <span class="hint">数据来源</span><strong>{{ detail.source }}（冲突时现场实测优先）</strong>
        </div>
        <table class="data-table inner detail-table">
          <thead>
            <tr><th>指标</th><th>实测值</th><th>该点位标准范围</th><th>预警带</th><th>档位</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in detailRows" :key="row.key">
              <td>{{ row.label }}（{{ row.unit }}）</td>
              <td>{{ detail[row.key] === null ? '未采集（留空）' : detail[row.key] }}</td>
              <td>{{ row.range.standardMin }} ~ {{ row.range.standardMax }}</td>
              <td>{{ row.boundary.warnLow }} ~ {{ row.boundary.warnHigh }}</td>
              <td><span class="conclusion" :class="conclusionClass(detail.bands[row.key])">{{ detail.bands[row.key] }}</span></td>
            </tr>
          </tbody>
        </table>
        <p class="detail-conclusion">
          自动判定结论（四项取最高档）：
          <span class="conclusion big" :class="conclusionClass(detail.evaluated)">{{ detail.evaluated }}</span>
          <span v-if="detail.openTaskId" class="flag flag-bad">已联动通风待开机任务 #{{ detail.openTaskId }}</span>
        </p>
        <p v-if="detail.note" class="hint">备注：{{ detail.note }}</p>
        <p v-if="detail.missing.length" class="report-text">残缺字段：{{ missingLabels(detail.missing) }}（留空并标注，不按正常处理）</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="detail = undefined">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  backfillRecords,
  getRecordView,
  listPoints,
  listRecords,
  listReviews,
  registerPoint,
  resetEnvDomain,
  resolveReview,
  submitLive as submitLiveApi,
  thresholdSummary,
  type BackfillReport,
  type RecordView,
} from '@/api/env-service'
import { METRICS, RANGE_BOUNDS as BOUNDS, describeRule } from '@/data/env-rules'
import type { EnvBand, EnvMetricKey, EnvPoint } from '@/data/types'

const metricDefs = METRICS
const ruleText = describeRule()

const points = ref<EnvPoint[]>([])
const records = ref<RecordView[]>([])
const supersededRecords = ref<RecordView[]>([])
const reviews = ref<ReturnType<typeof listReviews>>([])

const liveOpen = ref(false)
const pointOpen = ref(false)
const backfillOpen = ref(false)
const formError = ref('')
const backfillReport = ref<BackfillReport | null>(null)
const issueDate = ref('2026-10-06')
const backfillText = ref('')
const detail = ref<RecordView | undefined>()

const liveForm = reactive({
  pointId: 1,
  collectedAt: '',
  values: { temperature: '', humidity: '', oxygen: '', gas: '' } as Record<EnvMetricKey, string>,
})
const pointForm = reactive({
  code: '',
  name: '',
  cabin: '',
  ranges: {
    temperature: { min: '5', max: '28' },
    humidity: { min: '40', max: '85' },
    oxygen: { min: '19.5', max: '23' },
    gas: { min: '0', max: '25' },
  },
})

const detailRows = computed(() => {
  if (!detail.value) {
    return []
  }
  const point = points.value.find((p) => p.id === detail.value!.pointId)
  if (!point) {
    return []
  }
  return thresholdSummary(point)
})

function reload() {
  points.value = listPoints()
  records.value = listRecords(false)
  supersededRecords.value = listRecords(true).filter((r) => r.superseded)
  reviews.value = listReviews()
  if (detail.value) {
    detail.value = getRecordView(detail.value.id)
  }
}

function countOf(band: EnvBand): number {
  return records.value.filter((r) => r.evaluated === band).length
}

function summaryOf(point: EnvPoint) {
  return thresholdSummary(point)
}

function registerBounds(key: EnvMetricKey): string {
  const def = metricDefs.find((m) => m.key === key)!
  // 可登记区间是规则常量，直接从规则引擎读，不在页面另存
  return `${def.label}标准可登记 ${BOUNDS[key].standardMin}~${BOUNDS[key].standardMax}；量程 ${def.physicalMin}~${def.physicalMax}${def.unit}`
}

function cell(row: RecordView, key: EnvMetricKey): string {
  const value = row[key]
  return value === null ? '未采集' : String(value)
}

function bandClass(band: EnvBand | undefined): string {
  if (band === '超标') return 'cell-bad'
  if (band === '预警') return 'cell-warn'
  return ''
}

function conclusionClass(band: EnvBand | undefined): string {
  if (band === '超标') return 'band-bad'
  if (band === '预警') return 'band-warn'
  if (band === '未采集') return 'band-none'
  return 'band-ok'
}

function missingLabels(keys: EnvMetricKey[]): string {
  return keys.map((k) => metricDefs.find((m) => m.key === k)!.label).join('、')
}

function openLive() {
  formError.value = ''
  liveForm.pointId = points.value[0]?.id ?? 1
  liveForm.collectedAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
  liveForm.values = { temperature: '', humidity: '', oxygen: '', gas: '' }
  liveOpen.value = true
}

function openPoint() {
  formError.value = ''
  pointOpen.value = true
}

function openBackfill() {
  formError.value = ''
  backfillReport.value = null
  backfillOpen.value = true
}

function openDetail(id: number) {
  detail.value = getRecordView(id)
}

function submitLive() {
  formError.value = ''
  const result = submitLiveApi({
    pointId: Number(liveForm.pointId),
    collectedAt: liveForm.collectedAt,
    values: liveForm.values,
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  liveOpen.value = false
  reload()
}

function submitPoint() {
  formError.value = ''
  const result = registerPoint({
    code: pointForm.code,
    name: pointForm.name,
    cabin: pointForm.cabin,
    ranges: pointForm.ranges,
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  pointOpen.value = false
  reload()
}

function submitBackfill() {
  formError.value = ''
  const lines = backfillText.value.split('\n').map((l) => l.trim()).filter(Boolean)
  const entries = lines.map((line) => {
    const [pointCode, collectedAt, oldStatus, t, h, o, g] = line.split('|').map((s) => s.trim())
    return {
      pointCode,
      collectedAt,
      oldStatus: oldStatus ?? '',
      values: { temperature: t ?? '', humidity: h ?? '', oxygen: o ?? '', gas: g ?? '' },
    }
  })
  const result = backfillRecords(entries, issueDate.value)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  backfillReport.value = result.data
  reload()
}

function doResolve(id: number) {
  const result = resolveReview(id)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  reload()
}

function resetAll() {
  resetEnvDomain()
  reload()
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
.hint { color: var(--muted); font-size: 12px; }
.inner { margin-top: 8px; }
.point-block { margin-bottom: 14px; }
.point-head { display: flex; gap: 12px; align-items: center; }
.tag { background: #eef2f7; border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
.cell-bad { color: #b42318; font-weight: 600; }
.cell-warn { color: #b54708; font-weight: 600; }
.band-bad { color: #b42318; }
.band-warn { color: #b54708; }
.band-ok { color: #067647; }
.band-none { color: var(--muted); }
.conclusion { font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #f2f4f7; }
.conclusion.big { font-size: 16px; }
.flag { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 12px; margin-right: 4px; }
.flag-bad { background: #fee4e2; color: #b42318; }
.flag-miss { background: #fef3c7; color: #92400e; }
.superseded { margin-top: 10px; font-size: 12px; color: var(--muted); }
.modal-mask {
  position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45);
  display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px; z-index: 50;
  overflow-y: auto;
}
.modal {
  background: #fff; border-radius: 10px; padding: 18px 20px; width: 520px; max-width: 100%;
}
.modal.wide { width: 760px; }
.modal h3 { margin: 0 0 8px; }
.form-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; }
.form-row span { width: 150px; color: var(--muted); flex-shrink: 0; }
.form-row input, .form-row select { flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.cell-input { width: 100%; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.backfill-input { width: 100%; font-family: monospace; font-size: 12px; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.report-text { color: #067647; font-size: 13px; margin: 8px 0 4px; }
.report-detail { font-size: 12px; color: var(--muted); margin: 0; padding-left: 18px; }
.detail-grid { display: grid; grid-template-columns: 90px 1fr 90px 1fr; gap: 6px 10px; font-size: 13px; margin-bottom: 10px; }
.detail-conclusion { margin-top: 12px; font-size: 14px; }
.detail-table { margin-bottom: 8px; }
</style>
