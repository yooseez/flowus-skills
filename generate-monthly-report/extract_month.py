"""
月报数据提取脚本（参数化）
用法:
  python extract_month.py <YYYY-MM> [output_file]
  python extract_month.py <YYYY-MM-DD> <YYYY-MM-DD> [output_file]
示例:
  python extract_month.py 2026-07
  python extract_month.py 2026-07-15 2026-08-15
"""
import json, subprocess, sys, os, calendar
from collections import defaultdict

FLOWUS = r"C:\Users\HONOR\AppData\Local\Programs\FlowUs\bin\flowus.exe"
DB_ID = "1a9c4392-b5ae-48f4-aa3b-e05135215dce"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

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

def api_call(method, path, body=None):
    cmd = [FLOWUS, "--json", "api", "call", method, path]
    if body:
        cmd.extend(["--body", body])
    r = subprocess.run(cmd, capture_output=True, text=True)
    result = json.loads(r.stdout)
    if "data" in result:
        return result["data"]
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python extract_month.py <YYYY-MM> [output_file]")
        print("      python extract_month.py <YYYY-MM-DD> <YYYY-MM-DD> [output_file]")
        sys.exit(1)

    args = sys.argv[1:]
    is_range_mode = (
        len(args) >= 2
        and len(args[0].split("-")) == 3
        and len(args[1].split("-")) == 3
    )

    if is_range_mode:
        # 自定义日期范围模式: <YYYY-MM-DD> <YYYY-MM-DD> [output_file]
        sy, sm, sd = args[0].split("-")
        ey, em, ed = args[1].split("-")
        start_date = f"{sy}/{sm}/{sd}"
        end_date = f"{ey}/{em}/{ed}"
        output_file = args[2] if len(args) > 2 else os.path.join(SCRIPT_DIR, "month_data.json")
        print(f"Date range mode: {start_date} to {end_date}")
    else:
        month_str = args[0]  # e.g. "2026-07"
        yr_str, mo_str = month_str.split("-")
        yr, mo = int(yr_str), int(mo_str)
        last_day = calendar.monthrange(yr, mo)[1]

        start_date = f"{yr}/{mo_str}/01"
        end_date = f"{yr}/{mo_str}/{last_day:02d}"
        output_file = args[1] if len(args) > 1 else os.path.join(SCRIPT_DIR, "month_data.json")

    # Paginated query
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
        body_path = os.path.join(SCRIPT_DIR, "q_month.json")
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

    # Check for unmapped persons
    unknown_uids = set()
    for rec in results:
        uid = rec.get("created_by", {}).get("id", "") if isinstance(rec.get("created_by"), dict) else ""
        if uid and uid not in USER_MAP:
            unknown_uids.add(uid)

    if unknown_uids:
        print("\n" + "=" * 60)
        print("WARNING: Found unmapped persons! Update USER_MAP before generating report!")
        for uid in unknown_uids:
            print(f"  uid: {uid}")
        print("=" * 60)
    else:
        print("\nAll persons mapped correctly.")

    # Stats
    person_hours = defaultdict(float)
    person_days = defaultdict(set)
    for r in records_data:
        person_hours[r["person"]] += r["total_hrs"]
        person_days[r["person"]].add(r["date"])
    total_hours = sum(person_hours.values())
    total_days = len(set(r["date"] for r in records_data))

    print(f"\n=== 月报数据 ({len(records_data)}条记录, {total_hours}h, {total_days}天) ===")
    for person in sorted(person_hours.keys()):
        print(f"  {person}: {person_hours[person]}h, {len(person_days[person])}天")
    print(f"\n总计: {total_hours}h, {len(records_data)}条记录, {total_days}个工作日")
    print(f"Data saved to: {output_file}")
