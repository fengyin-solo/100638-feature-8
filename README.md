# 城市地下综合管廊运行维护管理平台

面向管廊主体台账、入廊管线登记、廊内环境监测、通风排水消防、结构沉降与渗漏处置、巡检检修与隐患整改、入廊作业审批和运维值班的一体化城市地下综合管廊运行维护管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 管廊主体台账 | `tunnel` | 综合管廊 | 管廊编号、管廊名称、所属片区 |
| 入廊管线登记 | `pipeline` | 入廊管线 | 管线编号、所属舱室、管线类型 |
| 廊内环境监测 | `envmonitor` | 环境监测记录 + 点位标准 + 复核清单 | 四项指标按统一口径自动分档、超标联动通风 |
| 通风系统运维 | `ventilation` | 通风机组 + 超标舱室待开机任务 | 超标自动排待开机任务、同舱室只挂一条 |
| 廊内排水运维 | `drainage` | 排水泵坑 | 泵坑编号、所属舱室、集水坑容积 |
| 消防系统运维 | `firecontrol` | 消防设施 | 设施编号、所属舱室、消防类型 |
| 廊内照明运维 | `lighting` | 照明灯具 | 灯具编号、所属舱室、灯具类型 |
| 门禁安防运维 | `access` | 安防点位 | 点位编号、所属出入口、门禁类型 |
| 廊内巡检任务 | `patrol` | 巡检任务 | 巡检编号、巡检路线、巡检班组 |
| 结构沉降监测 | `settlement` | 沉降监测点 | 监测编号、监测断面、累计沉降量 |
| 渗漏水处置 | `leak` | 渗漏处置单 | 处置编号、渗漏点位、渗漏程度 |
| 设施检修管理 | `maintenance` | 检修记录 | 检修编号、检修对象、检修类别 |
| 隐患整改管理 | `hazard` | 隐患记录 | 隐患编号、隐患部位、隐患等级 |
| 应急演练管理 | `emergency` | 应急演练 | 演练编号、演练场景、参与班组 |
| 廊内能耗计量 | `energy` | 能耗计量记录 | 计量编号、计量点位、用电量 |
| 设备台账管理 | `device` | 管廊设备 | 设备编号、设备名称、设备型号 |
| 入廊作业审批 | `entryapprove` | 作业申请 | 申请编号、申请单位、作业舱室 |
| 运维值班交接 | `duty` | 值班交接记录 | 交接编号、值班班组、值班日期 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `urban-utility-tunnel:entries` 这一项，或调用 `resetModule(模块)`。

### 廊内环境监测域（判定口径唯一）

环境监测的点位标准、自动分档、复核清单与通风联动不走通用模块那套手工状态，而是独立的一域：

- `src/data/env-rules.ts` —— **判定条件与阈值唯一一份**：温度/湿度/氧气/有害气体的标准登记区间、
  仪器量程、预警带（标准带两侧外扩 20%、各指标封顶）、正常/预警/超标/未采集分档函数，以及
  「不允许保存的取值」清单。任何页面不得另抄阈值。
- `src/data/env-domain.ts` —— 点位、记录、复核清单、通风待开机任务四张表的原子读写
  （`commitEnv`：中途失败整笔退回，前后两次读到同一份数据）。
- `src/api/env-service.ts` —— 现场报送（四项必填、同点同刻只认最后一版）、历史回填
  （按下发日期一次性补齐、残缺留空标出、伪正常识别）、超标按舱室排待开机任务、复核回写。
- 完整规则与裁决依据（路径先后、冲突兜底、伪正常如何认定）见
  [`frontend/docs/env-monitor-rules.md`](frontend/docs/env-monitor-rules.md)。
