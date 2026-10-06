import {
  METRICS,
  METRIC_BY_KEY,
  RANGE_BOUNDS,
  bandBoundary,
  checkMetricValue,
  checkStandardRange,
  gradeMetric,
  mergeBands,
} from '@/data/env-rules'
import {
  commitEnv,
  defaultRanges,
  envTables,
  nextId,
  pointById,
  resetEnv,
} from '@/data/env-domain'
import type {
  EnvBand,
  EnvMetricKey,
  EnvPoint,
  EnvRecord,
  EnvReviewItem,
  MetricRange,
  VentilationTask,
} from '@/data/types'

/**
 * 环境监测域服务：页面不做任何业务判断，只调这里。
 * 所有写操作在 commitEnv 的快照里完成：中途抛错整笔退回，落盘后读到的即所提交那份。
 */

export type ServiceResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; message: string }

// ── 取值与结论：列表、详情、复核、通风共用同一个函数，两处结论必然一致 ────────

export type RecordView = EnvRecord & {
  bands: Record<EnvMetricKey, EnvBand>
  /** 当前点位标准下重算的结论（详情面板与列表取值一致的保证） */
  evaluated: EnvBand
  openTaskId: number | null
}

export function evaluateRecord(record: EnvRecord, point: EnvPoint | undefined): EnvBand {
  if (!point) {
    return record.conclusion
  }
  const bands = {} as Partial<Record<EnvMetricKey, EnvBand>>
  METRICS.forEach((m) => {
    bands[m.key] = gradeMetric(m.key, record[m.key] as number | null, point.ranges[m.key])
  })
  return mergeBands(bands)
}

function withView(tables: ReturnType<typeof envTables>, record: EnvRecord): RecordView {
  const point = pointById(tables, record.pointId)
  const bands = {} as Record<EnvMetricKey, EnvBand>
  METRICS.forEach((m) => {
    bands[m.key] = gradeMetric(m.key, record[m.key] as number | null, point?.ranges[m.key] ?? fallbackRange(m.key))
  })
  const openTask = tables.ventilationTasks.find(
    (t) => t.cabin === record.cabin && t.status !== '已解除' && record.conclusion === '超标',
  )
  return { ...record, bands, evaluated: mergeBands(bands), openTaskId: openTask?.id ?? null }
}

function fallbackRange(key: EnvMetricKey): MetricRange {
  return defaultRanges()[key]
}

// ── 查询 ────────────────────────────────────────────────────────────────────

export function listPoints(): EnvPoint[] {
  return envTables().envPoints.filter((p) => p.active)
}

export function listRecords(includeSuperseded = false): RecordView[] {
  const tables = envTables()
  return tables.envRecords
    .filter((r) => includeSuperseded || !r.superseded)
    .sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1))
    .map((r) => withView(tables, r))
}

export function getRecordView(id: number): RecordView | undefined {
  const tables = envTables()
  const record = tables.envRecords.find((r) => r.id === id)
  return record ? withView(tables, record) : undefined
}

export function listReviews(): EnvReviewItem[] {
  return envTables()
    .envReviews.slice()
    .sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1))
}

export function listVentilationTasks(): VentilationTask[] {
  return envTables()
    .ventilationTasks.slice()
    .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1))
}

/** 页面阈值说明：口径只来自 env-rules，这里只是组装展示。 */
export function thresholdSummary(point: EnvPoint) {
  return METRICS.map((m) => {
    const range = point.ranges[m.key]
    const boundary = bandBoundary(m.key, range)
    const def = METRIC_BY_KEY.get(m.key)!
    return {
      key: m.key,
      label: def.label,
      unit: def.unit,
      range,
      boundary,
      physicalMin: def.physicalMin,
      physicalMax: def.physicalMax,
      registerMin: RANGE_BOUNDS[m.key].standardMin,
      registerMax: RANGE_BOUNDS[m.key].standardMax,
    }
  })
}

// ── 点位标准登记 ────────────────────────────────────────────────────────────

export type PointInput = {
  code: string
  name: string
  cabin: string
  ranges: Record<EnvMetricKey, { min: string | number; max: string | number }>
}

export function registerPoint(input: PointInput): ServiceResult<{ pointId: number }> {
  const code = input.code.trim()
  const name = input.name.trim()
  const cabin = input.cabin.trim()
  if (!code || !name || !cabin) {
    return { ok: false, message: '点位编号、点位名称、所属舱室均为必填，整笔退回' }
  }
  const ranges = {} as Record<EnvMetricKey, MetricRange>
  for (const m of METRICS) {
    const raw = input.ranges[m.key]
    const checked = checkStandardRange(m.key, raw?.min, raw?.max)
    if (!checked.ok) {
      return { ok: false, message: checked.message + '，点位登记整笔退回' }
    }
    ranges[m.key] = checked.range
  }
  try {
    const pointId = commitEnv((draft) => {
      if (draft.envPoints.some((p) => p.code === code && p.active)) {
        throw new Error(`点位编号 ${code} 已存在，不允许重复登记`)
      }
      const id = nextId(draft.envPoints)
      draft.envPoints.push({
        id,
        code,
        name,
        cabin,
        ranges,
        active: true,
        createdAt: now(),
      })
      reconcile(draft)
      return id
    })
    return { ok: true, data: { pointId } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '点位登记失败，整笔退回' }
  }
}

// ── 现场报送（实测路径）：四项必填、校验全过才入账，同点同刻只认最后一版 ────

export type LiveInput = {
  pointId: number
  collectedAt: string
  values: Record<EnvMetricKey, string | number>
}

export function submitLive(input: LiveInput): ServiceResult<{ recordId: number }> {
  const tables = envTables()
  const point = pointById(tables, input.pointId)
  if (!point) {
    return { ok: false, message: '监测点位未登记标准范围，不能报送，请先登记点位' }
  }
  const collectedAt = input.collectedAt.trim()
  if (!collectedAt) {
    return { ok: false, message: '采集时间为必填，整笔退回' }
  }
  // 先在存储外校验全部取值：任一不过整笔退回，绝不半条落库。
  const parsed = {} as Record<EnvMetricKey, number>
  for (const m of METRICS) {
    const checked = checkMetricValue(m.key, input.values[m.key], false)
    if (!checked.ok) {
      return { ok: false, message: checked.message + '，现场报送整笔退回' }
    }
    parsed[m.key] = checked.value
  }
  try {
    const recordId = commitEnv((draft) => {
      // 同一点位同一采集时间重复报送：旧有效版置为「被替代」，只认本次最后一版。
      const previous = draft.envRecords.find(
        (r) => r.pointId === point.id && r.collectedAt === collectedAt && !r.superseded,
      )
      if (previous) {
        previous.superseded = true
        previous.note = `${previous.note ? previous.note + '；' : ''}同点同刻收到${inputSourceLabel(previous.source)}之后的新版报送，本版作废只留痕`
      }
      const id = nextId(draft.envRecords)
      const code = `ENVM-${String(id).padStart(4, '0')}`
      const record: EnvRecord = {
        id,
        code,
        pointId: point.id,
        pointName: point.name,
        cabin: point.cabin,
        temperature: parsed.temperature,
        humidity: parsed.humidity,
        oxygen: parsed.oxygen,
        gas: parsed.gas,
        collectedAt,
        receivedAt: now(),
        source: '现场实测',
        missing: [],
        suspectFalseNormal: false,
        superseded: false,
        bands: {},
        conclusion: '未采集',
        abnormal: false,
        note: previous
          ? `替代同点同刻的 ${previous.code}（两处取值打架，以现场实测这份为准，其余按它重算）`
          : '',
      }
      draft.envRecords.push(record)
      reconcile(draft)
      return id
    })
    return { ok: true, data: { recordId } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '现场报送失败，整笔退回' }
  }
}

// ── 历史回填：按下发日期一次性补齐；残缺字段留空并标出；伪正常由本函数裁决 ──

export type BackfillEntry = {
  pointCode: string
  collectedAt: string
  oldStatus: string
  values: Partial<Record<EnvMetricKey, string | number | null>>
}

export type BackfillReport = {
  inserted: number
  skipped: number
  falseNormal: number
  missingMarked: number
  details: string[]
}

export function backfillRecords(entries: BackfillEntry[], issueDate: string): ServiceResult<BackfillReport> {
  if (!issueDate.trim()) {
    return { ok: false, message: '下发日期必填，历史回填按下发日期一次性补齐' }
  }
  if (!entries.length) {
    return { ok: false, message: '没有可回填的记录' }
  }
  try {
    const report = commitEnv((draft) => {
      const result: BackfillReport = { inserted: 0, skipped: 0, falseNormal: 0, missingMarked: 0, details: [] }
      for (const entry of entries) {
        const point = draft.envPoints.find((p) => p.code === entry.pointCode.trim() && p.active)
        if (!point) {
          result.skipped += 1
          result.details.push(`${entry.pointCode} @${entry.collectedAt}：点位未登记，跳过`)
          continue
        }
        const collectedAt = entry.collectedAt.trim()
        // 一次性补齐：同点同刻已有现场实测的，回填不得覆盖（实测优先）；已有回填则跳过。
        const existed = draft.envRecords.find(
          (r) => r.pointId === point.id && r.collectedAt === collectedAt && !r.superseded,
        )
        if (existed) {
          result.skipped += 1
          result.details.push(
            `${point.code} @${collectedAt}：已存在${existed.source === '现场实测' ? '现场实测（实测优先）' : '回填'}记录，跳过`,
          )
          continue
        }
        const stored = {} as Record<EnvMetricKey, number | null>
        const missing: EnvMetricKey[] = []
        for (const m of METRICS) {
          const raw = entry.values[m.key]
          // 回填允许残缺：空值留空；非数值/越量程等不允许保存的取值也不留垃圾，按残缺留空并标出。
          const checked = checkMetricValue(m.key, raw, true)
          if (!checked.ok) {
            missing.push(m.key)
            stored[m.key] = null
            result.details.push(`${point.code} @${collectedAt}：${m.label}「${String(raw)}」${checked.message.replace(m.label, '')}，按残缺留空`)
            continue
          }
          if (Number.isNaN(checked.value)) {
            missing.push(m.key)
            stored[m.key] = null
          } else {
            stored[m.key] = checked.value
          }
        }
        // 裁决：旧状态写了「正常/指标正常」，但四项里有任何一项未采集（空或被清空），
        // 即认定为「早年把未采集写成正常」；四项全在且都正常才算真正常。
        const oldSaysNormal = /正常/.test(entry.oldStatus)
        const suspectFalseNormal = oldSaysNormal && missing.length > 0
        if (suspectFalseNormal) {
          result.falseNormal += 1
        }
        if (missing.length > 0) {
          result.missingMarked += 1
        }
        const id = nextId(draft.envRecords)
        const record: EnvRecord = {
          id,
          code: `ENVM-${String(id).padStart(4, '0')}`,
          pointId: point.id,
          pointName: point.name,
          cabin: point.cabin,
          temperature: stored.temperature,
          humidity: stored.humidity,
          oxygen: stored.oxygen,
          gas: stored.gas,
          collectedAt,
          receivedAt: `${issueDate.trim()} 09:00`,
          source: '历史回填',
          missing,
          suspectFalseNormal,
          superseded: false,
          bands: {},
          conclusion: '未采集',
          abnormal: false,
          note: suspectFalseNormal
            ? `旧系统状态为「${entry.oldStatus}」但 ${missing.join('/')} 未采集，裁决为伪正常并按实测值重判`
            : missing.length
              ? `残缺字段：${missing.join('/')}，按下发日期 ${issueDate} 回填时留空`
              : `按下发日期 ${issueDate} 一次性回填`,
        }
        draft.envRecords.push(record)
        result.inserted += 1
      }
      reconcile(draft)
      return result
    })
    return { ok: true, data: report }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '历史回填失败，整笔退回' }
  }
}

// ── 复核清单处置 ────────────────────────────────────────────────────────────

export function resolveReview(id: number): ServiceResult {
  try {
    commitEnv((draft) => {
      const item = draft.envReviews.find((r) => r.id === id)
      if (!item) {
        throw new Error('复核清单里没有这一条')
      }
      item.handled = true
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '复核失败' }
  }
}

// ── 通风任务动作 ────────────────────────────────────────────────────────────

export function startTask(id: number): ServiceResult {
  try {
    commitEnv((draft) => {
      const task = draft.ventilationTasks.find((t) => t.id === id)
      if (!task) {
        throw new Error('没有这条待开机任务')
      }
      if (task.status !== '待开机') {
        throw new Error(`任务已「${task.status}」，不能重复开机`)
      }
      task.status = '运行中'
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '开机失败' }
  }
}

export function dismissTask(id: number): ServiceResult {
  try {
    commitEnv((draft) => {
      const task = draft.ventilationTasks.find((t) => t.id === id)
      if (!task) {
        throw new Error('没有这条通风任务')
      }
      if (task.status === '运行中') {
        throw new Error('机组运行中，请先登记停机再解除')
      }
      task.status = '已解除'
      reconcile(draft)
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '解除失败' }
  }
}

export function resetEnvDomain(): void {
  resetEnv()
}

// ── 内部：每次写库后按同一份规则重算结论、复核清单与通风任务 ────────────────

function reconcile(draft: ReturnType<typeof envTables>): void {
  // 1) 全部有效记录按「当前点位标准」重算结论（标准改了、实测覆盖了，都按它重算）
  for (const record of draft.envRecords) {
    const point = pointById(draft, record.pointId)
    const bands = {} as Partial<Record<EnvMetricKey, EnvBand>>
    METRICS.forEach((m) => {
      bands[m.key] = gradeMetric(m.key, record[m.key] as number | null, point?.ranges[m.key] ?? fallbackRange(m.key))
    })
    record.bands = bands
    record.conclusion = mergeBands(bands)
    record.abnormal = record.conclusion === '超标' || record.suspectFalseNormal
  }

  // 2) 复核清单：预警/超标/残缺/伪正常的有效记录都写回一条；被替代记录的条目移除
  const effective = draft.envRecords.filter((r) => !r.superseded)
  const liveIds = new Set(effective.map((r) => r.id))
  draft.envReviews = draft.envReviews.filter((item) => liveIds.has(item.recordId))
  for (const record of effective) {
    const needsReview =
      record.conclusion !== '正常' || record.suspectFalseNormal || record.missing.length > 0
    const existing = draft.envReviews.find((item) => item.recordId === record.id)
    if (!needsReview) {
      if (existing) {
        draft.envReviews.splice(draft.envReviews.indexOf(existing), 1)
      }
      continue
    }
    const reason = buildReason(record)
    if (existing) {
      existing.conclusion = record.conclusion
      existing.bands = record.bands
      existing.reason = reason
      existing.source = record.source
    } else {
      draft.envReviews.push({
        id: nextId(draft.envReviews),
        recordId: record.id,
        recordCode: record.code,
        pointName: record.pointName,
        cabin: record.cabin,
        collectedAt: record.collectedAt,
        conclusion: record.conclusion,
        bands: record.bands,
        reason,
        source: record.source,
        ventilationTaskId: null,
        handled: false,
        createdAt: now(),
      })
    }
  }

  // 3) 通风联动：只认「超标」，按舱室排出；同舱室一条；不超标了待开机任务自动解除
  const overCabins = new Map<string, EnvRecord>()
  for (const record of effective) {
    if (record.conclusion !== '超标') {
      continue
    }
    const prior = overCabins.get(record.cabin)
    if (!prior || record.collectedAt > prior.collectedAt) {
      overCabins.set(record.cabin, record)
    }
  }
  for (const task of draft.ventilationTasks) {
    if (task.status === '待开机' && !overCabins.has(task.cabin)) {
      task.status = '已解除'
    }
  }
  for (const [cabin, record] of overCabins) {
    const open = draft.ventilationTasks.find((t) => t.cabin === cabin && t.status !== '已解除')
    if (open) {
      if (open.status === '待开机') {
        open.triggerRecordId = record.id
        open.triggerRecordCode = record.code
        open.triggerPointName = record.pointName
        open.triggerBands = record.bands
      }
      continue
    }
    const taskId = nextId(draft.ventilationTasks)
    draft.ventilationTasks.push({
      id: taskId,
      taskCode: `VTASK-${String(taskId).padStart(4, '0')}`,
      cabin,
      triggerRecordId: record.id,
      triggerRecordCode: record.code,
      triggerPointName: record.pointName,
      triggerBands: record.bands,
      issuedAt: now(),
      source: record.source,
      status: '待开机',
    })
  }

  // 4) 复核条目与在挂通风任务互链（两个入口看到的是同一条任务）
  for (const item of draft.envReviews) {
    const record = draft.envRecords.find((r) => r.id === item.recordId)
    if (!record || record.conclusion !== '超标') {
      item.ventilationTaskId = null
      continue
    }
    const task = draft.ventilationTasks.find((t) => t.cabin === item.cabin && t.status !== '已解除')
    item.ventilationTaskId = task?.id ?? null
  }
}

function buildReason(record: EnvRecord): string {
  const parts: string[] = []
  const over = METRICS.filter((m) => record.bands[m.key] === '超标').map((m) => m.label)
  const warn = METRICS.filter((m) => record.bands[m.key] === '预警').map((m) => m.label)
  if (record.suspectFalseNormal) {
    parts.push(`历史伪正常：未采集项被旧系统写成正常，已改判为「${record.conclusion}」`)
  }
  if (over.length) {
    parts.push(`超标指标：${over.join('、')}`)
  }
  if (warn.length) {
    parts.push(`预警指标：${warn.join('、')}`)
  }
  if (record.missing.length) {
    const labels = record.missing.map((k) => METRIC_BY_KEY.get(k)!.label)
    parts.push(`未采集：${labels.join('、')}（残缺字段留空）`)
  }
  return parts.join('；')
}

function inputSourceLabel(source: EnvRecord['source']): string {
  return source
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
