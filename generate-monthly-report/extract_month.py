"""
月报数据提取脚本（参数化）
用法:
  python extract_month.py <YYYY-MM> [output_file]
  python extract_month.py <YYYY-MM-DD> <YYYY-MM-DD> [output_file]
示例:
  python extract_month.py 2026-07
  python extract_month.py 2026-07-15 2026-08-15

⚠️ 公共逻辑（API 调用 / 认证兜底 / 记录解析 / 汇总统计 / USER_MAP）已抽取到
   ../_shared/extract_common.py —— 本文件只保留月报特有的参数解析（月份模式 / 范围模式）与打印格式。
   添加新成员请改 _shared/extract_common.py 的 USER_MAP，不要改本文件。
"""
import os, sys, calendar

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "_shared"))
from extract_common import run

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python extract_month.py <YYYY-MM> [output_file]")
        print("      python extract_month.py <YYYY-MM-DD> <YYYY-MM-DD> [output_file]")
        sys.exit(1)

    # 认证：这里【不做】任何前置检查 / 不提早 exit —— 先让 CLI 自己认证（TRAE 等环境自带认证），
    # 仅当 CLI 报缺少 token 时，extract_common 内部才用注册表里的 FLOWUS_TOKEN 兜底重试一次。
    # TRAE 走浏览器认证令牌、WorkBuddy 走 FLOWUS_TOKEN，两套互不干扰，不要互相顶替。

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

    try:
        res = run(
            start_date, end_date,
            script_dir=SCRIPT_DIR,
            query_body_name="q_month.json",
            output_file=output_file,
            empty_hint="该月份",
        )
    except RuntimeError as e:
        print("=" * 60, file=sys.stderr)
        print("✖ 数据读取失败 —— 这【不是】“该月份无数据”，请先修认证后再重跑！", file=sys.stderr)
        print(str(e), file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        sys.exit(2)

    records = res["records_data"]
    total_hours = res["total_hours"]
    total_days = res["total_days"]
    person_hours = res["person_hours"]
    person_days = res["person_days"]

    print(f"\n=== 月报数据 ({len(records)}条记录, {total_hours}h, {total_days}天) ===")
    for person in sorted(person_hours.keys()):
        print(f"  {person}: {person_hours[person]}h, {len(person_days[person])}天")
    print(f"\n总计: {total_hours}h, {len(records)}条记录, {total_days}个工作日")
    print(f"Data saved to: {output_file}")
