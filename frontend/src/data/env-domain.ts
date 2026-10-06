import { METRICS, bandBoundary } from './env-rules'
import { SEED_ENV } from './seed-env'
import type {
  EnvMetricKey,
  EnvPoint,
  EnvRecord,
  EnvReviewItem,
  MetricRange,
  VentilationTask,
} from './types'

/**
 * 环境监测域存储：点位标准 / 监测记录 / 复核清单 / 通风待开机任务。
 * 四张表与通用模块数据共用同一个 localStorage 键，但只有本文件能直接写。
 *
 * 原子性：所有跨表写操作走 commitEnv()——先在内存快照上改完并校验，
 * 成功才一次性落盘；任一步抛错则整笔退回，调用前后两次读到的必须是同一份数据。
 */

const STORAGE_KEY = 'urban-utility-tunnel:entries'
const ENV_VERSION_KEY = 'urban-utility-tunnel:env-version'
const ENV_VERSION = 2

export type EnvTables = {
  envPoints: EnvPoint[]
  envRecords: EnvRecord[]
  envReviews: EnvReviewItem[]
  ventilationTasks: VentilationTask[]
}

type StoreShape = Record<string, unknown> & Partial<EnvTables>

const EMPTY_TABLES: EnvTables = { envPoints: [], envRecords: [], envReviews: [], ventilationTasks: [] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: StoreShape | null = null

function readRaw(): StoreShape {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = clone({ ...SEED_ENV }) as StoreShape
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let parsed: StoreShape = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) as StoreShape
    } catch {
      parsed = {}
    }
  }
  // 环境域版本迁移：旧库存（v1，通用模块页时代）没有这四张表，按下发日期一次性补齐播种。
  const version = Number(window.localStorage.getItem(ENV_VERSION_KEY) ?? '0')
  const needSeed =
    version < ENV_VERSION ||
    !Array.isArray(parsed.envPoints) ||
    !Array.isArray(parsed.envRecords) ||
    !Array.isArray(parsed.envReviews) ||
    !Array.isArray(parsed.ventilationTasks)
  if (needSeed) {
    parsed = { ...parsed, ...clone(SEED_ENV) }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    window.localStorage.setItem(ENV_VERSION_KEY, String(ENV_VERSION))
  }
  cache = parsed
  return cache
}

function persist(next: StoreShape): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function envTables(): EnvTables {
  const raw = readRaw()
  return {
    envPoints: (raw.envPoints as EnvPoint[]) ?? [],
    envRecords: (raw.envRecords as EnvRecord[]) ?? [],
    envReviews: (raw.envReviews as EnvReviewItem[]) ?? [],
    ventilationTasks: (raw.ventilationTasks as VentilationTask[]) ?? [],
  }
}

/**
 * 原子提交：mutator 在快照副本上操作并返回结果；抛错则不落盘（整笔退回）。
 * 返回值同时来自被提交的那份快照，保证「提交后读到的 = 校验时那份」。
 */
export function commitEnv<T>(mutator: (draft: EnvTables) => T): T {
  const current = readRaw()
  const draft: EnvTables = {
    envPoints: clone(current.envPoints as EnvPoint[] | undefined) ?? [],
    envRecords: clone(current.envRecords as EnvRecord[] | undefined) ?? [],
    envReviews: clone(current.envReviews as EnvReviewItem[] | undefined) ?? [],
    ventilationTasks: clone(current.ventilationTasks as VentilationTask[] | undefined) ?? [],
  }
  const result = mutator(draft) // 任一步抛错都在落盘前冒泡 → 旧数据原样保留
  persist({ ...current, ...draft })
  return result
}

export function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

export function resetEnv(): EnvTables {
  const fresh = clone(SEED_ENV)
  persist({ ...readRaw(), ...fresh })
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ENV_VERSION_KEY, String(ENV_VERSION))
  }
  return fresh
}

// ── 点位标准取值：记录判定只从这里取标准范围 ────────────────────────────────

export function pointById(tables: EnvTables, pointId: number): EnvPoint | undefined {
  return tables.envPoints.find((p) => p.id === pointId && p.active)
}

export function defaultRanges(): Record<EnvMetricKey, MetricRange> {
  // 默认标准范围与阈值表解耦：默认值取常用廊内环境区间，分档规则仍只在 env-rules。
  return {
    temperature: { standardMin: 5, standardMax: 28 },
    humidity: { standardMin: 40, standardMax: 85 },
    oxygen: { standardMin: 19.5, standardMax: 23 },
    gas: { standardMin: 0, standardMax: 25 },
  }
}

/** 给页面阈值说明用：返回每个指标在某点位下的完整边界。 */
export function pointBoundaries(point: EnvPoint) {
  return METRICS.map((m) => ({ metric: m, boundary: bandBoundary(m.key, point.ranges[m.key]) }))
}
