"""
周报数据提取脚本（参数化）
用法: python extract_week.py <start_date> <end_date> [output_file]
示例: python extract_week.py 2026/08/03 2026/08/07
      python extract_week.py 2026-08-03 2026-08-07

⚠️ 公共逻辑（API 调用 / 认证兜底 / 记录解析 / 汇总统计 / USER_MAP）已抽取到
   ../_shared/extract_common.py —— 本文件只保留周报特有的参数解析与打印格式。
   添加新成员请改 _shared/extract_common.py 的 USER_MAP，不要改本文件。
"""
import os, sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "_shared"))
from extract_common import run

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python extract_week.py <start_date YYYY/MM/DD> <end_date YYYY/MM/DD> [output_file]")
        sys.exit(1)

    # 认证：这里【不做】任何前置检查 / 不提早 exit —— 先让 CLI 自己认证（TRAE 等环境自带认证），
    # 仅当 CLI 报缺少 token 时，extract_common 内部才用注册表里的 FLOWUS_TOKEN 兜底重试一次。
    # TRAE 走浏览器认证令牌、WorkBuddy 走 FLOWUS_TOKEN，两套互不干扰，不要互相顶替。

    # 兼容连字符格式（2026-08-03）与斜杠格式（2026/08/03），API 要求斜杠格式
    def to_slash(d):
        return d.replace("-", "/")

    start_date = to_slash(sys.argv[1])
    end_date = to_slash(sys.argv[2])
    output_file = sys.argv[3] if len(sys.argv) > 3 else os.path.join(SCRIPT_DIR, "week_data.json")

    try:
        res = run(
            start_date, end_date,
            script_dir=SCRIPT_DIR,
            query_body_name="q_week.json",
            output_file=output_file,
            empty_hint="该日期范围",
        )
    except RuntimeError as e:
        print("=" * 60, file=sys.stderr)
        print("✖ 数据读取失败 —— 这【不是】“该日期无数据”，请先修认证后再重跑！", file=sys.stderr)
        print(str(e), file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        sys.exit(2)

    records = res["records_data"]
    total_hours = res["total_hours"]
    total_days = res["total_days"]

    print(f"\n=== 周报数据 ({len(records)}条记录, {total_hours}h, {total_days}天) ===")
    for r in records:
        proj_names = [f"{p['project']}({p['hours']}h)" for p in r["projects"]]
        print(f"  {r['date']} {r['person']} {r['total_hrs']}h | {', '.join(proj_names)}")
    print(f"\n总计: {total_hours}h, {len(records)}条记录, {total_days}个工作日")
    print(f"Data saved to: {output_file}")
