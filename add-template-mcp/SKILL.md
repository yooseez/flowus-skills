---
name: "0-添加模版（MCP）"
description: "通过 MCP 查询 Flowus 多维表记录并批量创建新模版记录（只复制任务名称），支持附带日期参数设置填报日期。Invoke when user says '添加模版（MCP）' or clicks this skill."
---

# 0-添加模版（MCP）

当用户说"添加模版（MCP）"或点击此技能时，自动执行以下流程。用户可在"添加模版（MCP）"后附带日期参数（如"添加模版（MCP） 昨天"、"添加模版（MCP） 明天"、"添加模版（MCP） 8月16日"），用于指定新记录的"填报日期"。

## API 调用方式

使用 **MCP** 调用 FlowUs API（不依赖 CLI）：

- **MCP 服务器**：`mcp_flowus`
- **数据库 ID**：`bc84d926-8df2-4662-9751-6a35e8761d14`
- **查询工具**：`query_database`（`POST /v2/databases/{database_id}/query`）
- **创建工具**：`create_page`（`POST /v2/pages`）

### MCP 调用格式

```
run_mcp:
  server_name: "mcp_flowus"
  tool_name: "query_database"
  args:
    database_id: "bc84d926-8df2-4662-9751-6a35e8761d14"
    page_size: 15
    body: { filter 和 sorts }
```

> **重要**：`page_size` 是顶层参数，不要放入 `body` 内。`body` 只包含 `filter` 和 `sorts`。

### 日期格式规则

| 筛选字段 | 格式 | 示例 |
|---|---|---|
| `created_time`（timestamp 筛选） | `YYYY-MM-DD`（短横线） | `2026-08-16` |
| `填报日期`（date 属性筛选） | `YYYY/MM/DD`（斜杠） | `2026/08/16` |

> 创建记录时 `填报日期` 的 `start` 值使用 `YYYY-MM-DD` 格式，API 会自动转换为 `YYYY/MM/DD` 存储。

## 日期参数解析

从用户输入中解析可选的日期参数：
- 无日期参数 → 目标日期 = 今天，不设置"填报日期"
- "昨天" → 目标日期 = 今天 - 1
- "明天" → 目标日期 = 今天 + 1
- "今天" → 目标日期 = 今天，不设置"填报日期"
- "X月X日" / "X月X" → 目标日期 = 当前年份-X月-X日
- "YYYY-MM-DD" → 目标日期 = 指定日期

## 执行步骤

### 1. 确定日期

- 今天日期
- 目标日期 = 从用户输入解析（默认为今天）
- 回溯起始日期 = 目标日期 - 3 天
- 格式：`YYYY-MM-DD`（created_time 用短横线，填报日期用斜杠）

### 2. 合并查询：检查目标日期 + 查找源数据（单次 MCP 调用）

一次查询覆盖 `[目标日期-3天, 目标日期+1天)` 范围，同时完成：
- 检查目标日期是否已有数据
- 查找目标日期前最近有数据的日期

调用 `run_mcp`（`server_name: "mcp_flowus"`, `tool_name: "query_database"`），`args` 包含：

```json
{
  "database_id": "bc84d926-8df2-4662-9751-6a35e8761d14",
  "page_size": 15,
  "body": {
    "filter": {
      "or": [
        {
          "and": [
            { "timestamp": "created_time", "created_time": { "on_or_after": "<目标日期-3天 YYYY-MM-DD>" } },
            { "timestamp": "created_time", "created_time": { "before": "<目标日期+1天 YYYY-MM-DD>" } }
          ]
        },
        {
          "and": [
            { "property": "填报日期", "date": { "on_or_after": "<目标日期-3天 YYYY/MM/DD>" } },
            { "property": "填报日期", "date": { "before": "<目标日期+1天 YYYY/MM/DD>" } }
          ]
        }
      ]
    }
  }
}
```

> **注意**：`page_size` 必须作为顶层参数，不能放在 `body` 内。`body` 只包含 `filter`，**不支持 `sorts` 字段**。如需排序，在客户端解析结果时自行排序。

### 3. 在上下文中解析查询结果

MCP 返回结果直接进入上下文，由助手直接解析（无需临时文件、无需 Node.js 脚本）：

1. **计算自动实际日期**：
   - 如果记录的 `填报日期` 有值 → 取 `填报日期`（格式化为 `YYYY-MM-DD`）
   - 如果 `填报日期` 为空 → 取 `created_time` 的日期部分

2. **检查目标日期是否已有数据**：
   - 遍历所有记录，如果有任何记录的自动实际日期 === 目标日期 → 输出 `HAS_DATA`

3. **查找源数据**：
   - 筛选自动实际日期 < 目标日期 且有 `任务名称` 关联 ID 的记录
   - 按日期分组，取最近的一天
   - 提取该天所有记录的 `任务名称` 关联 ID

### 4. 根据解析结果决定后续操作

| 情况 | 操作 |
|---|---|
| 目标日期已有数据 | 用纯文本提示用户已有数据，用户回复"继续"则跳过检查直接创建 |
| 3天内无源数据 | 提示用户无数据可复制，终止 |
| 找到源数据 | 进入第 5 步创建记录 |

**HAS_DATA 交互流程（不使用 AskUserQuestion）**：
1. 用纯文本告知用户"今天已有数据，回复'继续'可跳过检查直接创建"
2. 用户回复"继续"后，跳过检查直接进入第 5 步
3. 用户未回复"继续"则视为取消，不再创建记录

### 5. 批量创建记录（并行 MCP 调用）

对每个 `任务名称` 关联 ID，并行调用 `run_mcp`（`server_name: "mcp_flowus"`, `tool_name: "create_page"`），`args` 包含：

```json
{
  "body": {
    "parent": { "database_id": "bc84d926-8df2-4662-9751-6a35e8761d14" },
    "properties": {
      "备注": { "type": "title", "title": [{ "type": "text", "text": { "content": "", "link": null }, "annotations": { "bold": false, "italic": false, "strikethrough": false, "underline": false, "code": false, "color": "default" }, "plain_text": "", "href": null }] },
      "任务名称": { "type": "relation", "relation": [{ "id": "<任务名称关联ID>" }] }
    }
  }
}
```

> **重要**：`annotations` 对象必须包含全部 6 个字段（`bold`、`italic`、`strikethrough`、`underline`、`code`、`color`），否则 MCP 会拒绝。`plain_text` 和 `href` 也是必填字段。

如果设置了填报日期，在 `properties` 中额外添加：
```json
"填报日期": { "type": "date", "date": { "start": "<目标日期 YYYY-MM-DD>", "end": null, "time_zone": null } }
```

> **注意**：`create_page` 工具的所有参数（`parent`、`properties`）都放在 `body` 内，不像 `query_database` 那样分顶层和 body。

**并行调用**：所有记录的创建在同一个消息中并行发起（多个 `run_mcp` 调用），减少等待时间。

### 6. 输出摘要

创建完成后，输出精简摘要：
```
源数据日期：YYYY-MM-DD
提取任务数量：N 条
创建成功：X 条
创建失败：Y 条
```

## 自动实际日期计算规则

| 条件 | 自动实际日期 |
|---|---|
| "填报日期"有值 | 取"填报日期" |
| "填报日期"为空 | 取 `created_time`（日期部分） |

## 不复制的字段

实际投入（小时）、开始时间、结束时间、No. 等字段均不设置。

## 与 CLI 版本对比

| 对比项 | CLI 版本（add-template） | MCP 版本（add-template-mcp） |
|---|---|---|
| 查询方式 | FlowUs CLI | MCP `query_database` |
| 创建方式 | Node.js 脚本 + CLI | MCP `create_page`（并行） |
| 临时文件 | 需要查询结果文件 + 创建 body 文件 | 不需要（MCP 直接传参） |
| 解析方式 | Node.js 脚本 | 助手在上下文中直接解析 |
| 创建并行性 | 脚本内串行 | 多个 MCP 调用并行 |
| 预计工具调用 | ~3 次（Skill + Shell 合并） | ~3 次（Skill + 查询 + 并行创建） |

## 注意事项

- 如果 MCP 返回空结果 `[]`，可能是 MCP 服务器故障，可回退到 CLI 版本（`add-template` 技能）
- MCP 创建记录使用的是 MCP 关联的应用身份（trae2 机器人）
- `填报日期` 的 `date` 属性需要包含 `end: null` 和 `time_zone: null`
- **工具命名规则**：新版本 MCP 使用小写下划线命名（`query_database`、`create_page`），旧版本使用驼峰命名（`API-queryDatabase`、`API-createPage`）
- **参数结构差异**：`query_database` 的 `page_size` 是顶层参数，`create_page` 的所有参数都在 `body` 内
