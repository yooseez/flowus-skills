# FlowUs 技能集

用于 TRAE 的 FlowUs 日报数据自动创建和报表生成技能。

## 技能列表

### 0-添加模版（CLI）

通过 FlowUs CLI 自动查询前一天日报数据，批量创建当天（或指定日期）的日报记录。

**核心功能：**
- 查询目标日期前最近有数据的工作日记录
- 批量创建新记录（仅复制任务名称关联）
- 自动建立双向关联（`任务名称` → 原任务 + `同步任务名称` 反向关联）
- 支持日期参数（昨天/明天/X月X日/YYYY-MM-DD）
- 创建前检查目标日期是否已有数据

**文件：** `add-template/`
- `SKILL.md` — 技能定义文档
- `parse_and_create.js` — 批量解析与创建脚本

### 0-添加模版（MCP）

功能与 CLI 版本相同，使用 MCP 协议调用 FlowUs API。

**文件：** `add-template-mcp/`
- `SKILL.md` — 技能定义文档

### 1-生成周报

从 FlowUs 日报数据自动生成项目周报 Word 文档。

**核心功能：**
- 查询指定周的日报数据
- 按项目/任务汇总实际投入和计划人天
- 生成格式化的 Word 周报文档
- 支持日期参数（上周/本周/X月X日所在周）

**文件：** `generate-weekly-report/`
- `SKILL.md` — 技能定义文档
- `extract_week.py` — 数据提取脚本
- `gen_week_docx.js` — Word 文档生成脚本
- `package.json` — 依赖配置

### 1-生成月报

从 FlowUs 日报数据自动生成项目月报 Word 文档。

**核心功能：**
- 查询指定月的日报数据
- 按项目/任务汇总实际投入和计划人天
- 生成格式化的 Word 月报文档
- 支持日期参数（上月/本月/X月）

**文件：** `generate-monthly-report/`
- `SKILL.md` — 技能定义文档
- `extract_month.py` — 数据提取脚本
- `gen_month_docx.js` — Word 文档生成脚本
- `package.json` — 依赖配置

## 环境要求

- Node.js
- Python 3（周报月报技能需要）
- FlowUs CLI（路径：`C:\Users\HONOR\AppData\Local\Programs\FlowUs\bin\flowus.exe`）
- FlowUs 集成权限（`pages.write`）

## 安装使用

1. 将对应技能文件夹放入 TRAE 项目的 `.trae/skills/` 目录下
2. 周报/月报技能需在对应目录执行 `npm install` 安装依赖
3. 在 TRAE 中输入技能触发词即可使用

## 关键技术点

- FlowUs API 创建记录时只建立单向关联，需手动补建原任务的 `同步任务名称` 反向关联，否则 rollup 公式（如"实际/计划人天"）无法自动计算
- `created_time` 筛选用 `YYYY-MM-DD` 格式，`填报日期` 属性筛选用 `YYYY/MM/DD` 格式
- `备注` 字段必须用空数组 `"title": []` 设置，完全省略会导致 400 错误
