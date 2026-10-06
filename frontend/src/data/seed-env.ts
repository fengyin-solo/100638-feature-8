import { gradeMetric, mergeBands } from './env-rules'
import type {
  EnvMetricKey,
  EnvPoint,
  EnvRecord,
  EnvReviewItem,
  VentilationTask,
} from './types'

/**
 * 环境监测域播种数据（按下发日期 2026-10-06 一次性补齐的存量）。
 * 所有 bands/conclusion 由规则引擎现算，种子里不手写结论，避免两处取值打架。
 */

const pointA: EnvPoint = {
  id: 1,
  code: 'POINT-001',
  name: '1号电力舱·A段监测点',
  cabin: '1号电力舱A段',
  ranges: {
    temperature: { standardMin: 5, standardMax: 28 },
    humidity: { standardMin: 40, standardMax: 85 },
    oxygen: { standardMin: 19.5, standardMax: 23 },
    gas: { standardMin: 0, standardMax: 25 },
  },
  active: true,
  createdAt: '2026-09-01',
}

const pointB: EnvPoint = {
  id: 2,
  code: 'POINT-002',
  name: '2号综合舱·B段监测点',
  cabin: '2号综合舱B段',
  ranges: {
    temperature: { standardMin: 5, standardMax: 30 },
    humidity: { standardMin: 40, standardMax: 80 },
    oxygen: { standardMin: 19.5, standardMax: 23 },
    gas: { standardMin: 0, standardMax: 20 },
  },
  active: true,
  createdAt: '2026-09-01',
}

const pointC: EnvPoint = {
  id: 3,
  code: 'POINT-003',
  name: '3号燃气舱·C段监测点',
  cabin: '3号燃气舱C段',
  ranges: {
    temperature: { standardMin: 5, standardMax: 28 },
    humidity: { standardMin: 35, standardMax: 85 },
    oxygen: { standardMin: 19.5, standardMax: 23 },
    gas: { standardMin: 0, standardMax: 15 },
  },
  active: true,
  createdAt: '2026-09-01',
}

export const SEED_POINTS: EnvPoint[] = [pointA, pointB, pointC]

type SeedInput = {
  id: number
  code: string
  pointId: number
  collectedAt: string
  receivedAt: string
  source: '现场实测' | '历史回填'
  values: Partial<Record<EnvMetricKey, number | null>>
  suspectFalseNormal?: boolean
  superseded?: boolean
  note?: string
}

function buildRecord(point: EnvPoint, input: SeedInput): EnvRecord {
  const full: Record<EnvMetricKey, number | null> = {
    temperature: input.values.temperature ?? null,
    humidity: input.values.humidity ?? null,
    oxygen: input.values.oxygen ?? null,
    gas: input.values.gas ?? null,
  }
  const missing = (Object.keys(full) as EnvMetricKey[]).filter((k) => full[k] === null)
  const bands = {} as Partial<Record<EnvMetricKey, ReturnType<typeof gradeMetric>>>
  ;(Object.keys(full) as EnvMetricKey[]).forEach((k) => {
    bands[k] = gradeMetric(k, full[k], point.ranges[k])
  })
  const conclusion = mergeBands(bands)
  return {
    id: input.id,
    code: input.code,
    pointId: point.id,
    pointName: point.name,
    cabin: point.cabin,
    temperature: full.temperature,
    humidity: full.humidity,
    oxygen: full.oxygen,
    gas: full.gas,
    collectedAt: input.collectedAt,
    receivedAt: input.receivedAt,
    source: input.source,
    missing,
    suspectFalseNormal: input.suspectFalseNormal ?? false,
    superseded: input.superseded ?? false,
    bands,
    conclusion,
    abnormal: conclusion === '超标' || input.suspectFalseNormal === true,
    note: input.note ?? '',
  }
}

const inputs: SeedInput[] = [
  // 早年把未采集写成正常的两条：数值整体残缺，旧系统状态却写成「指标正常」
  {
    id: 1,
    code: 'ENVM-0001',
    pointId: 1,
    collectedAt: '2026-09-05 08:00',
    receivedAt: '2026-09-05 09:10',
    source: '历史回填',
    values: { temperature: null, humidity: null, oxygen: null, gas: null },
    suspectFalseNormal: true,
    note: '旧系统将未采集记为「指标正常」，回填时四项实测值均缺失',
  },
  {
    id: 2,
    code: 'ENVM-0002',
    pointId: 2,
    collectedAt: '2026-09-12 08:00',
    receivedAt: '2026-09-12 09:05',
    source: '历史回填',
    values: { temperature: 24.2, humidity: null, oxygen: null, gas: null },
    suspectFalseNormal: true,
    note: '旧系统记为「指标正常」，湿度/氧气/有害气体三项未采集',
  },
  // 正常记录
  {
    id: 3,
    code: 'ENVM-0003',
    pointId: 1,
    collectedAt: '2026-09-20 08:00',
    receivedAt: '2026-09-20 08:12',
    source: '历史回填',
    values: { temperature: 22.4, humidity: 62, oxygen: 20.9, gas: 3 },
  },
  // 预警：温度越过上限进入预警带，其余正常
  {
    id: 4,
    code: 'ENVM-0004',
    pointId: 2,
    collectedAt: '2026-09-26 08:00',
    receivedAt: '2026-09-26 08:15',
    source: '历史回填',
    values: { temperature: 31.2, humidity: 71, oxygen: 20.6, gas: 6 },
  },
  // 超标：有害气体越预警带 → 按舱室排一条待开机任务
  {
    id: 5,
    code: 'ENVM-0005',
    pointId: 3,
    collectedAt: '2026-10-02 08:00',
    receivedAt: '2026-10-02 08:10',
    source: '历史回填',
    values: { temperature: 26.1, humidity: 72, oxygen: 20.1, gas: 32 },
  },
  // 现场实测：同点位同采集时间的旧版本（被最后一版替代，不参与任何判定）
  {
    id: 6,
    code: 'ENVM-0006',
    pointId: 1,
    collectedAt: '2026-10-06 08:00',
    receivedAt: '2026-10-06 08:09',
    source: '现场实测',
    values: { temperature: 30.5, humidity: 78, oxygen: 20.4, gas: 22 },
    superseded: true,
    note: '同点同刻早一版，已被 08:16 的最后一版替代，只认最后一版',
  },
  // 现场实测最后一版：温度超标 + 有害气体超标，残缺湿度按未采集留空
  {
    id: 7,
    code: 'ENVM-0007',
    pointId: 1,
    collectedAt: '2026-10-06 08:00',
    receivedAt: '2026-10-06 08:16',
    source: '现场实测',
    values: { temperature: 34.8, humidity: null, oxygen: 20.4, gas: 31 },
    note: '同点同刻最后一版（现场实测），湿度仪器故障未采集',
  },
]

const pointMap = new Map(SEED_POINTS.map((p) => [p.id, p]))
export const SEED_RECORDS: EnvRecord[] = inputs.map((input) => buildRecord(pointMap.get(input.pointId)!, input))

// 复核清单：所有结论异常（预警/超标/残缺/伪正常）的存量记录都写回，两处入口读同一行
function reasonFor(record: EnvRecord): string {
  if (record.suspectFalseNormal) {
    return `历史伪正常：${record.missing.length ? `缺失 ${record.missing.join('/')} 等实测值却被旧系统写成正常` : '实测值与正常结论不符'}，已改判为${record.conclusion}`
  }
  const over = (Object.entries(record.bands) as [EnvMetricKey, string][]).filter(([, band]) => band === '超标').map(([k]) => k)
  const warn = (Object.entries(record.bands) as [EnvMetricKey, string][]).filter(([, band]) => band === '预警').map(([k]) => k)
  const parts: string[] = []
  if (over.length) parts.push(`超标指标：${over.join('、')}`)
  if (warn.length) parts.push(`预警指标：${warn.join('、')}`)
  if (record.missing.length) parts.push(`未采集：${record.missing.join('、')}（字段留空）`)
  return parts.join('；') || '各项指标正常'
}

export const SEED_REVIEWS: EnvReviewItem[] = SEED_RECORDS.filter(
  (r) => !r.superseded && (r.conclusion !== '正常' || r.suspectFalseNormal || r.missing.length > 0),
).map((r, i) => ({
  id: i + 1,
  recordId: r.id,
  recordCode: r.code,
  pointName: r.pointName,
  cabin: r.cabin,
  collectedAt: r.collectedAt,
  conclusion: r.conclusion,
  bands: r.bands,
  reason: reasonFor(r),
  source: r.source,
  ventilationTaskId: r.id === 5 ? 1 : null,
  handled: false,
  createdAt: '2026-10-06 09:00',
}))

// 通风待开机任务：ENVM-0005 有害气体超标，3号燃气舱C段排出一条
export const SEED_TASKS: VentilationTask[] = [
  {
    id: 1,
    taskCode: 'VTASK-0001',
    cabin: '3号燃气舱C段',
    triggerRecordId: 5,
    triggerRecordCode: 'ENVM-0005',
    triggerPointName: '3号燃气舱·C段监测点',
    triggerBands: SEED_RECORDS.find((r) => r.id === 5)!.bands,
    issuedAt: '2026-10-02 08:20',
    source: '历史回填',
    status: '待开机',
  },
]

export const SEED_ENV = {
  envPoints: SEED_POINTS,
  envRecords: SEED_RECORDS,
  envReviews: SEED_REVIEWS,
  ventilationTasks: SEED_TASKS,
}
