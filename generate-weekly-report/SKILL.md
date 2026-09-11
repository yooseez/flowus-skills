---
name: "1-生成周报"
description: "从 FlowUs 日报数据生成项目周报 Word 文档。Invoke when user says '生成周报' or '上周周报' or asks for weekly report generation."
---

# 生成周报

当用户说"生成周报"、"上周周报"或要求生成周报时，自动执行以下流程。

## 执行步骤

### 1. 确定日期范围

- **一周的定义：周一到周日**（7天为一个自然周）
- **周报覆盖工作日：周一到周五**（周末一般无日报数据）

#### 1.1 参数解析规则

**无参数时（默认逻辑）：**
- 判断今天是周几：如果今天是周五或更晚（weekday >= 4），则生成本周周报；否则生成上周周报
- ⚠️ **必须用 Python datetime 计算周一日期，禁止手动猜测星期几**（详见1.2节）
- 周报日期范围 = 周一到周五（5个工作日），不是周一到周日
- 示例：今天是周三 → 生成上周周报；今天是周五 → 生成本周周报

**有参数时：**
根据用户传入的参数确定日期范围：

| 参数 | 含义 | 日期范围 |
|------|------|----------|
| `本周` | 本周周报 | 本周一到本周日 |
| `上周` | 上周周报 | 上周一到上周日 |
| `X月X日到Y月Y日`（如`8月3日到8月7日`） | 自定义日期范围周报 | 起始日到结束日（≤14天视为周报） |
| `YYYY-MM-DD到YYYY-MM-DD` | 自定义日期范围周报 | 起始日到结束日（如 ≤14天视为周报） |

- 参数含"周"关键字 → 按周报处理
- 自定义日期范围：天数 ≤14 → 周报，>14 → 月报
- 未指定年份默认当前年

#### 1.2 计算方法（用 Python datetime）
  ```python
  from datetime import datetime, timedelta
  today = datetime.now()
  # weekday(): Monday=0, Sunday=6
  # 无参数默认逻辑：周五或更晚(weekday>=4) → 本周，否则 → 上周
  # 有参数"本周" → 本周，"上周" → 上周
  if 参数 == "本周" or (无参数 and today.weekday() >= 4):
      monday = today - timedelta(days=today.weekday())
  else:  # "上周" 或 无参数且weekday<4
      monday = today - timedelta(days=today.weekday() + 7)
  sunday = monday + timedelta(days=6)
  friday = monday + timedelta(days=4)
  # API查询范围: monday 到 sunday（含周末，确保不遗漏）
  # 报告实际覆盖: monday 到 friday（工作日）
  ```
- 示例：今天是2026年8月15日（周六），today.weekday()=5
  - 本周：monday = 8/15 - 5天 = 8/10（周一），sunday = 8/16
  - 上周：monday = 8/15 - 12天 = 8/3（周一），sunday = 8/9
- ⚠️ **必须用 Python datetime 计算周一日期，禁止手动猜测星期几**
- 提取数据传周一到周日（含周末确保不遗漏）
- 生成文档传周一到周五（工作日）
- 日期格式必须是 `YYYY/MM/DD`（斜杠，FlowUs API 要求）

### 2. 提取数据

运行参数化提取脚本（位于本技能目录下），**日期范围传周一到周日**：

```bash
python "C:\Users\HONOR\Documents\flowus-skills\generate-weekly-report\extract_week.py" <monday> <sunday> <output_path>
```

- 日期格式支持连字符（`2026-08-03`）和斜杠（`2026/08/03`），脚本自动转换为 API 要求的斜杠格式

示例：
```bash
python "C:\Users\HONOR\Documents\flowus-skills\generate-weekly-report\extract_week.py" 2026-08-03 2026-08-07 "C:\Users\HONOR\AppData\Local\Temp\week_data.json"
```

**⚠️ 人员完整性校验**：脚本运行后检查输出，如果出现 `WARNING: Found unmapped persons!`：
1. 根据输出的 uid，在 `extract_week.py` 的 `USER_MAP` 中添加映射（格式：`uid → "岗位 姓名"`）
2. 重新运行提取脚本
3. **不得带着警告直接生成报告**

> **⚠️ 认证：脚本不固化认证方式，只在 CLI 自己没法认证时才兜底**
>
> 脚本**默认完全不碰 `FLOWUS_TOKEN`**——先让 FlowUs CLI 自己认证（env 静态密钥 / OAuth / 由调用方环境决定），行为与改造前一致，因此 **TRAE 等自带认证的环境无需任何改动**。
>
> 只有当 CLI **明确回报「缺少 token」**时，脚本才从注册表 `HKCU\Environment\FLOWUS_TOKEN` 读一次（python `winreg`，进程内读、不落盘、不 spawn `reg.exe`）注入并**重试一次**。这就是 WorkBuddy 会话没继承环境变量时的自愈路径，stdout 会打印 `[auth] CLI 报缺少 token，已从注册表读取 FLOWUS_TOKEN（长度 40）并重试一次`。
>
> **关闭兜底**（如 TRAE 要完全走自己的认证）：设 `FLOWUS_SKIP_TOKEN_FALLBACK=1`，脚本绝不读写 `FLOWUS_TOKEN`，直接把 CLI 原始报错交回。
>
> ❌ **禁止事项**（WorkBuddy 侧一律不走网页认证 / OAuth 那条路）：
> - 不要执行 `flowus.exe login`
> - 不要读取或检查 `C:\Users\HONOR\.flowus\credentials.json`
> - 不要参照 TRAE 的 MCP 令牌配置（`%APPDATA%\TRAE SOLO CN\User\mcp.json` 里 URL 上的 `?token=`）
> - 不要为了认证去调 PowerShell / 手动 `export` —— 脚本自己会读，多此一举还容易把令牌搞失效
>
> 原因：网页授权是"重新签发新令牌、旧令牌作废"，同属一套授权体系，动它就会把静态密钥方案连带搞坏。
>
> **0 条记录如何判断**：脚本已内置区分，看**退出码 + stderr** 即可，无需再做任何认证排查——
> - 退出码 **2**，stderr 出现 `✖ 数据读取失败 —— 这【不是】"该日期无数据"` → 认证/权限问题。唯一处理方式：请用户确认 Windows **用户级**环境变量 `FLOWUS_TOKEN` 已配置（40 字符静态密钥），配好后重跑即可
> - 退出码 **0**，stdout 出现 `ⓘ 本次查询成功（API 正常），该日期范围确实没有日报记录。` → 真·无数据，可如实告知用户


### 3. 生成 Word 文档

确保 `docx` npm 包可用（首次使用时运行 `npm install docx`），然后执行，**日期范围传周一到周五（工作日）**：

```bash
node "C:\Users\HONOR\Documents\flowus-skills\generate-weekly-report\gen_week_docx.js" <monday_YYYY-MM-DD> <friday_YYYY-MM-DD> <data_file>
```

示例：
```bash
node "C:\Users\HONOR\Documents\flowus-skills\generate-weekly-report\gen_week_docx.js" 2026-08-03 2026-08-07 "C:\Users\HONOR\AppData\Local\Temp\week_data.json"
```

- 生成脚本内置完整日期范围过滤（按年月日比较），即使数据文件包含范围外的记录也只统计目标范围，跨月周（如8/27-9/2）也能正确过滤
- 输出文件自动保存到：`D:\华为家庭存储\工作文档\TIU管理\周报月报\项目开发团队周报-2026年8月3日-8月7日.docx`（中文命名，同年只写一次年，跨年写完整日期）
- 标题恒为纯"项目开发团队周报"（不带括号年月，与月报不同：月报跨月纯标题、单月带括号，周报一律纯标题）

### 4. 完成后

告知用户报告已生成，附上文件链接，并简要列出数据概览（记录数、总工时、工作日数、参与人数、涉及项目数）。

## 关键规则

### 人员映射
- FlowUs "人员"字段是 formula 类型，API 返回 null，无法直接读取
- 通过记录的 `created_by.id`（uid）配合 `USER_MAP` 映射到"岗位 姓名"
- USER_MAP 中的完整映射参考 `extract_week.py` 中的注释
- 添加新成员时：在 USER_MAP 中添加 `uid → "岗位 姓名"`

### 报告结构
1. **封面**（纵向）：标题"项目开发团队周报"（恒为纯标题，不带括号年月） + 实际数据日期范围 + 统计概览表 + 底部注释"本报告由每日日报自动总结生成"
2. **一、项目投入统计**：表格（参与人员列只显示姓名，不显示岗位）
3. **二、人员投入统计**：表格（显示"岗位 姓名"，列含"填报天数"）
- 一、二表"投入工时"列：表头为"投入工时（人天）"，数据格式"小时数（人天数）"，人天数=小时数/8四舍五入1位小数，整数不显示.0
- ⚠️ **一、二章节顺序固定为"先项目后人员"**（与总结顺序一致），不要写成"先人员后项目"
4. **三、人员×项目投入矩阵（工时）**：横向表格（显示"岗位 姓名"，人员列宽14%）
5. **四、项目周度工作总结**（先项目）：按项目汇总所有人员工作，简化为类别名称（不列明细），"其他运维相关工作"和"其他相关工作"合并为"运维及其他工作"
6. **五、人员周度工作总结**（后人员）：按人员+项目汇总一周工作（详细）
- ⚠️ **章节顺序有分支**（`matrixNeedsSplit`，矩阵过长需拆分时矩阵移到末尾，避免表格跨页）：
  - 常规：三=人员×项目投入矩阵 → 四=项目周度工作总结 → 五=人员周度工作总结
  - 矩阵需拆分：三=项目周度工作总结 → 四=人员周度工作总结 → 五=人员×项目投入矩阵
- 项目排序：非HD项目排末尾，其余按工时降序
- 项目总结是人员总结的**严格子集**（从人员总结输出反向汇总，保证两边条目一致）
- ❌ **不含"下周工作计划"**

### 工作总结格式
- 人员名显示蓝色（color: 0066CC），加粗，字号22（比项目名大一号）
- 项目名黑色加粗，缩进120；工作条目缩进480，层级清晰
- 项目名后显示工时和天数，然后换行显示工作描述
- 人员总结行格式：`岗位 姓名  工时数工时（合计X人天），总共填报X次`（人天数=工时/8，整数不显示.0）
- 项目总结行格式：`项目名  工时数工时（合计X人天），X人参与（人员列表）`
- 项目内工作行格式：`项目名  工时数工时（合计X人天），填报X次`
- 工作描述带序号（1, 2, 3...），每人序号独立从1开始
- 优先从进展说明提取工作内容，过滤纯进度状态（如`100%`、`（未开发）`），仅最后一天保留百分比
- 进展说明过短（<6字）时，结合任务名称显示为"任务名称+进展内容"（无冒号）
- 进展说明不存在时，回退到任务名称字段
- 冒号处理（removeColons）：短前缀（≤4字）直接去掉冒号，长前缀替换为逗号
- 平凡任务过滤（filterTrivialTasks）：过滤"提交脚本/提交代码"类条目（始终生效）
- 运维预处理（preprocessMaintenanceTasks）："处理"开头的条目归入"运维及其他工作"，不逐条列出
- 前缀合并（mergeByPrefix）：共享4+字前缀的条目合并为概括名称（如"沟通功能开发"+"沟通功能调整"→"沟通功能优化"）
- 成对组合并（mergePairedGroups）：已分组的条目共享2+字前缀时合并（如"法治工作部署、要点、考核等功能开发"+"法治专项工作相关功能开发"→合并）
- 同类合并（mergeByCategory）：同类别条目≥3项时合并（如3+文档类→"编写说明文档"，3+问题类→"问题处理相关工作"，3+操作指引→"操作指引沟通"）
- 去重合并（mergeSimilarItems）：前缀匹配≥5字、包含关系、或字符级Jaccard相似度≥0.7（跳过已是主题组的条目避免误合并）
- 主题分组（groupThemes）：3+项共享≥2字前缀时全部合并为一个摘要，超5项取最短5项；按任务性质自动判定后缀（功能开发/相关问题处理/功能开发及相关问题处理）
- 后缀合并（combineSuffix）：避免"XX相关相关问题处理"式重复（后缀已含"相关"时不再加）
- 前缀重命名："生产"/"生产环境"→"其他运维"，"处理"→"其他"（避免过于笼统的分组名）
- 统一简化（simplifySummary）："问题处理相关工作/其他运维相关工作/其他相关工作"→"运维及其他工作"；相关主题组合并（mergeRelatedGroups，如"合同"+"历史合同"→"合同及历史合同"）；"运维及其他工作"吸收同类子类别（mergeSubCategories）并排到最后；"生产环境/生产运维相关问题处理"合并为"运维相关问题处理"
- 条目过多时：>15条只留主题组和类别标签；>8条先按多天保留（dropSecondaryTasks 删除部署/熟悉/初始化等次要任务）
- 分类排序（sortByCategory/classifyWork）：按 功能开发→问题处理→文档→运维→需求沟通→售前→其他 排序，主题组排前，"运维及其他工作"永远最后
- 排版格式化（formatWorkItems）：按类别排序后编号，不再用"系列任务单行/零碎任务合并"的旧逻辑
- 拼接清洁（trimEndPunct / stripTrailingEtc / cleanForJoin）：条目在参与 "、" 拼接前去掉末尾标点（。；，、！？等）与末尾"等"字
  - 末尾标点会造成 "。、" 怪组合（如"…公司领导。、杭州机场…"）
  - 末尾标点还会让 stripActionSuffix 的结尾匹配失效（如 "XX功能开发。" 剥不掉 "功能开发"）
  - 条目自带"等"再拼 suffix 会重复成"等等"（如"…反馈等等功能开发" → "…反馈等功能开发"）
- 不列出每日任务标签，因为任务标签加起来不等于总工时
- 标题恒为纯"项目开发团队周报"（不带括号年月）

### 页面布局
- 封面Section：纵向（Portrait）
- 正文Section：横向（Landscape），尺寸 16838×11906 DXA，margin 720
- 封面概览表宽度：6000 DXA
- 一、二表宽度：9000 DXA
- 三矩阵表宽度：100% PERCENTAGE（不用DXA，不用FIXED）
  - 人员列：14%，合计列：8%，项目列：Math.floor((100-14-8)/项目数)%

### FlowUs API 参数
- 数据库ID: `1a9c4392-b5ae-48f4-aa3b-e05135215dce`
- CLI路径: `C:\Users\HONOR\AppData\Local\Programs\FlowUs\bin\flowus.exe`
- 日期过滤必须用斜杠格式 `YYYY/MM/DD`
- 查询必须带 `sorts` + `page_size: 100`
- 进展说明与项目严格按索引对应：progress-1 → projects[0]
