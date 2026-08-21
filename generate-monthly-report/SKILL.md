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
2. **一、项目投入统计**：表格（参与人员列只显示姓名，不显示岗位）
3. **二、人员投入统计**：表格（显示"岗位 姓名"）
4. **三、人员×项目投入矩阵（h）**：横向表格（显示"岗位 姓名"，人员列宽14%）
5. **四、月度工作总结**：按人员+项目汇总整月工作

### 工作总结格式
- 格式：`岗位 姓名（总工时h，参与X天）：项目名（工时h，参与X天）：主要工作内容`
- 优先从进展说明提取工作内容，过滤纯进度状态（如`100%`、`（未开发）`）
- 进展说明不明确时，回退到任务名称字段
- 相似任务名称自动合并（共同前缀≥5字时保留较短的）
- 不列出每日任务标签，因为任务标签加起来不等于总工时

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
