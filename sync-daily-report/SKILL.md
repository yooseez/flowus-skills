---
name: "0-同步日报"
description: "获取日报工时并回填到 FlowUs 模版。支持昨天/前天/上周五/8月21日等日期。Invoke when user says '同步日报' or clicks this skill."
---

# 0-同步日报

将指定日期的日报工时按"人员+项目"匹配写入当天模版的"实际投入（小时）"字段。

## 执行步骤

### 1. 提取日期参数
从用户输入中提取日期表达式（原文即可，不用计算），例如：
- 无日期 → 传空字符串（默认昨天；若昨天是周末，自动回溯到上周五）
- "昨天"、"前天"、"今天"
- "上周一" ~ "上周日"
- "8月21日"、"8月21"
- "2026-08-21"

### 2. 运行脚本

```
node "c:\Users\HONOR\.trae-cn\skills\sync-daily-report\sync_report.js" <日期表达式> 2>&1
```

脚本会自动解析日期、查询数据、匹配分析、判定模式，必要时自动写入。

**退出码非 0 或出现 `❌ 读取失败` → 这是认证/API 故障，见下文「读取失败会自动诊断」，不要当成"无数据"。**

### 3. 根据输出中的"模式"分支

**脚本输出中找"模式: auto"还是"模式: confirm"：**

- **auto（自动写入）**：找到脚本输出的 `===== 明细表（自动写入模式 · 仅展示） =====` 开始的 Markdown 表格，**原样贴到对话中**。表格上方加一句"已自动写入完成"即可。

- **confirm（需人工确认）**：不要贴明细表。启动确认页面：
  ```
  node "c:\Users\HONOR\.trae-cn\skills\sync-daily-report\server.js" <目标日期>
  ```
  目标日期从脚本输出第一行"目标日期: XXXX-XX-XX"获取。
  若 8790 端口被占用，先停掉旧进程再启动。
  用 present_files 打开 `http://localhost:8790`，告知用户在页面上操作。

## ⚠️ 强制确认规则：任一人当日总工时 ≠ 8 小时

汇总行中的「不等于8小时」筛的是**每人当日日报总工时 ≠ 8 小时**（不足 **或超过**）：

- 只要有一人合计 ≠ 8h（例如 2.5h+5.5h=8h 正常；但 3h+5h=8h 正常，**6h+10h=16h 这类异常累加会命中**），模式强制为 **confirm**，生成确认页面人工核对，**绝不自动写入**。
- 判定带 1e-9 容差，2.5h+5.5h 这类浮点累加不会误判。
- confirm 模式下脚本不会写任何数据；必须走确认页面人工提交。

## ⚠️ 读取失败会自动诊断（不再静默返回 0 条）

`sync_report.js` / `server.js` 已内置错误判定：**API 调用失败不再伪装成"该日期无数据"**，而是打印诊断块并以**退出码 2** 结束（未做任何写入）。

### 怎么读输出

- **出现 `❌ 读取失败：…` 或退出码为 2** → 这是**认证 / API 故障**，禁止判定为"无数据"，也不要继续执行后续步骤。把整段诊断**原样转述给用户**（诊断里已含 TOKEN 排查步骤）。
  - 诊断输出在 **stderr**，运行脚本时务必用 `2>&1` 捕获
  - 会自动归类：`认证 / TOKEN 问题`、`权限问题（缺数据库权限）`、`其他 API 错误`
- **出现 `ⓘ 本次查询成功（API 正常），该日期确实没有日报/模版记录。`** → 查询本身成功，**是真的没有数据**（周末、节假日等），照常按"模式"分支处理即可
- **启动 `server.js` 时认证失败** → 同样打印诊断并以退出码 2 结束，**不会拉起页面**，不要误判成端口问题

### 自测方法（验证诊断是否生效）

```
FLOWUS_TOKEN=INVALID node "c:\Users\HONOR\.trae-cn\skills\sync-daily-report\sync_report.js" 2026-09-09
```
预期：输出 `类型: 认证 / TOKEN 问题` + `代码: unauthorized`，退出码 2。

### 凭证要点（本项目已定）

- 脚本**唯一**使用 Windows **用户级环境变量** `FLOWUS_TOKEN`（静态密钥，bot `trae2`，含 databases/pages 读写权限）。脚本**不对它做任何删除或改写**。
- `C:\Users\HONOR\.flowus\credentials.json` 即使存在也**不影响**本脚本——实测**环境变量 token 优先级高于凭证文件**（文件内为有效令牌时，doctor 仍报 `tokenSource: env`）。
- **⛔ 禁止运行 `flowus.exe login`**：网页授权会重新签发令牌并**作废同族旧令牌**（TRAE 侧 MCP 令牌就是这么失效的）。本项目固定走静态密钥，任何时候都不需要它。

### TOKEN 问题处理

- `local_error` / `Missing FlowUs token. Pass --token or set FLOWUS_TOKEN.` → 用户级环境变量**丢失**，重新设置（值取自 FlowUs 开发者中心的外部应用密钥）
- `unauthorized` / HTTP 401（`Invalid or expired token`、`Authorization header format must be: Bearer <token>`）→ 密钥**已失效或被撤销**，重新获取并更新该环境变量
- HTTP 403 / 含 `permission` → FlowUs 集成缺少数据库权限，需在 FlowUs 中为集成补权限
- 诊断命令：`flowus.exe doctor`（看 `authMode` / `tokenSource` / `authenticated`）、`flowus.exe whoami`（看身份与 capabilities）
- 期望状态：`authenticated: true` / `authMode: static` / `tokenSource: env` / `user.name: trae2`

## 维护

- 人员映射 USER_MAP、项目别名 PROJECT_ALIAS 在 `sync_report.js` 中维护
- 数据库 ID、字段名等也在脚本中
