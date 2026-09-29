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
- **更新工具**：`update_page`（`PATCH /v2/pages/{page_id}`）

### MCP 调用格式

```
run_mcp:
  server_name: "mcp_flowus"
  tool_name: "query_database"
  args:
    database_id: "bc84d926-8df2-4662-9751-6a35e8761d14"
    page_size: 30
    body: { filter }
```

> **重要**：`page_size` 是顶层参数，不要放入 `body` 内。`body` 只包含 `filter`，**不支持 `sorts` 字段**。如需排序，在客户端解析结果时自行排序。

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

### 2. 分页查询：检查目标日期 + 查找源数据

**必须分页获取全部数据**，确保 HAS_DATA 检查不遗漏。查询覆盖 `[目标日期-3天, 目标日期+1天)` 范围。

**分页循环逻辑**：
1. 第一次调用 `query_database`，不传 `start_cursor`
2. 如果返回结果中 `has_more` 为 true，用 `next_cursor` 作为 `start_cursor` 继续查询下一页
3. 重复直到 `has_more` 为 false
4. 将所有页的 `results` 合并成完整记录列表

每次调用 `run_mcp`（`server_name: "mcp_flowus"`, `tool_name: "query_database"`），`args` 包含：

```json
{
  "database_id": "bc84d926-8df2-4662-9751-6a35e8761d14",
  "page_size": 30,
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
  },
  "start_cursor": "<下一页游标，第一页不传>"
}
```

> **注意**：`start_cursor` 是顶层参数，和 `page_size` 同级。

### 3. 在上下文中解析查询结果

MCP 返回结果直接进入上下文，解析所有分页合并后的记录：

1. **计算自动实际日期**（时区修复：created_time 需 +8h 转北京时间）：
   - 如果记录的 `填报日期` 有值 → 取 `填报日期`（格式化为 `YYYY-MM-DD`）
   - 如果 `填报日期` 为空 → 取 `created_time` **加 8 小时**后的日期部分（北京时间）
   > **关键修复**：FlowUs API 返回的 `created_time` 是 UTC 时间。凌晨创建的记录 UTC 日期是前一天，直接取日期部分会导致误判为前一天，从而选错源数据。必须先 `+8h` 转换为北京时间再取日期。

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
2. 用户回复"继续"后，先删除目标日期的已有记录并清理双向关联，再进入第 5 步创建新记录
3. 用户未回复"继续"则视为取消，不再创建记录

> **关键修复（删除时清理双向关联）**：跳过检查时需先删除目标日期已有记录。删除前必须读取每条记录的 `任务名称` 关联的原任务 ID，然后从原任务的 `同步任务名称` 字段中移除待删除记录的 ID，最后将记录移到回收站（`in_trash: true`）。否则回收站记录仍被 rollup 公式统计，导致公式错误。
>
> **删除流程**：
> 1. 对每条待删除记录，调用 `get_page` 获取其 `任务名称` 关联的原任务 ID
> 2. 按 `taskId` 分组，对每个原任务调用 `get_page` 读取 `同步任务名称` 当前关联列表
> 3. 从列表中移除所有待删除记录的 ID，调用 `update_page` 更新原任务的 `同步任务名称`
> 4. **删除记录需借助 CLI**：MCP 的 `update_page` 不支持 `in_trash` 字段（只接受 `icon`、`cover`、`properties`），需用 CLI 执行删除：
>    ```
>    flowus.exe --json api call PATCH /v2/pages/<page_id> --body <body_file.json>
>    ```
>    body 文件内容：`{"in_trash": true}`

### 5. 批量创建记录（并行 MCP 调用）

对每个 `任务名称` 关联 ID，并行调用 `run_mcp`（`server_name: "mcp_flowus"`, `tool_name: "create_page"`），`args` 包含：

```json
{
  "body": {
    "parent": { "database_id": "bc84d926-8df2-4662-9751-6a35e8761d14" },
    "properties": {
      "备注": { "type": "title", "title": [] },
      "任务名称": { "type": "relation", "relation": [{ "id": "<任务名称关联ID>" }] }
    }
  }
}
```

如果设置了填报日期，在 `properties` 中额外添加：
```json
"填报日期": { "type": "date", "date": { "start": "<目标日期 YYYY-MM-DD>", "end": null, "time_zone": null } }
```

> **注意**：`create_page` 工具的所有参数（`parent`、`properties`）都放在 `body` 内，不像 `query_database` 那样分顶层和 body。
>
> **备注字段**：使用空数组 `"title": []`，不要带内容对象，否则会导致公式字段异常。

**并行调用**：所有记录的创建在同一个消息中并行发起（多个 `run_mcp` 调用），减少等待时间。需要记录每个创建成功记录的 `id` 和对应的 `任务名称` 关联 ID，用于第 6 步反向关联。

### 6. 建立反向关联（补建同步任务名称）

> **关键修复**：FlowUs API 创建记录时只建立单向的 `任务名称` 关联，不会自动更新原任务的 `同步任务名称` 反向关联字段。原任务的 rollup 公式（如"实际/计划人天"）依赖 `同步任务名称` 字段汇总所有关联记录的"实际投入"，缺少反向关联时公式无法计算。

**操作步骤**：
1. 收集创建成功的记录：`{ pageId, taskId }` 列表
2. 按 `taskId` 去重（同一个原任务只读取一次）
3. 对每个唯一的 `taskId`（原任务 ID）：
   - 调用 `get_page`（`server_name: "mcp_flowus"`, `tool_name: "get_page"`）读取原任务当前的 `同步任务名称` 关联列表
   - 将新记录的 `pageId` 追加到列表中（已存在则跳过）
   - 调用 `update_page`（`server_name: "mcp_flowus"`, `tool_name: "update_page"`）更新原任务的 `同步任务名称` 字段

**`update_page` 调用格式**：
```
run_mcp:
  server_name: "mcp_flowus"
  tool_name: "update_page"
  args:
    page_id: "<原任务ID>"
    body:
      properties:
        "同步任务名称":
          type: "relation"
          relation:
            - { id: "旧ID1" }
            - { id: "旧ID2" }
            - { id: "新记录ID" }
            ...
```

### 7. 输出摘要

创建完成后，输出精简摘要：
```
源数据日期：YYYY-MM-DD
提取任务数量：N 条
创建成功：X 条
创建失败：Y 条
反向关联成功：X 条
反向关联失败：Y 条
```

## 自动实际日期计算规则

| 条件 | 自动实际日期 |
|---|---|
| "填报日期"有值 | 取"填报日期" |
| "填报日期"为空 | 取 `created_time` **+8h** 后的日期部分（北京时间） |

> **时区修复**：FlowUs API 返回的 `created_time` 是 UTC 时间。凌晨创建的记录 UTC 日期是前一天，直接取日期部分会导致误判。必须先 `+8h` 转换为北京时间再取日期。

## 不复制的字段

实际投入（小时）、开始时间、结束时间、No. 等字段均不设置。

## 与 CLI 版本对比

| 对比项 | CLI 版本（add-template） | MCP 版本（add-template-mcp） |
|---|---|---|
| 查询方式 | FlowUs CLI + Node.js 脚本分页 | MCP `query_database` + 助手循环分页 |
| 创建方式 | Node.js 脚本 + CLI（串行） | MCP `create_page`（并行） |
| 反向关联 | Node.js 脚本自动补建 | 助手调用 `update_page` 补建 |
| 临时文件 | 需要 body 文件 | 不需要（MCP 直接传参） |
| 解析方式 | Node.js 脚本 | 助手在上下文中直接解析 |
| 预计工具调用 | ~2 次（Skill + 1次 Shell 脚本） | 多轮（查询分页 + 并行创建 + 反向关联） |

## 注意事项

- **MCP 认证问题**：MCP 服务器返回空 `[]` 时，可能是认证 token 过期。MCP 服务器的认证由 TRAE 内部管理，与 CLI 的 OAuth 凭证（`~/.flowus/credentials.json`）独立。如果 MCP 持续返回空结果：
  1. 检查 `get_current_user` 是否返回空 — 若空则 MCP 认证失效
  2. 尝试设置 `FLOWUS_TOKEN` 环境变量为有效的 OAuth access token，然后重启 TRAE
  3. 如仍无效，回退到 CLI 版本（`0-添加模版（CLI）` 技能）
- `填报日期` 的 `date` 属性需要包含 `end: null` 和 `time_zone: null`
- **工具命名规则**：MCP 使用小写下划线命名（`query_database`、`create_page`、`update_page`、`get_page`）
- **参数结构差异**：`query_database` 的 `page_size`、`start_cursor` 是顶层参数，`create_page` / `update_page` 的所有参数都在 `body` 内
- **分页查询**：`has_more` 为 true 时用 `next_cursor` 作为 `start_cursor` 继续查询，确保获取全部数据后再做 HAS_DATA 检查
- **FlowUs API 删除字段**：使用 `in_trash: true`（不是 `archived: true`）将记录移到回收站。MCP 的 `update_page` 不支持此字段，需用 CLI 执行删除
- **MCP `update_page` 限制**：body 只接受 `icon`、`cover`、`properties` 三个字段，不支持 `in_trash`、`archived` 等顶层字段
