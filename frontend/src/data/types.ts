/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ── 廊内环境监测域：点位标准、监测记录、复核清单、通风待开机任务 ──────────────

/** 四个环境指标的固定键名，页面与存储一律用这套，不允许再起别名 */
export type EnvMetricKey = 'temperature' | 'humidity' | 'oxygen' | 'gas'

/** 单指标判定档位；全系统只有这四档，记录与复核清单都从这里取 */
export type EnvBand = '未采集' | '正常' | '预警' | '超标'

/** 点位登记的各指标标准范围（闭区间）；分档阈值不在这里，只在规则引擎里 */
export type MetricRange = {
  standardMin: number
  standardMax: number
}

/** 监测点位档案：标准范围按点位登记，一档阈值全平台共用 */
export type EnvPoint = {
  id: number
  code: string
  name: string
  cabin: string
  ranges: Record<EnvMetricKey, MetricRange>
  active: boolean
  createdAt: string
}

/**
 * 环境监测记录。
 * - 四个指标值缺失（null/空串）表示该指标未采集，严禁回填成正常值；
 * - bands/conclusion 永远由规则引擎现算后回写，任何入口不得手填；
 * - source 标注数据来源：现场实测优先于历史回填。
 */
export type EnvRecord = {
  id: number
  code: string
  pointId: number
  pointName: string
  cabin: string
  temperature: number | null
  humidity: number | null
  oxygen: number | null
  gas: number | null
  collectedAt: string
  receivedAt: string
  source: '现场实测' | '历史回填'
  /** 历史回填时指标残缺：缺失指标键名列表，残缺字段留空并在此标出 */
  missing: EnvMetricKey[]
  /** 早年把未采集写成正常的记录，回填时识别后挂这个标记 */
  suspectFalseNormal: boolean
  /** 同点位同采集时间被最后一版替代：只认最后一版，旧版留痕但不参与任何判定 */
  superseded: boolean
  bands: Partial<Record<EnvMetricKey, EnvBand>>
  conclusion: EnvBand
  abnormal: boolean
  note: string
}

/** 复核清单条目：结论由规则引擎算完写回，监测页与通风页两处看到的是同一行 */
export type EnvReviewItem = {
  id: number
  recordId: number
  recordCode: string
  pointName: string
  cabin: string
  collectedAt: string
  conclusion: EnvBand
  bands: Partial<Record<EnvMetricKey, EnvBand>>
  reason: string
  source: '现场实测' | '历史回填'
  ventilationTaskId: number | null
  handled: boolean
  createdAt: string
}

/** 通风系统待开机任务：按超标舱室排出，同舱室只挂一条待开机 */
export type VentilationTask = {
  id: number
  taskCode: string
  cabin: string
  triggerRecordId: number
  triggerRecordCode: string
  triggerPointName: string
  triggerBands: Partial<Record<EnvMetricKey, EnvBand>>
  issuedAt: string
  source: '现场实测' | '历史回填'
  status: '待开机' | '运行中' | '已解除'
}
