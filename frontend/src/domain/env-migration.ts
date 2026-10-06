import { allRows } from '@/data/local-store'
import { backfillHistory, BACKFILL_BATCH, ENV_KEY } from '@/domain/env-service'

/**
 * 一次性存量回填迁移：应用启动时检查环境监测记录，若存在未经本批口径
 * 处理的存量记录，则按下发日期一次性补齐（整笔事务，失败保持旧数据）。
 * 键里带批次标记，保证只执行一次；重置数据后可再次触发。
 */
let ran = false

export function runEnvMigrationOnce(): { ok: boolean; message: string } {
  if (ran) {
    return { ok: true, message: '回填迁移已执行过' }
  }
  ran = true
  const rows = allRows()[ENV_KEY] ?? []
  if (rows.length === 0 || rows.every((row) => row.回填批次 === BACKFILL_BATCH)) {
    return { ok: true, message: '无待回填存量记录' }
  }
  return backfillHistory()
}
