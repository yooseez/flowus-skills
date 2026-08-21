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
- 默认生成"上周"的周报；用户说"本周"则生成本周
- **计算方法**（用 Python datetime）：
  ```python
  from datetime import datetime, timedelta
  today = datetime.now()
  # weekday(): Monday=0, Sunday=6
  if 用户说"本周":
      monday = today - timedelta(days=today.weekday())
  else:  # "上周"
      monday = today - timedelta(days=today.weekday() + 7)
  sunday = monday + timedelta(days=6)
  friday = monday + timedelta(days=4)
  # API查询范围: monday 到 sunday（含周末，确保不遗漏）
  # 报告实际覆盖: monday 到 friday（工作日）
  ```
- 示例：今天是2026年8月15日（周六），today.weekday()=5
  - 本周：monday = 8/15 - 5天 = 8/10（周一），sunday = 8/16
  - 上周：monday = 8/15 - 12天 = 8/3（周一），sunday = 8/9
- ⚠️ **必须用 datetime.weekday() 计算周一日期，不要靠猜**
- 日期格式必须是 `YYYY/MM/DD`（斜杠，FlowUs API 要求）

### 2. 提取数据

运行参数化提取脚本（位于本技能目录下）：

```bash
python "<技能目录>/extract_week.py" <start_date> <end_date> <output_path>
```

示例：
```bash
python "C:\Users\HONOR\.trae-cn\skills\generate-weekly-report\extract_week.py" 2026/08/03 2026/08/07 "C:\Users\HONOR\.trae-cn\skills\generate-weekly-report\week_data.json"
```

**⚠️ 人员完整性校验**：脚本运行后检查输出，如果出现 `WARNING: Found unmapped persons!`：
1. 根据输出的 uid，在 `extract_week.py` 的 `USER_MAP` 中添加映射（格式：`uid → "岗位 姓名"`）
2. 重新运行提取脚本
3. **不得带着警告直接生成报告**

### 3. 生成 Word 文档

确保 `docx` npm 包可用（首次使用时运行 `npm install docx`），然后执行：

```bash
node "<技能目录>/gen_week_docx.js" <startDY> <endDY> <data_file>
```

示例：
```bash
node "C:\Users\HONOR\.trae-cn\skills\generate-weekly-report\gen_week_docx.js" 3 7 "C:\Users\HONOR\.trae-cn\skills\generate-weekly-report\week_data.json"
```

- `startDY` / `endDY`：日期的"日"部分（如3和7），用于过滤API可能返回的额外日期
- 输出文件自动保存到：`D:\华为家庭存储\工作文档\TIU管理\周报月报\weekly-report-YYYY-MMDD-MMDD.docx`

### 4. 完成后

告知用户报告已生成，附上文件链接，并简要列出数据概览（记录数、总工时、工作日数、参与人数、涉及项目数）。

## 关键规则

### 人员映射
- FlowUs "人员"字段是 formula 类型，API 返回 null，无法直接读取
- 通过记录的 `created_by.id`（uid）配合 `USER_MAP` 映射到"岗位 姓名"
- USER_MAP 中的完整映射参考 `extract_week.py` 中的注释
- 添加新成员时：在 USER_MAP 中添加 `uid → "岗位 姓名"`

### 报告结构
1. **封面**（纵向）：标题"项目周报" + 日期范围 + 统计概览表
2. **一、人员投入统计**：表格（显示"岗位 姓名"，列含"填报天数"）
3. **二、项目投入统计**：表格（参与人员列只显示姓名，不显示岗位）
4. **三、人员×项目投入矩阵（h）**：横向表格（显示"岗位 姓名"，人员列宽14%）
5. **四、本周工作总结**：按人员+项目汇总一周工作（不是每日单独列出）
- ❌ **不含"下周工作计划"**

### 工作总结格式
- 人员名显示蓝色（color: 0066CC），加粗，字号22（比项目名大一号）
- 项目名黑色加粗，缩进120；工作条目缩进480，层级清晰
- 项目名后显示工时和天数，然后换行显示工作描述
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

### FlowUs API 参数
- 数据库ID: `1a9c4392-b5ae-48f4-aa3b-e05135215dce`
- CLI路径: `C:\Users\HONOR\AppData\Local\Programs\FlowUs\bin\flowus.exe`
- 日期过滤必须用斜杠格式 `YYYY/MM/DD`
- 查询必须带 `sorts` + `page_size: 100`
- 进展说明与项目严格按索引对应：progress-1 → projects[0]
