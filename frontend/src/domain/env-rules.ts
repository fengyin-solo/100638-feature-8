/**
 * 廊内环境监测 —— 判定口径唯一真源（single source of truth）。
 *
 * 本文件是全系统唯一一份：四个指标的标准范围、分档条件、取值上限、
 * 「不允许保存的取值」清单都在这里。监测页、复核清单、通风联动、
 * 历史回填、详情面板全部只能调用这里的纯函数，不允许各自抄一份条件。
 *
 * 依据：GB 50838《城市综合管廊工程技术规范》7.5 环境与设备监控的
 * 运行要求（O₂ 19.5%~23.5%、温度不高于 40℃、相对湿度不大于 90%、
 * 有害气体 H₂S≤10ppm 等），结合现场仪表量程给出物理硬上限做录入拦截。
 */

// ---------------------------------------------------------------------------
// 一、指标与点位标准
// ---------------------------------------------------------------------------

/** 四个指标的固定键，顺序即展示与计算顺序，任何地方不得重排、改名。 */
export const ENV_METRICS = [
  '环境温度',
  '空气湿度',
  '氧气浓度',
  '有害气体浓度',
] as const

export type EnvMetric = (typeof ENV_METRICS)[number]

/** 分档结论：同一指标在任意两处算出来的结论必须取自这同一组枚举。 */
export type EnvGrade = '正常' | '一级预警' | '二级超标' | '缺失'

/** 点位（记录）整体结论，由四个指标按“就高不就低”合成。 */
export type RecordVerdict = '待采集' | '指标缺失' | '指标正常' | '一级预警' | '二级超标'

/** 记录在业务上的当前状态（与模块状态机对齐，结论是唯一推导依据）。 */
export const VERDICT_STATUS: Record<RecordVerdict, string> = {
  待采集: '待采集',
  指标缺失: '已采集',
  指标正常: '指标正常',
  一级预警: '指标超标',
  二级超标: '指标超标',
}

export type MetricSpec = {
  metric: EnvMetric
  /** 计量单位，仅展示用，不参与判定。 */
  unit: string
  /** 登记点位标准范围时允许的物理下限/上限（硬量程），标准范围必须落在其中。 */
  physicalMin: number
  physicalMax: number
  /** 新登记点位的默认标准范围（[含下限, 含上限]，闭区间）。 */
  defaultMin: number
  defaultMax: number
  /**
   * 分档条件（四个指标共用同一套规则，只换数值）：
   *   标准闭区间内             → 正常
   *   越界且超出量 ≤ warnBand → 一级预警
   *   越界且超出量 > warnBand → 二级超标
   * 边界取等归轻档：超出量恰好等于 warnBand 记一级预警。
   */
  warnBand: number
  /** 小数位：解析后按此精度比较，超出精度的尾差不制造档位分歧。 */
  precision: number
}

/**
 * 指标口径表：全系统唯一一份。取值上限（physicalMax）只在这里出现。
 * 阈值修订单走版本，不在页面、回填脚本里另写数字。
 */
export const METRIC_SPECS: Record<EnvMetric, MetricSpec> = {
  环境温度: {
    metric: '环境温度',
    unit: '℃',
    physicalMin: -40,
    physicalMax: 80,
    defaultMin: 5,
    defaultMax: 40,
    warnBand: 5,
    precision: 1,
  },
  空气湿度: {
    metric: '空气湿度',
    unit: '%RH',
    physicalMin: 0,
    physicalMax: 100,
    defaultMin: 30,
    defaultMax: 90,
    warnBand: 5,
    precision: 0,
  },
  氧气浓度: {
    metric: '氧气浓度',
    unit: '%VOL',
    physicalMin: 0,
    physicalMax: 30,
    defaultMin: 19.5,
    defaultMax: 23.5,
    warnBand: 1,
    precision: 2,
  },
  有害气体浓度: {
    metric: '有害气体浓度',
    unit: 'ppm',
    physicalMin: 0,
    physicalMax: 100,
    defaultMin: 0,
    defaultMax: 10,
    warnBand: 10,
    precision: 1,
  },
}

/** 每个点位登记的一份标准范围；范围是闭区间 [min, max]。 */
export type PointStandard = {
  监测点位: string
  所属舱室: string
  ranges: Record<EnvMetric, { min: number; max: number }>
  /** 标准生效日（下发日期），历史回填按此对齐口径版本。 */
  effectiveDate: string
}

/** 登记点位标准时的校验结论；不合法的标准与不合法的采集值一律不许落库。 */
export type StandardIssue =
  | { ok: true }
  | { ok: false; metric: EnvMetric | '监测点位' | '所属舱室'; message: string }

export function validateStandard(std: PointStandard): StandardIssue {
  if (std.监测点位.trim() === '') {
    return { ok: false, metric: '监测点位', message: '监测点位不允许为空' }
  }
  if (std.所属舱室.trim() === '') {
    return { ok: false, metric: '所属舱室', message: '所属舱室不允许为空（通风联动按舱室排任务）' }
  }
  for (const metric of ENV_METRICS) {
    const spec = METRIC_SPECS[metric]
    const range = std.ranges[metric]
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      return { ok: false, metric, message: `${metric}标准上下限不允许留空或写成非数字` }
    }
    if (range.min < spec.physicalMin || range.max > spec.physicalMax) {
      return {
        ok: false,
        metric,
        message: `${metric}标准范围必须落在仪表量程 ${spec.physicalMin}~${spec.physicalMax}${spec.unit} 内`,
      }
    }
    if (range.min >= range.max) {
      return { ok: false, metric, message: `${metric}标准下限必须小于上限` }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 二、不允许保存的取值（唯一一份禁存清单，录入、回填共用）
// ---------------------------------------------------------------------------

/**
 * 判定一个「采集到的单元格值」是否允许落库。不允许保存的取值：
 *  1. 空串、纯空白；
 *  2. 非数字文本（早年把“未采集”写成“正常/--”等文字一律拒收，留空并标缺失）；
 *  3. NaN / Infinity；
 *  4. 超出仪表硬量程（含越过 physicalMin/physicalMax，物理上不可能）；
 *  5. null / undefined。
 * 标准范围边界上的合法值照常保存，不在禁存之列。
 */
export type ParsedValue = { ok: true; value: number } | { ok: false; reason: string }

export function parseMetricValue(raw: unknown, metric: EnvMetric): ParsedValue {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: '未采集，留空并标记缺失' }
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return { ok: false, reason: '未采集，留空并标记缺失' }
  }
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(num)) {
    return { ok: false, reason: `非数值不允许保存：${String(raw)}` }
  }
  const spec = METRIC_SPECS[metric]
  if (num < spec.physicalMin || num > spec.physicalMax) {
    return {
      ok: false,
      reason: `越过仪表量程上限 ${spec.physicalMax}${spec.unit}（下限 ${spec.physicalMin}），不允许保存`,
    }
  }
  return { ok: true, value: Number(num.toFixed(spec.precision)) }
}

// ---------------------------------------------------------------------------
// 三、统一判定：四个指标同一套分档规则，条件只在此实现一次
// ---------------------------------------------------------------------------

export type MetricResult = {
  metric: EnvMetric
  grade: EnvGrade
  /** 归一化后的实测值；缺失时为 null，详情面板据此显示“—（缺失）”。 */
  value: number | null
  min: number
  max: number
  /** 越过最近边界的距离；正常/缺失为 0。 */
  excess: number
  /** 触发档位时的人类可读说明，列表与详情共用同一份文案。 */
  reason: string
}

function round(value: number, metric: EnvMetric): number {
  return Number(value.toFixed(METRIC_SPECS[metric].precision))
}

/** 单指标判定。任何页面、任何回填脚本都只能通过它得到档位结论。 */
export function evaluateMetric(
  metric: EnvMetric,
  raw: unknown,
  range: { min: number; max: number },
): MetricResult {
  const spec = METRIC_SPECS[metric]
  const parsed = parseMetricValue(raw, metric)
  if (!parsed.ok) {
    return {
      metric,
      grade: '缺失',
      value: null,
      min: range.min,
      max: range.max,
      excess: 0,
      reason: parsed.reason,
    }
  }
  const value = parsed.value
  if (value >= range.min && value <= range.max) {
    return {
      metric,
      grade: '正常',
      value,
      min: range.min,
      max: range.max,
      excess: 0,
      reason: `${value}${spec.unit} 在标准 [${range.min}, ${range.max}] 内`,
    }
  }
  const boundary = value < range.min ? range.min : range.max
  const excess = round(Math.abs(value - boundary), metric)
  const direction = value < range.min ? '低于下限' : '高于上限'
  const grade: EnvGrade = excess <= spec.warnBand ? '一级预警' : '二级超标'
  return {
    metric,
    grade,
    value,
    min: range.min,
    max: range.max,
    excess,
    reason: `${value}${spec.unit} ${direction} ${boundary}，超出 ${excess}${spec.unit}（${
      excess <= spec.warnBand
        ? `≤ 预警带宽 ${spec.warnBand}`
        : `> 预警带宽 ${spec.warnBand}`
    }）→ ${grade}`,
  }
}

const GRADE_WEIGHT: Record<EnvGrade, number> = {
  缺失: 0, // 缺失不参与“正常/超标”合成，单独走指标缺失
  正常: 1,
  一级预警: 2,
  二级超标: 3,
}

export type RecordEvaluation = {
  verdict: RecordVerdict
  results: MetricResult[]
  /** 缺失指标名，残缺字段在详情/复核两处都按它高亮。 */
  missing: EnvMetric[]
  /** 触发最高档位的指标（通风联动、复核排序都看它）。 */
  worst: EnvMetric | null
  /** 结论说明，列表、详情面板、复核清单三处取同一份字符串。 */
  summary: string
}

/**
 * 点位整体判定，规则唯一：
 *  - 四项全缺失           → 待采集（早年“未采集写成正常”的回填识别依据）；
 *  - 有采集值但存在缺失项 → 指标缺失（已采集但不得判正常）；
 *  - 四项齐全且全部正常   → 指标正常；
 *  - 否则取四项里最高档位 → 一级预警 / 二级超标。
 */
export function evaluateRecord(
  values: Partial<Record<EnvMetric, unknown>>,
  standard: PointStandard,
): RecordEvaluation {
  const results = ENV_METRICS.map((metric) =>
    evaluateMetric(metric, values[metric], standard.ranges[metric]),
  )
  const present = results.filter((item) => item.grade !== '缺失')
  const missing = results.filter((item) => item.grade === '缺失').map((item) => item.metric)

  if (present.length === 0) {
    return {
      verdict: '待采集',
      results,
      missing: [...ENV_METRICS],
      worst: null,
      summary: '四项指标均未采集，判为待采集（不允许记正常）',
    }
  }
  if (missing.length > 0) {
    return {
      verdict: '指标缺失',
      results,
      missing,
      worst: null,
      summary: `已采集但残缺：${missing.join('、')} 留空，不得判正常`,
    }
  }
  const top = results.reduce((worst, current) =>
    GRADE_WEIGHT[current.grade] > GRADE_WEIGHT[worst.grade] ? current : worst,
  )
  const verdict: RecordVerdict =
    top.grade === '正常' ? '指标正常' : (top.grade as '一级预警' | '二级超标')
  return {
    verdict,
    results,
    missing: [],
    worst: top.grade === '正常' ? null : top.metric,
    summary:
      top.grade === '正常'
        ? '四项指标均在标准范围内'
        : `${top.metric}${top.grade}（超出 ${top.excess}${METRIC_SPECS[top.metric].unit}），按就高不就低判${verdict}`,
  }
}

/** 是否牵动通风：只认二级超标。一级预警仅提示，不排待开机任务。 */
export function requiresVentilation(evaluation: RecordEvaluation): boolean {
  return evaluation.verdict === '二级超标'
}

// ---------------------------------------------------------------------------
// 四、口径版本与冲突优先级（写进每条落库记录，保证前后两次读到同一份）
// ---------------------------------------------------------------------------

export const RULE_VERSION = 'env-rules-2026-10-06'

/** 数据来源优先级：两处取值打架时，序号小者为准，其余按它重算。 */
export const SOURCE_PRIORITY = {
  现场实测: 1,
  复核补录: 2,
  历史回填: 3,
} as const

export type EnvDataSource = keyof typeof SOURCE_PRIORITY

export function higherPriority(a: EnvDataSource, b: EnvDataSource): EnvDataSource {
  return SOURCE_PRIORITY[a] <= SOURCE_PRIORITY[b] ? a : b
}
