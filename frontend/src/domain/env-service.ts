import { commitSnapshot, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  ENV_METRICS,
  METRIC_SPECS,
  RULE_VERSION,
  SOURCE_PRIORITY,
  validateStandard,
  evaluateRecord,
  higherPriority,
  parseMetricValue,
  requiresVentilation,
  VERDICT_STATUS,
  type EnvDataSource,
  type EnvMetric,
  type PointStandard,
  type RecordEvaluation,
} from './env-rules'

/**
 * 环境监测入库管道。两条路径共用这一条：
 *   A. 现场实测报送（source=现场实测，优先级最高）
 *   B. 复核补录报送（source=复核补录）
 * 先后与冲突兜底：
 *   1. 唯一键 = 监测点位 + 采集时间；同键重复报送只认最后一版（last-write-wins）；
 *   2. 两版来源不同、取值打架时，以现场实测那份为准，其余入口的取值按它重算；
 *   3. 登记标准 → 解析校验（禁存值整笔拒）→ 覆盖/新增 → 统一判定 →
 *      通风待开机任务对账 → 复核清单回写，六步在同一整笔事务内，
 *      任一步失败快照不换，等同整笔退回。
 */

export const ENV_KEY = 'envmonitor'
export const VENT_KEY = 'ventilation'
export const STANDARD_KEY = 'envstandards'
export const REVIEW_KEY = 'envreview'

export const BACKFILL_BATCH = '2026-10-06 历史回填'

// 环境记录在通用 EntryRow 上使用的字段（结论一律推导，不单独存档位）。
export const ENV_FIELDS = [
  '监测编号',
  '监测点位',
  '所属舱室',
  '环境温度',
  '空气湿度',
  '氧气浓度',
  '有害气体浓度',
  '采集时间',
  '报送时间',
  '数据来源',
  '口径版本',
  '残缺字段',
  '回填批次',
] as const

function envStandards(snapshot?: Record<string, EntryRow[]>): PointStandard[] {
  const rows = (snapshot ? snapshot[STANDARD_KEY] : listRows(STANDARD_KEY)) ?? []
  return rows.map((row) => ({
    监测点位: String(row.监测点位 ?? ''),
    所属舱室: String(row.所属舱室 ?? ''),
    effectiveDate: String(row.effectiveDate ?? ''),
    ranges: Object.fromEntries(
      ENV_METRICS.map((metric) => [
        metric,
        { min: Number(row[`${metric}下限`]), max: Number(row[`${metric}上限`]) },
      ]),
    ),
  })) as PointStandard[]
}

export function listStandards(): PointStandard[] {
  return envStandards()
}

function standardFor(point: string, standards: PointStandard[]): PointStandard | null {
  return standards.find((item) => item.监测点位 === point) ?? null
}

/** 从一条记录（可能是历史脏数据）取四个指标的原始单元格。 */
export function rawValues(row: EntryRow): Partial<Record<EnvMetric, unknown>> {
  return Object.fromEntries(ENV_METRICS.map((metric) => [metric, row[metric]]))
}

/** 统一判定入口：任何页面、复核清单、通风联动都只能从这里拿结论。 */
export function evaluateRow(row: EntryRow, standard?: PointStandard | null): RecordEvaluation {
  const std =
    standard ??
    ({
      监测点位: String(row.监测点位 ?? ''),
      所属舱室: String(row.所属舱室 ?? ''),
      effectiveDate: '',
      ranges: Object.fromEntries(
        ENV_METRICS.map((metric) => [metric, { min: METRIC_SPECS[metric].defaultMin, max: METRIC_SPECS[metric].defaultMax }]),
      ),
    } as PointStandard)
  return evaluateRecord(rawValues(row), std)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function recordNo(rows: EntryRow[]): string {
  return `ENVM-${String(nextId(rows) + 1000).padStart(4, '0')}`
}

function ventTaskNo(rows: EntryRow[]): string {
  return `VENT-LINK-${String(nextId(rows) + 2000).padStart(4, '0')}`
}

export type SubmittedReading = {
  监测点位: string
  所属舱室?: string
  采集时间: string
  报送时间?: string
  source: EnvDataSource
  values: Partial<Record<EnvMetric, unknown>>
}

/** 报送前先按禁存清单校验：有不允许保存的取值，整笔拒收（不写任何东西）。 */
export function validateReading(
  payload: SubmittedReading,
): { ok: true } | { ok: false; message: string } {
  if (!payload.监测点位.trim()) {
    return { ok: false, message: '监测点位不允许为空' }
  }
  if (!payload.采集时间.trim()) {
    return { ok: false, message: '采集时间不允许为空（重复报送按它去重）' }
  }
  for (const metric of ENV_METRICS) {
    const raw = payload.values[metric]
    // 允许整项缺失（残缺留空），但给了值就必须能过禁存清单。
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      continue
    }
    const parsed = parseMetricValue(raw, metric)
    if (!parsed.ok) {
      return { ok: false, message: `${metric}：${parsed.reason}` }
    }
  }
  return { ok: true }
}

function toStoredRow(
  base: Partial<EntryRow>,
  payload: SubmittedReading,
  evaluation: RecordEvaluation,
  cabin: string,
  isBackfill: boolean,
): EntryRow {
  const row: EntryRow = {
    id: Number(base.id ?? 0),
    status: VERDICT_STATUS[evaluation.verdict],
    pending: evaluation.verdict !== '指标正常',
    abnormal: evaluation.verdict === '一级预警' || evaluation.verdict === '二级超标',
    监测编号: String(base.监测编号 ?? ''),
    监测点位: payload.监测点位,
    所属舱室: cabin,
    采集时间: payload.采集时间,
    报送时间: payload.报送时间 ?? payload.采集时间,
    数据来源: payload.source,
    口径版本: RULE_VERSION,
    残缺字段: evaluation.missing.join('、'),
    回填批次: isBackfill ? BACKFILL_BATCH : String(base.回填批次 ?? ''),
  }
  for (const metric of ENV_METRICS) {
    const result = evaluation.results.find((item) => item.metric === metric)
    row[metric] = result && result.value !== null ? result.value : ''
  }
  return row
}

/**
 * 同点位 + 同采集时间的重复报送仲裁：
 *  - 同来源：只认最后一版，新值整体覆盖；
 *  - 不同来源：以现场实测那份为准。现场实测晚到/补到，覆盖另一入口同键值并
 *    按实测重算；低优先级来源想覆盖高优先级旧版时，被拒绝（冲突兜底）。
 */
function resolveConflict(
  existing: EntryRow,
  incoming: SubmittedReading,
): { ok: true; winner: 'existing' | 'incoming' } | { ok: false; message: string } {
  const existingSource = String(existing.数据来源 ?? '历史回填') as EnvDataSource
  if (existingSource === incoming.source) {
    return { ok: true, winner: 'incoming' } // last-write-wins
  }
  const winnerSource = higherPriority(existingSource, incoming.source)
  if (winnerSource === existingSource) {
    return {
      ok: false,
      message: `监测点位「${incoming.监测点位}」在 ${incoming.采集时间} 已有${existingSource}版本，按冲突兜底以现场实测优先的口径，${incoming.source}不得覆盖`,
    }
  }
  return { ok: true, winner: 'incoming' }
}

/** 单条/多条报送共用的整笔事务。 */
function collapseDuplicateKeys(draft: Record<string, EntryRow[]>): void {
  const rows = draft[ENV_KEY] ?? []
  const kept = new Map<string, EntryRow>()
  for (const row of rows) {
    const key = `${String(row.监测点位)}@@${String(row.采集时间)}`
    kept.set(key, row) // 后者覆盖前者 → 只认最后一版
  }
  draft[ENV_KEY] = [...kept.values()]
}

export function ingestReadings(payloads: SubmittedReading[], isBackfill = false): {
  ok: boolean
  message: string
} {
  try {
    commitSnapshot((draft) => {
      // 存量数据里同点位同采集时间的重复行先折叠成一份（保留最后一版），
      // 折叠与后续判定在同一事务内。
      if (isBackfill) {
        collapseDuplicateKeys(draft)
      }
      const standards = envStandards(draft)
      const envRows = (draft[ENV_KEY] ??= [])
      const ventRows = (draft[VENT_KEY] ??= [])
      const reviewRows = (draft[REVIEW_KEY] ??= [])

      for (const payload of payloads) {
        const check = validateReading(payload)
        if (!check.ok) {
          throw new Error(check.message)
        }
        const std = standardFor(payload.监测点位, standards)
        if (!std) {
          throw new Error(`监测点位「${payload.监测点位}」尚未登记标准范围，禁止采集入库`)
        }
        const cabin = payload.所属舱室?.trim() || std.所属舱室

        const dupIndex = envRows.findIndex(
          (row) =>
            String(row.监测点位) === payload.监测点位 &&
            String(row.采集时间) === payload.采集时间,
        )
        const existing = dupIndex >= 0 ? envRows[dupIndex] : null
        if (existing && !isBackfill) {
          // 冲突兜底只约束实时报送；回填是对存量自身的一次性重判。
          const conflict = resolveConflict(existing, payload)
          if (!conflict.ok) {
            throw new Error(conflict.message)
          }
        }

        const evaluation = evaluateRecord(payload.values, std)
        const base = existing ? { ...existing } : { id: nextId(envRows), 监测编号: recordNo(envRows) }
        const stored = toStoredRow(base, payload, evaluation, cabin, isBackfill)

        if (existing) {
          envRows[dupIndex] = stored
        } else {
          envRows.push(stored)
        }
        reconcileVentilation(draft, stored, evaluation, cabin)
        writeReview(draft, stored, evaluation)
      }
    })
    return { ok: true, message: `已整笔提交 ${payloads.length} 条报送，结论、通风任务与复核清单同事务落库` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '入库失败，已整笔退回',
    }
  }
}

/**
 * 通风联动：按「超标舱室」排出且只排一条待开机任务。
 *  - 二级超标：该舱室没有待开机联动任务则新增（去重键=所属舱室+联动来源）；
 *    已有则刷新来源记录与最高档位，不重复排；
 *  - 非二级超标：若该点位正是该舱室待开机任务的唯一来源，任务撤回（关闭），
 *    避免超标消失后任务悬空。一个舱室始终至多一条活动待开机联动任务。
 */
function reconcileVentilation(
  draft: Record<string, EntryRow[]>,
  stored: EntryRow,
  evaluation: RecordEvaluation,
  cabin: string,
): void {
  const ventRows = (draft[VENT_KEY] ??= [])
  const active = ventRows.find(
    (row) =>
      row.联动来源 === '环境监测' &&
      String(row.所属舱室) === cabin &&
      row.status === '待开机',
  )
  const linkedIds: number[] = active ? JSON.parse(String(active.关联记录 ?? '[]')) : []
  const selfId = Number(stored.id)

  if (requiresVentilation(evaluation)) {
    if (active) {
      if (!linkedIds.includes(selfId)) linkedIds.push(selfId)
      active.关联记录 = JSON.stringify(linkedIds)
      active.触发指标 = evaluation.worst ?? String(active.触发指标 ?? '')
      active.启停时间 = String(stored.采集时间)
      active.任务说明 = `舱室 ${cabin} 有 ${linkedIds.length} 条二级超标记录，待开机通风`
    } else {
      const id = nextId(ventRows)
      ventRows.push({
        id,
        status: '待开机',
        pending: true,
        abnormal: true,
        机组编号: ventTaskNo(ventRows),
        所属舱室: cabin,
        风机型号: '联动指定机组',
        运行模式: '事故通风',
        送风风速: '',
        启停时间: String(stored.采集时间),
        操作人员: '',
        风机状态: '待开机',
        联动来源: '环境监测',
        触发指标: evaluation.worst ?? '',
        关联记录: JSON.stringify([selfId]),
        任务说明: `舱室 ${cabin} 出现二级超标（${stored.监测点位} ${evaluation.worst ?? ''}），待开机通风`,
      })
    }
    return
  }

  if (active && linkedIds.includes(selfId)) {
    const rest = linkedIds.filter((rid) => rid !== selfId)
    if (rest.length === 0) {
      // 唯一来源恢复正常：撤回待开机任务（保留痕迹，状态置已停机）。
      active.status = '已停机'
      active.pending = false
      active.abnormal = false
      active.风机状态 = '已停机'
      active.任务说明 = `舱室 ${cabin} 超标记录已消除，联动任务撤回`
    } else {
      active.关联记录 = JSON.stringify(rest)
      active.任务说明 = `舱室 ${cabin} 还有 ${rest.length} 条二级超标记录，待开机通风`
    }
  }
}

/**
 * 复核清单回写：每条环境记录对应一行复核项，写回的是「记录 id + 口径版本」，
 * 展示时按同一套规则实时推导结论——监测详情、列表、复核三处同源，结论必然一致。
 */
function writeReview(
  draft: Record<string, EntryRow[]>,
  stored: EntryRow,
  evaluation: RecordEvaluation,
): void {
  const reviewRows = (draft[REVIEW_KEY] ??= [])
  const index = reviewRows.findIndex((row) => Number(row.环境记录) === Number(stored.id))
  const payload: EntryRow = {
    id: index >= 0 ? reviewRows[index].id : nextId(reviewRows),
    status: evaluation.verdict,
    pending: evaluation.verdict !== '指标正常',
    abnormal: stored.abnormal,
    复核编号:
      index >= 0 ? reviewRows[index].复核编号 : `REVW-${String(nextId(reviewRows) + 3000).padStart(4, '0')}`,
    监测点位: String(stored.监测点位),
    所属舱室: String(stored.所属舱室),
    采集时间: String(stored.采集时间),
    环境记录: Number(stored.id),
    口径版本: RULE_VERSION,
    数据来源: String(stored.数据来源),
    残缺字段: evaluation.missing.join('、'),
    复核结论: evaluation.verdict,
    结论摘要: evaluation.summary,
    同步时间: String(stored.报送时间),
  }
  if (index >= 0) {
    reviewRows[index] = payload
  } else {
    reviewRows.push(payload)
  }
}

// ---------------------------------------------------------------------------
// 点位标准登记（一份点位一份范围）
// ---------------------------------------------------------------------------

export function saveStandard(std: PointStandard): { ok: boolean; message: string } {
  const issue = validateStandard(std)
  if (!issue.ok) {
    return { ok: false, message: issue.message }
  }
  try {
    commitSnapshot((draft) => {
      const rows = (draft[STANDARD_KEY] ??= [])
      const index = rows.findIndex((row) => String(row.监测点位) === std.监测点位)
      const row: EntryRow = {
        id: index >= 0 ? rows[index].id : nextId(rows),
        status: '生效中',
        pending: false,
        abnormal: false,
        监测点位: std.监测点位,
        所属舱室: std.所属舱室,
        effectiveDate: std.effectiveDate,
      }
      for (const metric of ENV_METRICS) {
        row[`${metric}下限`] = std.ranges[metric].min
        row[`${metric}上限`] = std.ranges[metric].max
      }
      if (index >= 0) {
        rows[index] = row
      } else {
        rows.push(row)
      }
    })
    return { ok: true, message: `点位「${std.监测点位}」标准范围已生效` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '标准登记失败' }
  }
}

// ---------------------------------------------------------------------------
// 存量历史记录一次性回填（按下发日期，按采集时间升序补齐）
// ---------------------------------------------------------------------------

/**
 * 早年把「未采集」写成「正常」的识别裁决（唯一识别口径）：
 *  不看旧状态文字（旧状态不可信），只看四个指标单元格——
 *  - 四项全部缺失/越界/非数值 → 待采集（这就是“未采集写成正常”的那几条）；
 *  - 部分缺失 → 指标缺失，残缺字段留空并标出；
 *  - 四项齐全合法 → 按登记标准重算正常/预警/超标。
 * 回填按采集时间升序逐条走与报送完全相同的管道（去重、冲突仲裁、联动、复核）。
 */
export function backfillHistory(): { ok: boolean; message: string } {
  const standards = envStandards()
  const sourceRows = [...listRows(ENV_KEY)]
  const pending = sourceRows
    .filter((row) => row.回填批次 !== BACKFILL_BATCH)
    .sort((a, b) => String(a.采集时间).localeCompare(String(b.采集时间)))

  if (pending.length === 0) {
    return { ok: true, message: '存量记录均已回填，无需补齐' }
  }

  const payloads: SubmittedReading[] = []
  for (const row of pending) {
    const std = standardFor(String(row.监测点位), standards)
    if (!std) {
      return { ok: false, message: `点位「${String(row.监测点位)}」没有登记标准，回填已整笔退回` }
    }
    // 存量清洗：不合法单元格（非数值/越量程/文本）不按禁存拒收，
    // 而是剥离为缺失——残缺字段留空，由 evaluateRecord 统一标出。
    const values: Partial<Record<EnvMetric, unknown>> = {}
    for (const metric of ENV_METRICS) {
      const parsed = parseMetricValue(row[metric], metric)
      if (parsed.ok) {
        values[metric] = parsed.value
      }
    }
    // 存量记录若已有来源（如复核补录），回填时保留；没有才记历史回填。
    const legacySource = (String(row.数据来源 ?? '') || '历史回填') as EnvDataSource
    payloads.push({
      监测点位: String(row.监测点位),
      所属舱室: String(row.所属舱室 || std.所属舱室),
      采集时间: String(row.采集时间),
      报送时间: String(row.报送时间 ?? row.采集时间),
      source: legacySource,
      values,
    })
  }

  const result = ingestReadings(payloads, true)
  if (!result.ok) {
    return { ok: false, message: `历史回填整笔退回：${result.message}` }
  }
  return {
    ok: true,
    message: `按下发日期一次性补齐 ${payloads.length} 条存量记录（按采集时间升序），残缺字段留空并已标出`,
  }
}

/** 复核清单读出：结论实时按唯一口径重算，并与记录现值核对一致性。 */
export function listReviewItems(): EntryRow[] {
  const standards = envStandards()
  const envRows = listRows(ENV_KEY)
  const reviewRows = listRows(REVIEW_KEY)
  return reviewRows.map((review) => {
    const record = envRows.find((row) => Number(row.id) === Number(review.环境记录))
    if (!record) {
      return { ...review, 复核结论: '源记录缺失', 结论一致: '否' }
    }
    const evaluation = evaluateRow(record, standardFor(String(record.监测点位), standards))
    return {
      ...review,
      复核结论: evaluation.verdict,
      结论摘要: evaluation.summary,
      残缺字段: evaluation.missing.join('、'),
      结论一致: review.复核结论 === evaluation.verdict ? '是' : '已按现值重算',
    }
  })
}

export function linkedVentTasks(): EntryRow[] {
  return listRows(VENT_KEY).filter((row) => row.联动来源 === '环境监测')
}

export { SOURCE_PRIORITY }
