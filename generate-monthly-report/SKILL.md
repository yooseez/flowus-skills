---
name: "1-生成月报"
description: "从 FlowUs 日报数据生成项目月报 Word 文档。Invoke when user says '生成月报' or '某月月报' or asks for monthly report generation."
---

# 生成月报

当用户说"生成月报"、"上月月报"或要求生成月报时，自动执行以下流程。

## 执行步骤

### 1. 确定月份

- **月报覆盖一个自然月：1日到月末**（如7月报为7月1日到7月31日）
- 默认生成"上月"的月报
- 月份格式：`YYYY-MM`（如 `2026-07`）
- 示例：今天是2026年8月15日，则上月为2026年7月，月份参数为 `2026-07`

### 2. 提取数据

运行参数化提取脚本（位于本技能目录下）：

```bash
python "<技能目录>/extract_month.py" <YYYY-MM> <output_path>
```

示例：
```bash
python "C:\Users\HONOR\.trae-cn\skills\generate-monthly-report\extract_month.py" 2026-07 "C:\Users\HONOR\.trae-cn\skills\generate-monthly-report\month_data.json"
```

**⚠️ 人员完整性校验**：脚本运行后检查输出，如果出现 `WARNING: Found unmapped persons!`：
1. 根据输出的 uid，在 `extract_month.py` 的 `USER_MAP` 中添加映射（格式：`uid → "岗位 姓名"`）
2. 重新运行提取脚本
3. **不得带着警告直接生成报告**

### 3. 生成 Word 文档

确保 `docx` npm 包可用（首次使用时运行 `npm install docx`），然后执行：

```bash
node "<技能目录>/gen_month_docx.js" <YYYY-MM> <data_file>
```

示例：
```bash
node "C:\Users\HONOR\.trae-cn\skills\generate-monthly-report\gen_month_docx.js" 2026-07 "C:\Users\HONOR\.trae-cn\skills\generate-monthly-report\month_data.json"
```

- 生成脚本内置自然月过滤，即使数据文件包含其他月份的记录也只统计目标月份
- 输出文件自动保存到：`D:\华为家庭存储\工作文档\TIU管理\周报月报\monthly-report-YYYY-MM.docx`

### 4. 完成后

告知用户报告已生成，附上文件链接，并简要列出数据概览（记录数、总工时、工作日数、参与人数、涉及项目数）。

## 关键规则

### 人员映射
- FlowUs "人员"字段是 formula 类型，API 返回 null，无法直接读取
- 通过记录的 `created_by.id`（uid）配合 `USER_MAP` 映射到"岗位 姓名"
- USER_MAP 中的完整映射参考 `extract_month.py` 中的注释
- 添加新成员时：在 USER_MAP 中添加 `uid → "岗位 姓名"`

### 报告结构
1. **封面**（纵向）：标题"项目月报（YYYY年M月）" + 实际数据日期范围 + 统计概览表
2. **一、人员投入统计**：表格（显示"岗位 姓名"，列含"填报天数"）
3. **二、项目投入统计**：表格（参与人员列只显示姓名，不显示岗位）
- 一、二表"投入工时"列：表头为"投入工时（人天）"，数据格式"小时数（人天数）"，人天数=小时数/8四舍五入1位小数，整数不显示.0
4. **三、人员×项目投入矩阵（工时）**：横向表格（显示"岗位 姓名"，人员列宽14%）
5. **四、月度工作总结**：按人员+项目汇总整月工作

### 工作总结格式
- 人员名显示蓝色（color: 0066CC），加粗，字号22（比项目名大一号）
- 项目名黑色加粗，缩进120；工作条目缩进480，层级清晰
- 项目名后显示工时和天数，然后换行显示工作描述
- 工作总结人员行格式：`岗位 姓名  工时数工时（合计X人天），填报X次`（人天数=工时/8，整数不显示.0）
- 工作总结项目行格式：`项目名  工时数工时（合计X人天），填报X次`
- 工作描述带序号（1, 2, 3...），每人序号独立从1开始
- 优先从进展说明提取工作内容，过滤纯进度状态（如`100%`、`（未开发）`）
- 进展说明过短（<6字）时，结合任务名称显示为"任务名称：进展内容"
- 进展说明不存在时，回退到任务名称字段
- 去重合并（mergeSimilarItems）：前缀匹配≥5字、包含关系、或字符级Jaccard相似度≥0.7
- 主题分组（groupThemes）：3+项共享≥2字前缀时全部合并为一个摘要，超5项取最短5项
- 前缀重命名："生产"/"生产环境"→"其他运维"，"处理"→"其他"（避免过于笼统的分组名）
- 排版格式化（formatWorkItems）：系列任务（含"相关"）和长任务（>15字）单独一行带序号；多个零碎任务合并一行带序号
- "其他.*相关"开头的条目自动排到最后
- "处理相关问题"自动改为"处理其他问题"
- 不列出每日任务标签，因为任务标签加起来不等于总工时
- 跨月时标题为纯"项目月报"（无括号日期），单月时为"项目月报（YYYY年M月）"

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
