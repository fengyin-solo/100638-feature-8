import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

/**
 * 本地持久化（单一快照）：
 *  - 全部业务数据放在 localStorage 的同一个 key 下，环境监测的「登记标准 /
 *    采集入库 / 通风联动 / 复核回写」因此能合成一次整笔事务；
 *  - 读出来的快照整体 Object.freeze，页面拿到的永远是只读同一份，杜绝详情与
 *    列表各改各的；
 *  - 提交走「克隆 → 改 → 整串写回 → 回读比对 → 换缓存」，任一步失败保留旧
 *    快照，调用方抛错即视为整笔退回。
 */
const STORAGE_KEY = 'urban-utility-tunnel:entries:v2'

export type DataSnapshot = Record<string, EntryRow[]>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seed(): DataSnapshot {
  return clone(SEED_ROWS)
}

function writeRaw(raw: string): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, raw)
}

function readRaw(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage.getItem(STORAGE_KEY)
}

function readStorage(): DataSnapshot {
  const fallback = seed()
  const raw = readRaw()
  if (!raw) {
    const seeded = JSON.stringify(fallback)
    writeRaw(seeded)
    return deepFreeze(fallback)
  }
  try {
    const parsed = JSON.parse(raw) as DataSnapshot
    // 缺模块时以种子补齐（新增模块不会冲掉浏览器里已有的数据）。
    const merged = { ...seed(), ...parsed }
    return deepFreeze(merged)
  } catch {
    writeRaw(JSON.stringify(fallback))
    return deepFreeze(fallback)
  }
}

let cache: DataSnapshot | null = null

export function allRows(): DataSnapshot {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitSnapshot((draft) => {
    draft[key] = clone(rows)
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 整笔事务提交：updater 在可变草稿上一次性完成所有改动（可跨多个模块）。
 * updater 抛错、写回失败或回读不一致，都不换缓存——对外表现为整笔退回。
 * 返回提交后的只读快照；同一事务内先读草稿、提交后再读缓存，二者内容一致。
 */
export function commitSnapshot(updater: (draft: DataSnapshot) => void): DataSnapshot {
  const before = allRows()
  const draft = clone(before)
  updater(draft)
  const serialized = JSON.stringify(draft)

  // 落库没走完整套流程就整笔退回：写后立刻回读，必须逐字节一致。
  writeRaw(serialized)
  const verify = readRaw()
  if (typeof window !== 'undefined' && window.localStorage && verify !== serialized) {
    throw new Error('数据写回后回读不一致，本次提交已整笔退回')
  }

  const committed = deepFreeze(clone(draft))
  cache = committed
  return committed
}

export function storageKey(): string {
  return STORAGE_KEY
}
