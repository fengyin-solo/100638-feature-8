// 行为验证：用内存版 localStorage 跑完整条管道，断言用户提出的每条规则。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
  },
}

const root = new URL('../', import.meta.url).pathname
const harness = `
export * from ${JSON.stringify(root + 'src/domain/env-service.ts')}
export { listRows } from '@/data/local-store'
export { runEnvMigrationOnce } from ${JSON.stringify(root + 'src/domain/env-migration.ts')}
`
writeFileSync('/tmp/env-harness.ts', harness)

const result = await build({
  entryPoints: ['/tmp/env-harness.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  alias: { '@': root + 'src' },
})
writeFileSync('/tmp/env-harness.bundle.mjs', result.outputFiles[0].text)
const svc = await import('file:///tmp/env-harness.bundle.mjs')

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name} ${extra}`)
  }
}

const migResult = svc.runEnvMigrationOnce()
console.log('启动回填：', migResult.message)
assert('启动迁移整笔成功', migResult.ok, migResult.message)

let env = svc.listRows('envmonitor')
// 1) 重复报送折叠：id7/id8 同键 → 只剩 8 条
assert('同点位同采集时间重复报送只认最后一版（9 行折叠为 8 行）', env.length === 8, `实际 ${env.length}`)

const findR = (no) => env.find((r) => r.监测编号 === no)
// 2) “未采集写成正常”的第 1 条 → 待采集
const r1 = findR('ENVM-0001')
assert('早年四项全缺被写成正常 → 重判待采集', r1.status === '待采集', r1.status)
assert('全缺记录四项值留空', allEmpty(r1), JSON.stringify({ t: r1.环境温度 }))
assert('全缺记录标记残缺字段', r1.残缺字段.includes('氧气浓度') && r1.残缺字段.includes('有害气体浓度'))
assert('全缺记录回填批次', r1.回填批次 === svc.BACKFILL_BATCH)

// 3) 正常记录仍正常
const r2 = findR('ENVM-0002')
assert('四项在范围内 → 指标正常', svc.evaluateRow(r2).verdict === '指标正常', svc.evaluateRow(r2).verdict)

// 4) 温度 33 vs 上限40 → 正常
const r3 = findR('ENVM-0003')
assert('温度33℃ ≤ 40℃ 不超标', svc.evaluateRow(r3).verdict === '指标正常', svc.evaluateRow(r3).verdict)

// 5) 有害气体 28ppm，标准上限10，带宽10 → 超出18 > 10 → 二级超标
const r4 = findR('ENVM-0004')
const e4 = svc.evaluateRow(r4)
assert('有害气体28ppm 超出18>带宽10 → 二级超标', e4.verdict === '二级超标', e4.summary)

// 6) 缺两项 → 指标缺失
const r5 = findR('ENVM-0005')
const e5 = svc.evaluateRow(r5)
assert('部分指标残缺 → 指标缺失，不判正常', e5.verdict === '指标缺失' && e5.missing.length === 2)

// 7) 温度38 vs 上限38 闭区间边界 → 正常；湿度88 在[30,85]外，超出3≤5 → 一级预警
const r6 = findR('ENVM-0006')
const e6 = svc.evaluateRow(r6, svc.listStandards().find((s) => s.监测点位 === '电力舱-03段'))
assert('取等边界属正常 + 湿度越界3≤5 → 一级预警', e6.verdict === '一级预警', e6.summary)

// 8) 重复行保留最后一版（id8：温度42 二级超标）
const dup = env.find((r) => r.采集时间 === '2026-09-10 09:00')
assert('重复报送保留最后一版（42℃ 那份）', dup.环境温度 === 42, JSON.stringify(dup.环境温度))
assert('最后一版温度42>38+带宽5 → 二级超标', svc.evaluateRow(dup).verdict === '二级超标', svc.evaluateRow(dup).summary)

// 9) 量程外 999 → 该指标缺失并标出，整条指标缺失
const r9 = findR('ENVM-0009')
const e9 = svc.evaluateRow(r9)
assert('越过量程上限的值不参与判定，留空标缺失', r9.环境温度 === '' && e9.verdict === '指标缺失', e9.summary)

// 10) 通风联动：二级超标舱室各一条待开机任务
let vent = listVent('待开机')
const cabins = vent.map((r) => r.所属舱室).sort()
assert('二级超标按舱室排出待开机任务（燃气舱二段、电力舱三段）', cabins.join('|') === '燃气舱二段|电力舱三段', cabins.join('|'))
assert('一个舱室至多一条活动联动任务', new Set(cabins).size === cabins.length)

// 11) 复核清单与现值一致
const reviews = svc.listReviewItems()
assert('复核清单随回填回写（8 条）', reviews.length === 8, `实际 ${reviews.length}`)
assert('每一行复核结论与现值重算一致', reviews.every((r) => r.结论一致 === '是'), reviews.find((r) => r.结论一致 !== '是')?.复核编号)

// 12) 同键再送一份现场实测 → 覆盖复核补录
let res = svc.ingestReadings([
  {
    监测点位: '电力舱-03段',
    采集时间: '2026-09-10 09:00',
    source: '现场实测',
    values: { 环境温度: 26, 空气湿度: 60, 氧气浓度: 21, 有害气体浓度: 0.5 },
  },
])
assert('现场实测版覆盖旧版成功', res.ok, res.message)
env = svc.listRows('envmonitor')
const after = env.find((r) => r.采集时间 === '2026-09-10 09:00')
assert('覆盖后取值以现场实测为准（26℃）且结论正常', after.环境温度 === 26 && svc.evaluateRow(after).verdict === '指标正常')

// 13) 低优先级不能覆盖现场实测
res = svc.ingestReadings([
  {
    监测点位: '电力舱-03段',
    采集时间: '2026-09-10 09:00',
    source: '复核补录',
    values: { 环境温度: 50, 空气湿度: 60, 氧气浓度: 21, 有害气体浓度: 0.5 },
  },
])
assert('复核补录不得覆盖现场实测（整笔拒绝）', !res.ok, res.message)
const protectedRow = svc.listRows('envmonitor').find((r) => r.采集时间 === '2026-09-10 09:00')
assert('被拒后数据未变（前后读到同一份）', protectedRow.环境温度 === 26, String(protectedRow.环境温度))

// 14) 通风任务随唯一超标记录恢复而撤回
vent = listVent(null)
const electric = vent.find((r) => r.所属舱室 === '电力舱三段')
assert('电力舱三段恢复正常后联动任务撤回', electric.status === '已停机', electric.status)
const gasStill = vent.find((r) => r.所属舱室 === '燃气舱二段')
assert('燃气舱二段仍超标，任务保持待开机', gasStill.status === '待开机')

// 15) 禁存值整笔拒收
res = svc.ingestReadings([
  { 监测点位: '综合舱-01段', 采集时间: '2026-10-06 08:00', source: '现场实测', values: { 环境温度: 999 } },
])
assert('越过量程上限的取值禁止保存（整笔拒收）', !res.ok, res.message)
res = svc.ingestReadings([
  { 监测点位: '综合舱-01段', 采集时间: '2026-10-06 08:00', source: '现场实测', values: { 环境温度: '正常' } },
])
assert('非数值文本禁止保存（整笔拒收）', !res.ok, res.message)

// 16) 同键同源再报 → 只认最后一版
svc.ingestReadings([
  { 监测点位: '综合舱-01段', 采集时间: '2026-10-06 08:00', source: '现场实测', values: { 环境温度: 30, 空气湿度: 60, 氧气浓度: 21, 有害气体浓度: 1 } },
])
svc.ingestReadings([
  { 监测点位: '综合舱-01段', 采集时间: '2026-10-06 08:00', source: '现场实测', values: { 环境温度: 31, 空气湿度: 60, 氧气浓度: 21, 有害气体浓度: 1 } },
])
const sameKey = svc.listRows('envmonitor').filter(
  (r) => r.监测点位 === '综合舱-01段' && r.采集时间 === '2026-10-06 08:00',
)
assert('同源同键重复报送只留最后一版（31℃）', sameKey.length === 1 && sameKey[0].环境温度 === 31)

// 17) 未登记标准的点位禁止入库
res = svc.ingestReadings([
  { 监测点位: '不存在点位', 采集时间: '2026-10-06 08:00', source: '现场实测', values: { 环境温度: 30 } },
])
assert('未登记标准范围的点位禁止采集入库', !res.ok, res.message)

// 18) 幂等：回填再跑一次不产生重复
const beforeCount = svc.listRows('envmonitor').length
const again = svc.backfillHistory()
assert('回填幂等（已处理记录不重复补齐）', again.ok, again.message)
assert('回填后行数不增加', svc.listRows('envmonitor').length === beforeCount)

// 19) 快照冻结：调用方无法篡改读到的数据
const firstRead = svc.listRows('envmonitor')[0].环境温度
try {
  svc.listRows('envmonitor')[0].环境温度 = 'hack'
} catch {
  // strict mode 抛错也算通过
}
assert('读出的快照只读（防篡改）', svc.listRows('envmonitor')[0].环境温度 === firstRead)

// 20) 同一指标两处计算结论一致（复核重算 vs 列表推导）
const consistent = svc.listRows('envmonitor').every((row) => {
  const std = svc.listStandards().find((s) => s.监测点位 === row.监测点位)
  return svc.listReviewItems().find((rv) => Number(rv.环境记录) === Number(row.id))?.复核结论 ===
    svc.evaluateRow(row, std).verdict
})
assert('同一指标在列表与复核两处算出来的结论一致', consistent)

function listVent(status) {
  const all = svc.listRows('ventilation').filter((r) => r.联动来源 === '环境监测')
  return status ? all.filter((r) => r.status === status) : all
}

function allEmpty(row) {
  return row.环境温度 === '' && row.空气湿度 === '' && row.氧气浓度 === '' && row.有害气体浓度 === ''
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
