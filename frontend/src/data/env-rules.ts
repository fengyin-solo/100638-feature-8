import type { EnvBand, EnvMetricKey, MetricRange } from './types'

/**
 * 廊内环境监测 —— 判定规则唯一口径（single source of truth）。
 *
 * 本文件是全平台唯一一份「判定条件 + 取值上限」：
 *   - 监测列表、详情面板、复核清单、通风联动只准调用这里的函数；
 *   - 任何页面/服务不得再抄一份阈值或另写判断分支；
 *   - 改口径只改本文件，改完全平台自动一致（同一指标两处结论必然相同）。
 */

// ── 指标定义：名称、单位、物理取值上限（不允许保存的取值以此卡） ──────────────

export type MetricDef = {
  key: EnvMetricKey
  /** 页面展示名，同时也是记录字段的中文键 */
  label: string
  unit: string
  /** 仪器可录入的物理闭区间；越界一律拒绝，不允许保存 */
  physicalMin: number
  physicalMax: number
  /** 最多允许小数位，超出按非法取值退回 */
  decimals: number
}

export const METRICS: MetricDef[] = [
  { key: 'temperature', label: '环境温度', unit: '℃', physicalMin: -40, physicalMax: 80, decimals: 1 },
  { key: 'humidity', label: '空气湿度', unit: '%RH', physicalMin: 0, physicalMax: 100, decimals: 0 },
  { key: 'oxygen', label: '氧气浓度', unit: '%VOL', physicalMin: 0, physicalMax: 25, decimals: 2 },
  { key: 'gas', label: '有害气体浓度', unit: '%LEL', physicalMin: 0, physicalMax: 100, decimals: 2 },
]

export const METRIC_BY_KEY: Map<EnvMetricKey, MetricDef> = new Map(METRICS.map((m) => [m.key, m]))

// ── 点位标准范围的允许登记区间（登记点位标准时，标准范围必须落在这里） ────────
/** 不允许保存的取值：标准上下限倒挂、超出此区间、边界不闭区间，一律拒绝。 */
export const RANGE_BOUNDS: Record<EnvMetricKey, MetricRange> = {
  temperature: { standardMin: -20, standardMax: 60 },
  humidity: { standardMin: 10, standardMax: 100 },
  oxygen: { standardMin: 15, standardMax: 23.5 },
  gas: { standardMin: 0, standardMax: 50 },
}

// ── 分档阈值：四个指标同一套规则，只留这一份 ─────────────────────────────────
/**
 * 统一分档规则（闭区间，全部指标共用同一套条件）：
 *   预警带 = 标准范围两侧各外扩 WARN_MARGIN（占标准带宽比例，封顶 WARN_MARGIN_MAX）；
 *   落在标准闭区间内（含边界）      → 正常
 *   越过标准边界、但仍在预警带内    → 预警
 *   越过预警带（含预警带边界外侧）  → 超标
 * 物理上限/仪器量程由 RANGE_BOUNDS / physicalMax 在入库前另卡，不参与分档。
 */
export const WARN_MARGIN_RATIO = 0.2
export const WARN_MARGIN_MAX: Record<EnvMetricKey, number> = {
  temperature: 4, // ℃
  humidity: 10, // %RH
  oxygen: 1.5, // %VOL
  gas: 10, // %LEL
}

export function warnMargin(metric: EnvMetricKey, range: MetricRange): number {
  const width = range.standardMax - range.standardMin
  return Math.min(WARN_MARGIN_MAX[metric], Math.round(width * WARN_MARGIN_RATIO * 100) / 100)
}

export type BandBoundary = {
  standardMin: number
  standardMax: number
  warnLow: number
  warnHigh: number
  margin: number
}

export function bandBoundary(metric: EnvMetricKey, range: MetricRange): BandBoundary {
  const margin = warnMargin(metric, range)
  return {
    standardMin: range.standardMin,
    standardMax: range.standardMax,
    warnLow: round(metric, range.standardMin - margin),
    warnHigh: round(metric, range.standardMax + margin),
    margin,
  }
}

// ── 判定函数：所有入口的结论只准从这里出 ─────────────────────────────────────

/**
 * 单指标分档。value 为 null/undefined 表示未采集 → 「未采集」，
 * 任何入口都不得把未采集改写成正常。
 */
export function gradeMetric(
  metric: EnvMetricKey,
  value: number | null | undefined,
  range: MetricRange,
): EnvBand {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '未采集'
  }
  const b = bandBoundary(metric, range)
  if (value >= b.standardMin && value <= b.standardMax) {
    return '正常'
  }
  if (value >= b.warnLow && value <= b.warnHigh) {
    return '预警'
  }
  return '超标'
}

const BAND_RANK: Record<EnvBand, number> = { 未采集: 0, 正常: 1, 预警: 2, 超标: 3 }

/**
 * 记录级结论：四个指标档位取最高一档（超标 > 预警 > 正常 > 未采集）。
 * - 四项全部未采集（或整笔无值）→ 记录结论为「未采集」；
 * - 历史伪正常（未采集被写成正常）在识别前不得参与结论，由服务层裁定后再算。
 */
export function mergeBands(bands: Partial<Record<EnvMetricKey, EnvBand>>): EnvBand {
  const present = METRICS.map((m) => bands[m.key]).filter((x): x is EnvBand => x !== undefined)
  if (present.length === 0) {
    return '未采集'
  }
  return present.reduce<EnvBand>((worst, band) => (BAND_RANK[band] > BAND_RANK[worst] ? band : worst), '未采集')
}

// ── 入库前的取值校验：不允许保存的取值在此一次性列清 ─────────────────────────

export type ValueCheck =
  | { ok: true; value: number }
  | { ok: false; message: string }

/** 空值是否合法由调用场景区分：现场报送必填不允许空；历史回填允许残缺留空。 */
export function checkMetricValue(
  metric: EnvMetricKey,
  raw: string | number | null | undefined,
  allowEmpty: boolean,
): ValueCheck {
  const def = METRIC_BY_KEY.get(metric)!
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return allowEmpty
      ? { ok: true, value: Number.NaN }
      : { ok: false, message: `${def.label}为必填项，未采集不允许报送，留空请走历史回填` }
  }
  const text = String(raw).trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return { ok: false, message: `${def.label}「${text}」不是数值，不允许保存非数值取值` }
  }
  const value = Number(text)
  if (Number.isNaN(value)) {
    return { ok: false, message: `${def.label}无法解析为数值，整笔退回` }
  }
  const fraction = text.includes('.') ? text.split('.')[1].length : 0
  if (fraction > def.decimals) {
    return { ok: false, message: `${def.label}最多保留 ${def.decimals} 位小数，「${text}」不允许保存` }
  }
  if (value < def.physicalMin || value > def.physicalMax) {
    return { ok: false, message: `${def.label}量程为 ${def.physicalMin}~${def.physicalMax}${def.unit}，「${text}」超出物理取值上限，不允许保存` }
  }
  return { ok: true, value }
}

export type RangeCheck =
  | { ok: true; range: MetricRange }
  | { ok: false; message: string }

/** 点位标准范围登记校验：倒挂、越界、非数值、小数超限都拒绝。 */
export function checkStandardRange(
  metric: EnvMetricKey,
  rawMin: string | number,
  rawMax: string | number,
): RangeCheck {
  const minCheck = checkMetricValue(metric, rawMin, false)
  if (!minCheck.ok) {
    return { ok: false, message: `标准下限${minCheck.message}` }
  }
  const maxCheck = checkMetricValue(metric, rawMax, false)
  if (!maxCheck.ok) {
    return { ok: false, message: `标准上限${maxCheck.message}` }
  }
  const min = minCheck.value
  const max = maxCheck.value
  const bounds = RANGE_BOUNDS[metric]
  if (min >= max) {
    return { ok: false, message: `${METRIC_BY_KEY.get(metric)!.label}标准下限必须严格小于上限，倒挂区间不允许保存` }
  }
  if (min < bounds.standardMin || max > bounds.standardMax) {
    return { ok: false, message: `${METRIC_BY_KEY.get(metric)!.label}标准范围只能登记在 ${bounds.standardMin}~${bounds.standardMax} 之内，超出部分不允许保存` }
  }
  return { ok: true, range: { standardMin: min, standardMax: max } }
}

function round(metric: EnvMetricKey, value: number): number {
  const decimals = METRIC_BY_KEY.get(metric)!.decimals
  const factor = 10 ** Math.min(decimals, 4)
  return Math.round(value * factor) / factor
}

/** 供页面展示「口径」用的说明文案，仍然只有这一份。 */
export function describeRule(): string {
  return (
    '统一分档：标准闭区间内=正常；越过标准边界但落在预警带（标准带两侧各外扩20%、各指标封顶值见阈值表）=预警；越过预警带=超标。' +
    '记录结论取温度/湿度/氧气/有害气体四项中最高一档。未采集一律保持「未采集」，任何入口不得写成正常。'
  )
}
