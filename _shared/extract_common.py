"""
周报 / 月报数据提取的公共模块（2026-09-25 从 extract_week.py / extract_month.py 抽取）

为什么抽出来：两个脚本除「入口文件名、参数解析方式、默认输出文件名、查询体文件名、末尾打印格式」
以外逻辑完全一致，过去要改两处。现在公共逻辑集中在本文件，两个入口只做各自的参数解析与打印。

- 入口文件仍保留两个名字（extract_week.py / extract_month.py），因为技能要靠名字区分周报与月报。
- 本文件位于技能根目录下的 _shared/，两个技能目录都从 ../_shared 引入。
- 添加新成员请改本文件的 USER_MAP（不再在 extract_week.py 里改）。

认证策略见下方「认证策略」段：默认不碰 FLOWUS_TOKEN，只有 CLI 明确报「缺少 token」才兜底一次。
"""
import json, subprocess, sys, os
from collections import defaultdict

FLOWUS = r"C:\Users\HONOR\AppData\Local\Programs\FlowUs\bin\flowus.exe"
DB_ID = "1a9c4392-b5ae-48f4-aa3b-e05135215dce"

# 注意：SCRIPT_DIR 已移除——本模块在 _shared/ 下，__file__ 不是调用方目录。
# 查询体文件与默认输出路径一律由调用方通过 script_dir 参数传入。


import json, subprocess, sys, os
from collections import defaultdict

FLOWUS = r"C:\Users\HONOR\AppData\Local\Programs\FlowUs\bin\flowus.exe"
DB_ID = "1a9c4392-b5ae-48f4-aa3b-e05135215dce"


# ============================================================================
# 认证策略：不固化身份，只在"CLI 自己没法认证"时才兜底一次
# ============================================================================
# 正常情况脚本**完全不碰 FLOWUS_TOKEN**——CLI 自己怎么认证（env 静态密钥 / OAuth /
# credentials.json，随调用方环境而定）就怎么认证，行为与改造前完全一致。
#
# 只有当 CLI 明确回报"缺少 token"时，才从 Windows 用户级注册表
# （HKCU\Environment\FLOWUS_TOKEN，静态密钥）读一次、注入当前进程并重试一次。
# 这一次重试是给「WorkBuddy 会话进程没继承环境变量」这个高频坑用的。
#
# 关闭兜底：设 FLOWUS_SKIP_TOKEN_FALLBACK=1 —— 脚本绝不读写 FLOWUS_TOKEN，
#           完全交给 CLI 自己的认证（TRAE 等自带认证的环境可用这个开关）。
# ❌ 任何情况下都不要执行 flowus.exe login / 不要读 ~/.flowus/credentials.json /
#    不要参照 TRAE 的 mcp.json 令牌——网页授权会重新签发令牌并作废同族旧令牌。
_TOKEN_FALLBACK_TRIED = False


def read_token_from_registry():
    """从 Windows 用户级注册表读 FLOWUS_TOKEN（进程内读，不落盘、不 spawn reg.exe）。"""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return (winreg.QueryValueEx(k, "FLOWUS_TOKEN")[0] or "").strip()
    except Exception:
        return ""


def token_fallback_enabled():
    """是否允许"缺 token 时兜底重试"。默认允许；FLOWUS_SKIP_TOKEN_FALLBACK=1 关闭。"""
    v = (os.environ.get("FLOWUS_SKIP_TOKEN_FALLBACK") or "").strip().lower()
    return v not in ("1", "true", "yes", "on")


def is_missing_token_error(result):
    """判断 CLI 返回是否为"缺少 token"（区别于 unauthorized=令牌失效）。"""
    if not isinstance(result, dict) or result.get("ok") is not False:
        return False
    err = result.get("error") or {}
    msg = (err.get("message") or "").lower() if isinstance(err, dict) else ""
    return "missing flowus token" in msg or "set flowus_token" in msg


USER_MAP = {
    "7b8d78bb-6099-4aa4-8f10-e8dfab37197e": "后端 马少平",
    "050fae93-4c3e-4596-80f2-21c3fb100b07": "后端 周彦佐",
    "ac9b1b06-4ed3-49b3-a2e1-d594252d2b99": "后端 郑志伟",
    "1f0e0e61-dc10-4399-8074-b8e5f6e074a6": "接口 李明",
}
# FlowUs formula 完整映射（添加新成员时参考）:
# YooSee→项目经理 张威, Cold→后端 郑志伟, 马少平→后端 马少平
# 刘玉田/lyt→后端 刘玉田, 张严→后端 张严, 王震→技术组长 王震
# dongge/YuZhiDong→后端 余志东, 周彦佐→后端 周彦佐, 魏文刚→项目经理 魏文刚
# 哆啦A梦→接口 杨斌, 李明→接口 李明, 任涛→后端 任涛
# qxf→前端 强小峰, Mi Manchi→后端 方祥, 王昊→顾问 王昊
# 马帅→前端 马承帅, Sherry→test

def get_prop(props, name, ptype):
    p = props.get(name, {})
    if p is None:
        return "" if ptype != "number" else 0
    if ptype == "select":
        sel = p.get("select", {})
        return sel.get("name", "") if isinstance(sel, dict) else ""
    elif ptype == "number":
        return p.get("number", 0) or 0
    elif ptype == "date":
        d = p.get("date", {})
        return d.get("start", "") if isinstance(d, dict) else ""
    elif ptype == "rich_text":
        items = p.get("rich_text", [])
        return "".join(item.get("plain_text", "") for item in items if isinstance(item, dict))
    return ""

def _cli_json(method, path, body=None):
    """调用一次 FlowUs CLI 并解析 JSON（不做错误归类）。"""
    cmd = [FLOWUS, "--json", "api", "call", method, path]
    if body:
        cmd.extend(["--body", body])
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        raise RuntimeError(
            "FlowUs CLI 返回非 JSON 输出 (rc=%s)\nstdout: %s\nstderr: %s"
            % (r.returncode, (r.stdout or "")[:300], (r.stderr or "")[:300])
        )


def api_call(method, path, body=None):
    result = _cli_json(method, path, body)

    # 懒加载兜底：仅当 CLI 明确报"缺少 token"时，才读注册表注入并重试一次。
    # CLI 自己能认证的环境（如 TRAE 走自己的认证）永远不会走到这里，行为与改造前一致。
    global _TOKEN_FALLBACK_TRIED
    if (not _TOKEN_FALLBACK_TRIED) and is_missing_token_error(result):
        _TOKEN_FALLBACK_TRIED = True
        if token_fallback_enabled():
            tok = read_token_from_registry()
            if tok:
                os.environ["FLOWUS_TOKEN"] = tok  # flowus.exe 子进程继承
                print(f"[auth] CLI 报缺少 token，已从注册表读取 FLOWUS_TOKEN（长度 {len(tok)}）并重试一次")
                result = _cli_json(method, path, body)
            else:
                print("[auth] CLI 报缺少 token，且注册表 HKCU\\Environment 也没有 FLOWUS_TOKEN："
                      "不注入，交回 CLI 原始报错", file=sys.stderr)
        else:
            print("[auth] FLOWUS_SKIP_TOKEN_FALLBACK 已启用：跳过注册表兜底，交回 CLI 原始报错", file=sys.stderr)

    # 认证 / 权限失败必须显式报错，禁止伪装成"该日期无数据"
    if isinstance(result, dict) and result.get("ok") is False and "error" in result:
        err = result.get("error") or {}
        code = err.get("code", "unknown")
        msg = err.get("message", "")
        status = err.get("status", 0)
        low = (msg or "").lower()
        if "token" in low or code in ("local_error", "unauthorized"):
            hint = (
                "\n→ 归类：认证 / TOKEN 问题（CLI 自己没能认证，且「缺 token 兜底」已用过或已被关闭，详见上方 [auth] 行）"
                "\n  1) WorkBuddy 场景：确认 Windows 用户级环境变量 FLOWUS_TOKEN 已配置（40 字符静态密钥），"
                "注册表 HKCU\\Environment 里也要有同名值（会话未继承时靠它兜底）"
                "\n  2) CLI 自带认证的场景（如 TRAE）：不需要 FLOWUS_TOKEN，脚本只在 CLI 报缺 token 时才兜底，可设 "
                "FLOWUS_SKIP_TOKEN_FALLBACK=1 彻底关闭兜底"
                "\n  3) ❌ 禁止执行 flowus.exe login，禁止读取 ~/.flowus/credentials.json，"
                "也不要参照 TRAE 的 MCP 令牌配置（网页授权会重新签发令牌并作废同族旧令牌）"
            )
        elif status == 403:
            hint = "\n→ 归类：权限问题，检查 FlowUs 集成对该数据库的访问权限"
        else:
            hint = "\n→ 归类：其他 API 错误"
        raise RuntimeError("FlowUs API 调用失败 [%s] %s%s" % (code, msg, hint))

    if "data" in result:
        return result["data"]
    return result



# ============================================================================
# 公共取数流程：分页查询 -> 解析记录 -> 写文件 -> 汇总统计
# ============================================================================
def run(start_date, end_date, script_dir, query_body_name, output_file, empty_hint="该日期范围"):
    """按日期范围取日报数据并落盘。

    start_date / end_date : API 要求的斜杠格式 YYYY/MM/DD
    script_dir            : 调用方技能目录（用于定位 q_*.json 与默认输出）
    query_body_name       : 查询体临时文件名（q_week.json / q_month.json）
    output_file           : 输出 JSON 路径
    empty_hint            : 无数据时的提示文案（周报「该日期范围」/ 月报「该月份」）

    返回 dict：records_data / total_hours / total_days / person_hours / person_days / unknown_uids
    读取失败时抛 RuntimeError（由调用方决定如何提示，绝不伪装成"无数据"）。
    """
    # 认证：这里【不做】任何前置检查 / 不提早 exit —— 先让 CLI 自己认证（TRAE 等环境自带认证），
    # 仅当 CLI 报缺少 token 时，api_call 内部才用注册表里的 FLOWUS_TOKEN 兜底重试一次。

    # 分页查询
    all_results = []
    cursor = None
    while True:
        q = {
            "page_size": 100,
            "sorts": [{"property": "日期", "direction": "ascending"}],
            "filter": {
                "and": [
                    {"property": "日期", "date": {"on_or_after": start_date}},
                    {"property": "日期", "date": {"on_or_before": end_date}}
                ]
            }
        }
        if cursor:
            q["start_cursor"] = cursor
        body_path = os.path.join(script_dir, query_body_name)
        with open(body_path, "w", encoding="utf-8") as f:
            json.dump(q, f)
        resp = api_call("POST", f"/v2/databases/{DB_ID}/query", body_path)
        page_results = resp.get("results", [])
        all_results.extend(page_results)
        has_more = resp.get("has_more", False)
        cursor = resp.get("next_cursor")
        print(f"Fetched {len(page_results)} records (total: {len(all_results)}, has_more: {has_more})")
        if not has_more or not cursor:
            break

    results = all_results
    print(f"Records in range {start_date} to {end_date}: {len(results)}")
    if not results:
        print(f"ⓘ 本次查询成功（API 正常），{empty_hint}确实没有日报记录。")

    # 解析记录
    records_data = []
    for rec in results:
        props = rec.get("properties", {})
        date_str = get_prop(props, "日期", "date")
        if not date_str:
            continue
        parts = date_str.split("T")[0].split("/")
        rec_yr, rec_mo, dy = int(parts[0]), int(parts[1]), int(parts[2])

        uid = rec.get("created_by", {}).get("id", "") if isinstance(rec.get("created_by"), dict) else ""
        person = USER_MAP.get(uid, f"未知({uid[:8]})")

        projects = []
        total_hrs = 0
        for i in range(1, 4):
            proj = get_prop(props, f"项目-{i}", "select")
            task = get_prop(props, f"任务名称-{i}", "rich_text")
            hrs = get_prop(props, f"任务工时-{i}", "number")
            if proj:
                projects.append({"project": proj, "task": task, "hours": hrs})
                total_hrs += hrs

        ops_task = get_prop(props, "运维工作", "select")
        ops_hrs = get_prop(props, "运维工时", "number")
        if ops_task:
            projects.append({"project": "运维", "task": ops_task, "hours": ops_hrs})
            total_hrs += ops_hrs

        records_data.append({
            "date": f"{rec_mo}月{dy}日",
            "date_raw": date_str,
            "yr": rec_yr, "mo": rec_mo, "dy": dy,
            "person": person,
            "total_hrs": total_hrs,
            "projects": projects,
            "summary": get_prop(props, "工作简述", "rich_text"),
            "progress1": get_prop(props, "进展说明-1", "rich_text"),
            "progress2": get_prop(props, "进展说明-2", "rich_text"),
            "progress3": get_prop(props, "进展说明-3", "rich_text"),
            "plan": get_prop(props, "明日计划", "rich_text"),
        })

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(records_data, f, ensure_ascii=False, indent=2)

    # 未映射人员检查
    unknown_uids = set()
    for rec in results:
        uid = rec.get("created_by", {}).get("id", "") if isinstance(rec.get("created_by"), dict) else ""
        if uid and uid not in USER_MAP:
            unknown_uids.add(uid)

    if unknown_uids:
        print("\n" + "=" * 60)
        print("WARNING: Found unmapped persons! Update USER_MAP(_shared/extract_common.py) before generating report!")
        for uid in unknown_uids:
            print(f"  uid: {uid}")
        print("=" * 60)
    else:
        print("\nAll persons mapped correctly.")

    # 汇总统计
    person_hours = defaultdict(float)
    person_days = defaultdict(set)
    for r in records_data:
        person_hours[r["person"]] += r["total_hrs"]
        person_days[r["person"]].add(r["date"])
    total_hours = sum(person_hours.values())
    total_days = len(set(r["date"] for r in records_data))

    return {
        "records_data": records_data,
        "total_hours": total_hours,
        "total_days": total_days,
        "person_hours": person_hours,
        "person_days": person_days,
        "unknown_uids": unknown_uids,
    }
