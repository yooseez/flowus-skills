#!/usr/bin/env node
// notify_missing.js —— 日报「缺报」检测 + 企微群机器人通知（独立小工具，不改动 sync_report.js / server.js 的行为）
//
// 判定口径
//   名册 = 谁该交日报（排除张威）
//   名册来源（2026-09-22 用户定稿，二次修订）：**默认取「上一次有人填报的那天」的填报人**，
//   也就是"对比上一天填报的人"。理由：大部分时候前后两天参与的人是同一批；个别人某天确实
//   没参与项目，被点到也无妨（提醒正文已加"当日确未参与可忽略"一句）。
//   关键好处：这个口径**不依赖"当天必须先有模版"**，所以将来改成「填报时才创建模版」也不会
//   塌缩成"名册＝已交的人 → 缺报永远是 0 人"（2026-09-22 识别出的硬伤）。
//   填报证据 = 日报表有条目 **或** 模版表当天「实际投入（小时）」>0（兼容新旧两种填报方式）。
//   其它口径：--roster-from=template（旧：当天模版优先、无则回退最近一次）
//             --roster-from=fixed --roster-names=甲,乙（写死名单）
//   缺报 = 名册中当日没有任何填报证据的人。
//   ⚠️ 注意与同步脚本里的「仅模版」状态区分：那是"有模版行但没填工时"，不等于人没交日报。
//
// 用法
//   node notify_missing.js                        # 检测「上一个工作日」（默认，定时任务用这个）
//   node notify_missing.js 昨天                   # 检测昨天（不判断是否工作日）
//   node notify_missing.js 2026-09-21 --webhook=URL
//
// ⚠️ 目标日期（2026-09-22 用户两次确认，勿再改）：**默认＝上一个工作日**——从今天往前找最近的
//    工作日（跳过周末 + 2026 年法定节假日），且定时任务要「每天执行」，由脚本自己判断该日是不是
//    工作日，不是就跳过。原因：大家是第二天才填日报，甚至周一才补周五的 —— 所以周二早上催的是
//    周一的日报，**周一早上催的是上周五的日报**。不要在定时任务里用「周一至周五」的排期代替这个判断。
//    ⚠️ 用户口中的"前一天 / 前一天的日报"就是指**上一个工作日**，不是字面 -1 天：
//       不要把 prevWorkday 改成 shiftDate(today, -1)，否则周一（前一天＝周日）会被非工作日护栏
//       静默跳过，上周五的日报就再也没人催了（2026-09-22 已踩过这个坑）。
//
// ⛔ 钉钉通道已移除（2026-09-23 用户定稿）：--webhook / --secret / --keyword / --at / --at-userid / --at-all
//    不再有对应实现（参数被解析但被忽略）。历史上这些参数走钉钉自定义机器人，从未投产。
//
// 其他
//   --roster-recent=7   名册额外并入近 7 天填报过的人（默认口径已覆盖，一般用不到）
//   --roster-from=last-filled|template|fixed
//                       名册口径（默认 last-filled＝上一次有人填报那天的填报人）：
//                         last-filled  上一次有人填报的那天，用那天的填报人做名册（推荐，不依赖当天模版）
//                         template     旧口径：当天模版优先、当天没有则回退最近一次有模版的日期
//                         fixed        写死名单，配合 --roster-names=甲,乙 使用
//   --roster-names=甲,乙 仅 --roster-from=fixed 时生效，逗号分隔
//   --force             名册为空（找不到任何模版记录）时也照常推送（默认不推）
//   --always            当天「无缺报」时也推送一条确认（默认不推，避免每日一条噪音）
//   --push              采用配置文件中已保存的通道推送（**不带它时一律只检测不推送**）
//   --json              额外输出机器可读 JSON
//
// ⛔ 企微「自建应用消息」通道已移除（2026-09-23 用户定稿）：--wx-work / --wx-test / --wx-corpid /
//    --wx-agentid / --wx-secret / --wx-touser 不再有对应实现。该通道受「企业可信IP」限制，从未投产；
//    实际投产后一直走下面的「群机器人」通道（不校验可信IP）。
//   ⚠️ 消息格式（2026-09-22 实测）：**个人微信（微信插件）只渲染 text 类型**，markdown 会显示
//      「暂不支持此类型，单击前往企业微信查看」。因此默认按 **text** 发送；--wx-md 才用 markdown。
//   --wx-md        用 markdown 格式发送（默认 text；仅当收件人全在企微 App 里时才值得用）
//   --config=D:\path\wxwork.json  指定配置文件
// 凭据读取顺序：命令行(--wx-*) → 环境变量 → <脚本目录>\wxwork.json → %USERPROFILE%\.workbuddy\wxwork.json
//   ⚠️ wxwork.json 含密钥，切勿提交到 git / 发到群里。
//
// 企业微信「群机器人」通道（⭐ 推荐：不校验可信IP，无需 access_token，无需回调URL）
//   --wx-robot=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
//       ⚠️ 入口已改名：「群机器人」自企微 **v4.1.41** 起叫「消息推送」。
//       电脑端：内部群聊 → 右上角「…」→「消息推送」→ 添加；手机端：内部群聊 → 右上角三点 →「消息推送」→ 添加。
//       仅**内部群**可用；Webhook 只有创建人可见（点对应「消息推送」→ Webhook 地址）。
//       群消息会同步到「微信插件」，因此成员在**个人微信**里照样收到（官方帮助中心：会话消息与微信插件互通）；
//       但**微信插件只渲染 text 类型**，markdown / 图文 / 文件会显示「暂不支持此类型，单击前往企业微信查看」→ 故本脚本默认 text。
//       前提：管理后台 → 我的企业 → 微信插件 → 勾选「允许成员在微信插件中接收和回复聊天消息」。
//   --wx-at=userid1,userid2        群内 @ 指定企微 userid（可选）
//   --wx-at-mobile=138xxxx,139xxxx 群内 @ 指定手机号（可选，非群成员会被脱敏）
//   与已移除的自建应用消息通道的区别：那条走 access_token（需可信IP），本通道走群机器人 Webhook（无需可信IP）。
//   配置文件字段：robotwebhook / runlogwebhook / userWebhooks / wxat / wxatmobile
//
// ⭐「一人一群」定向推送（2026-09-22 用户选定：让已交日报的人不被骚扰）
//   原理：群机器人**不校验可信IP**，但消息会落到群里所有成员 —— 那只要让每个群只装一个人，
//         效果就等于私聊。企微不支持只放自己的群，所以每个专属群＝「你 + 他」2 人内部群。
//   做法：给每位成员单独建一个 2 人群 → 各添加一个「消息推送」→ 把 Webhook 填进
//         wxwork.json 的 userWebhooks（姓名 → Webhook）。脚本按缺报名单**只发给他本人的群**。
//   配置示例（wxwork.json）：
//     "userWebhooks": {
//       "马少平": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
//       "郑志伟": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=yyy"
//     }
//   定向消息正文更简短（不含别人的名字/统计），形如「XXX，你的日报还没提交」。
//   兜底：没配专属群的缺报者仍走大群广播（robotwebhook）；**所有人都配了专属群时不再发大群**。
//   验证单个专属群：--wx-user-test=马少平
//   （也可用 --wx-user-hooks='{"姓名":"URL"}' 或环境变量 WXWORK_USER_WEBHOOKS 临时覆盖）
//
// ⛔ --no-personal（2026-09-23 用户定稿：**测试专用开关**，日常定时任务不要带）
//   效果：**只发运行日志（日志群只有你自己），一律不向缺报者的个人专属群发消息**。
//   用途：验证脚本/取词/流程时，你可以完整地看到日志，同时又绝不会打扰到真人。
//   日志的「推送动作」行会写明「测试模式未发送（--no-personal）：XXX」，一眼能区分。
//   注意：它**不影响**日志群，也不影响 `--wx-user-test=姓名`（那个是你明确要求验证某人链路时才用的）。

const { spawnSync, spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const REPORT_DB = '1a9c4392-b5ae-48f4-aa3b-e05135215dce';
const TEMPLATE_DB = 'bc84d926-8df2-4662-9751-6a35e8761d14';
// 填报链接（2026-09-22 用户指定）：缺报提醒里给的地址＝日报填报表单，不是只读的日报表
const REPORT_URL = 'https://flowus.cn/form/7d685305-80d0-418f-bbac-2fff5bd6a784?code=J1JER7';
// 人工确认页（日报同步遇到「工时≠8h / 项目未匹配」时出的那个页面，由 server.js 提供）。
// ⚠️ 默认是 localhost，**只能在这台电脑上打开，手机微信里点不开**；要微信可点，需换成公网地址
//    ——用 --confirm-url=<URL>，或在 wxwork.json 里写 "confirmUrl": "https://xxx"（二选一即可）。
const CONFIRM_URL_DEFAULT = 'http://localhost:8790';
function confirmUrl() {
  let cfg = {};
  try { cfg = resolveWxWorkConfig() || {}; } catch (e) { /* 配置不可读就用默认值 */ }
  return String(flags['confirm-url'] || process.env.CONFIRM_URL || cfg.confirmUrl || CONFIRM_URL_DEFAULT);
}
const EXCLUDE = new Set(['张威']);

// 名册回退窗口（天）：向前最多回看这么多天找「上一次有人填报的日期」。
// 14 天足够跨过周末 + 长假，又不至于把早已退出的人捞回来。
const ROSTER_LOOKBACK = 14;

// 名册口径（2026-09-22 用户定稿）：默认 last-filled＝「上一次有人填报的那天」的填报人
const ROSTER_FROM_KINDS = ['last-filled', 'template', 'fixed'];
const DEFAULT_ROSTER_FROM = 'last-filled';

const USER_MAP = {
  "7b8d78bb-6099-4aa4-8f10-e8dfab37197e": "马少平",
  "050fae93-4c3e-4596-80f2-21c3fb100b07": "周彦佐",
  "ac9b1b06-4ed3-49b3-a2e1-d594252d2b99": "郑志伟",
  "1f0e0e61-dc10-4399-8074-b8e5f6e074a6": "李明",
  "94eb3da4-35cb-4a72-81b7-623ec15e649d": "张威",
};

// ===== 参数解析 =====
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
const dateExpr = positional.join(' ').trim();

// ===== 日期 =====
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}
function beijingToday() {
  // --today=YYYY-MM-DD：仅用于调试/演练（比如验证"周一回溯到周五"、"国庆后回溯到 9-30"），
  // 定时任务不要带这个参数。
  if (flags && /^\d{4}-\d{2}-\d{2}$/.test(String(flags.today || ''))) return String(flags.today);
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().split('T')[0];
}
const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dowOf(d) { return DOW_CN[new Date(d + 'T00:00:00Z').getUTCDay()]; }
// 相对日描述（2026-09-22 用户定稿）：今天 / 昨天 / 前天 / 本周X / 上周X / N天前。
// 用途：运行日志的「日报日期」与个人提醒的「你X的日报」——同一个词两处共用，避免一个说"昨天"、一个说"9-21"。
function relativeDayLabel(targetDate, base = beijingToday()) {
  const diff = Math.round((new Date(base + 'T00:00:00Z') - new Date(targetDate + 'T00:00:00Z')) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff < 0) return `${-diff}天后`;
  const dow = dowOf(targetDate).replace('周', '');   // 一 / 二 / … / 日
  // 以周一为一周起点
  const weekStartOf = (d) => {
    const w = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;   // 周一=0 … 周日=6
    return shiftDate(d, -w);
  };
  const wsT = weekStartOf(targetDate), wsB = weekStartOf(base);
  if (wsT === wsB) return `本周${dow}`;
  // 只在同一周（diff≤6）或紧邻上一周（diff≤7）时才说「本周X / 上周X」；
  // 跨长假（如国庆后 10-09 查 09-30，差 9 天）说「上周X」会误导，退回「N天前」。
  const weeks = Math.round((new Date(wsB + 'T00:00:00Z') - new Date(wsT + 'T00:00:00Z')) / 86400000 / 7);
  if (diff <= 7 && weeks === 1) return `上周${dow}`;
  return `${diff}天前`;
}

// ===== 工作日判定 =====
// 来源：《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，gov.cn 原文）。
// 本脚本每天执行，先判断「目标日期」是否为工作日，不是就跳过（2026-09-22 用户定稿）。
// 每年 11 月前后国务院发布次年安排后，需更新下面两组常量。
const HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-01-03',             // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06',             // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21',             // 端午
  '2026-09-25', '2026-09-26', '2026-09-27',             // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',             // 国庆
];
const WORKDAYS_2026 = [   // 调休需要上班的周末
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
];
const HOLIDAY_SET = new Set(HOLIDAYS_2026);
const WORKDAY_SET = new Set(WORKDAYS_2026);
function isWorkday(d) {
  if (WORKDAY_SET.has(d)) return true;
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !HOLIDAY_SET.has(d);
}
// 从 from 的前一天起往前找最近一个工作日（大家是第二天才填日报，甚至周一才补周五的）
function prevWorkday(from) {
  for (let i = 1; i <= 30; i++) {
    const d = shiftDate(from, -i);
    if (isWorkday(d)) return d;
  }
  return null;
}

function parseDateExpr(expr) {
  const today = beijingToday();
  const t = (expr || '').trim();
  // **默认（不给参数）= 上一个工作日**：大家是第二天才填日报，甚至周一才补周五的 ——
  // 所以周一早上要催的是**上周五**的日报，不能字面取 -1 天（周日）而被护栏静默跳过。
  // 定时任务每天跑，靠这条自己判断要不要催（2026-09-22 用户定稿）。
  if (!t || ['上一个工作日', '上一工作日', '最近工作日', 'auto'].includes(t)) {
    return prevWorkday(today) || today;
  }
  if (t === '今天') return today;
  if (t === '昨天') return shiftDate(today, -1);
  if (t === '前天') return shiftDate(today, -2);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const cn = /^(\d{1,2})月(\d{1,2})日$/.exec(t);
  if (cn) return `${today.slice(0, 4)}-${cn[1].padStart(2, '0')}-${cn[2].padStart(2, '0')}`;
  const wk = /^上周([一二三四五六日天])$/.exec(t);
  if (wk) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[wk[1]];
    const cur = new Date(today + 'T00:00:00Z').getUTCDay();
    let back = cur === 0 ? 7 : cur;            // 本周一
    back += (7 - (target === 0 ? 7 : target)); // 到上周目标日
    return shiftDate(today, -back);
  }
  throw new Error(`无法识别的日期表达式：${expr}（支持 缺省=上一个工作日 / 上一个工作日 / 今天 / 昨天 / 前天 / YYYY-MM-DD / X月X日 / 上周X）`);
}

// ===== FlowUs CLI =====
function classifyFailure(parsed) {
  const msg = JSON.stringify(parsed.error || parsed).toLowerCase();
  if (msg.includes('missing flowus token') || msg.includes('set flowus_token')) {
    return { code: 'missing_token', message: 'CLI 缺少 FLOWUS_TOKEN（当前会话未继承用户级环境变量）' };
  }
  if (msg.includes('unauthorized') || msg.includes('invalid_token') || msg.includes('expired')) {
    return { code: 'unauthorized', message: 'FLOWUS_TOKEN 已失效或无权限，请到 FlowUs 开发者中心重新签发' };
  }
  return { code: 'api_error', message: 'FlowUs API 调用失败：' + JSON.stringify(parsed.error || parsed).slice(0, 300) };
}

function callAPI(method, apiPath, body) {
  const args = ['--json', 'api', 'call', method, apiPath];
  if (body) {
    const p = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\notify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`;
    fs.writeFileSync(p, JSON.stringify(body));
    args.push('--body', p);
  }
  const r = spawnSync(CLI, args, { encoding: 'utf8', timeout: 30000 });
  const clean = (r.stdout || '').replace(/^\uFEFF/, '').replace(/^#<\s*CLIXML\s*/, '').split('\n<Objs')[0];
  let parsed = null;
  try { parsed = JSON.parse(clean); } catch (e) { /* fallthrough */ }
  if (!parsed || typeof parsed !== 'object') {
    parsed = { ok: false, error: { code: 'unparsable_output', message: '(CLI 无输出)' }, __cliStderr: (r.stderr || '').trim() };
  }
  return parsed;
}

function queryDB(dbId, filterBody) {
  let all = [];
  let cursor = null;
  while (true) {
    const body = { ...filterBody };
    if (cursor) body.start_cursor = cursor;
    const parsed = callAPI('POST', `/v2/databases/${dbId}/query`, body);
    if (!parsed.ok || !parsed.data) {
      const info = classifyFailure(parsed);
      const err = new Error(info.message);
      err.code = info.code;
      throw err;
    }
    all = all.concat(parsed.data.results);
    if (!parsed.data.has_more) break;
    cursor = parsed.data.next_cursor;
  }
  return all;
}

function getProp(props, name, ptype) {
  const p = props[name] || {};
  if (!p || p.type !== ptype) return ptype === 'number' ? 0 : '';
  if (ptype === 'select') { const s = p.select; return (s && typeof s === 'object') ? s.name : ''; }
  if (ptype === 'number') return p.number || 0;
  if (ptype === 'date') return p.date ? p.date.start : '';
  if (ptype === 'rich_text') return (p.rich_text || []).map(i => i.plain_text || '').join('');
  return '';
}
function getPersonName(uid) { return USER_MAP[uid] || `未知(${uid ? uid.slice(0, 8) : '无'})`; }
function getAutoDate(r) {
  const fillDate = r.properties['填报日期']?.date?.start;
  if (fillDate) return fillDate.includes('T') ? fillDate.split('T')[0].replace(/\//g, '-') : fillDate.replace(/\//g, '-');
  return new Date(new Date(r.created_time).getTime() + 8 * 3600 * 1000).toISOString().split('T')[0];
}
function normDate(s) {
  if (!s) return '';
  return String(s).split('T')[0].replace(/\//g, '-');
}
function fmtH(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); }

// ===== 核心检测 =====
// 名册口径 rosterFrom：
//   last-filled（默认）：用「上一次有人填报的那天」的填报人 —— 不依赖当天是否有模版
//   template（旧）    ：当天模版优先，没有则回退最近一次有模版的日期
//   fixed             ：写死名单
function detect(targetDate, rosterRecentDays, rosterFrom = DEFAULT_ROSTER_FROM, rosterNames = '') {
  const from = shiftDate(targetDate, -ROSTER_LOOKBACK);

  // 1. 日报表：取窗口内所有提交，按日期归集（谁、几条、几小时）
  const rpt = queryDB(REPORT_DB, {
    filter: { and: [
      { property: '日期', date: { on_or_after: from.replace(/-/g, '/') } },
      { property: '日期', date: { on_or_before: shiftDate(targetDate, 1).replace(/-/g, '/') } }
    ] },
    page_size: 100
  });

  const reportByDate = {};          // date -> { name -> { n, h } }
  for (const r of rpt) {
    const d = normDate(r.properties['日期']?.date?.start);
    if (!d || d > targetDate) continue;
    const person = getPersonName(r.created_by?.id || '');
    if (person.startsWith('未知')) continue;
    let n = 0, h = 0;
    for (let i = 1; i <= 3; i++) {
      const proj = getProp(r.properties, `项目-${i}`, 'select');
      const hrs = getProp(r.properties, `任务工时-${i}`, 'number');
      if (proj || hrs > 0) { n++; h += hrs; }
    }
    const opsTask = getProp(r.properties, '运维工作', 'select');
    const opsHrs = getProp(r.properties, '运维工时', 'number');
    if (opsTask) { n++; h += opsHrs; }
    reportByDate[d] = reportByDate[d] || {};
    reportByDate[d][person] = reportByDate[d][person] || { n: 0, h: 0 };
    reportByDate[d][person].n += n;
    reportByDate[d][person].h += h;
  }

  // 2. 模版表：窗口内记录 → 每条的负责人（经任务页关联）+ 当日小时数
  const tplRaw = queryDB(TEMPLATE_DB, {
    filter: { timestamp: 'created_time', created_time: { on_or_after: from } },
    page_size: 100
  });

  const taskOwnerCache = {};        // taskPageId -> 负责人（避免重复拉同一任务页）
  const tplRowsByDate = {};         // date -> rows（template 口径用）
  const tplHoursByDate = {};        // date -> { name -> hours }（填报证据用，仅计小时>0）
  for (const r of tplRaw) {
    const d = getAutoDate(r);
    if (!d || d > targetDate) continue;
    (tplRowsByDate[d] = tplRowsByDate[d] || []).push(r);
    const hrs = getProp(r.properties, '实际投入（小时）', 'number') || 0;
    if (hrs <= 0) continue;
    const tid = r.properties['任务名称']?.relation?.[0]?.id;
    if (!tid) continue;
    let owner = taskOwnerCache[tid];
    if (owner === undefined) {
      const tp = callAPI('GET', `/v2/pages/${tid}`, {});
      owner = (tp.ok && tp.data) ? (tp.data.properties['负责人']?.select?.name || '') : '';
      taskOwnerCache[tid] = owner;
    }
    if (!owner || EXCLUDE.has(owner)) continue;
    tplHoursByDate[d] = tplHoursByDate[d] || {};
    tplHoursByDate[d][owner] = (tplHoursByDate[d][owner] || 0) + hrs;
  }

  // 3. 合并「填报证据」：日报表有条目 或 模版表当日小时数>0（兼容新旧两种填报方式）
  const filledByDate = {};          // date -> Set(names)
  for (const d of new Set([...Object.keys(reportByDate), ...Object.keys(tplHoursByDate)])) {
    const s = new Set();
    for (const [p, v] of Object.entries(reportByDate[d] || {})) if (v.n > 0) s.add(p);
    for (const [p, h] of Object.entries(tplHoursByDate[d] || {})) if (h > 0) s.add(p);
    if (s.size) filledByDate[d] = s;
  }

  // 4. 名册
  let roster = new Set();
  let rosterBasisDate = null;
  let rosterBasisKind = rosterFrom;

  if (rosterFrom === 'fixed') {
    for (const n of String(rosterNames).split(/[,，]/).map(s => s.trim()).filter(Boolean)) {
      if (!EXCLUDE.has(n)) roster.add(n);
    }
  } else if (rosterFrom === 'template') {
    // 旧口径：当天模版优先，当天没有则回退最近一次有模版的日期（无论有没有填工时）
    const dates = Object.keys(tplRowsByDate).sort().reverse();
    rosterBasisDate = dates[0] || null;
    for (const r of tplRowsByDate[rosterBasisDate] || []) {
      const tid = r.properties['任务名称']?.relation?.[0]?.id;
      if (!tid) continue;
      let owner = taskOwnerCache[tid];
      if (owner === undefined) {
        const tp = callAPI('GET', `/v2/pages/${tid}`, {});
        owner = (tp.ok && tp.data) ? (tp.data.properties['负责人']?.select?.name || '') : '';
        taskOwnerCache[tid] = owner;
      }
      if (owner && !EXCLUDE.has(owner)) roster.add(owner);
    }
  } else {
    // 默认 last-filled：上一次「有人填报」的那天（严格早于目标日期），用那天的填报人
    const dates = Object.keys(filledByDate).filter(d => d < targetDate).sort().reverse();
    rosterBasisDate = dates[0] || null;
    if (rosterBasisDate) for (const p of filledByDate[rosterBasisDate]) if (!EXCLUDE.has(p)) roster.add(p);
    // 可选：并入近 N 天填报过的人
    if (rosterRecentDays > 0) {
      const since = shiftDate(targetDate, -rosterRecentDays);
      for (const d of Object.keys(filledByDate)) {
        if (d < since || d >= targetDate) continue;
        for (const p of filledByDate[d]) if (!EXCLUDE.has(p)) roster.add(p);
      }
    }
  }

  // 5. 对比：名册 − 当日有填报证据的人
  const submittedSet = filledByDate[targetDate] || new Set();
  const rosterList = [...roster].sort();
  const submitted = rosterList.filter(p => submittedSet.has(p));
  const missing = rosterList.filter(p => !submittedSet.has(p));
  const outsiders = [...submittedSet].filter(p => !roster.has(p)).sort();

  const dayReports = reportByDate[targetDate] || {};
  const reporterEntries = {};
  const reporterHours = {};
  for (const [p, v] of Object.entries(dayReports)) { reporterEntries[p] = v.n; reporterHours[p] = v.h; }
  // 只走模版表填报的人（新页面模式）也要在日志里显示小时数
  for (const [p, h] of Object.entries(tplHoursByDate[targetDate] || {})) {
    if (!(p in reporterHours)) { reporterHours[p] = h; reporterEntries[p] = reporterEntries[p] || 0; }
  }

  // 5b. 工时异常：已交但当日合计工时 ≠ 8h（对应日报同步里"非8小时→强制人工确认"的同一口径）
  //     目的：全员已交时，大群那条"运行完成"汇总里能顺带提示"还有需要人工核对的"。
  const EXPECTED_HOURS = 8;
  const hoursAnomaly = [];
  for (const p of submitted) {
    const h = reporterHours[p] || 0;
    if (Math.abs(h - EXPECTED_HOURS) > 1e-9) hoursAnomaly.push({ name: p, hours: h });
  }

  return {
    targetDate, dow: dowOf(targetDate),
    templateCount: (tplRowsByDate[targetDate] || []).length,
    rosterBasisKind, rosterBasisDate,
    rosterFallback: !!rosterBasisDate && rosterBasisDate !== targetDate,
    roster: rosterList, submitted, missing, outsiders,
    reporterEntries, reporterHours,
    hoursAnomaly, expectedHours: EXPECTED_HOURS,
  };
}

// ===== HTTP 发送（群机器人 Webhook 共用）=====
function postJSON(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8', 'Content-Length': body.length },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.write(body);
    req.end();
  });
}

// ===== 企业微信推送（成员用普通微信关注「微信插件」后，消息即落到个人微信）=====
function loadWxWorkConfig() {
  const cands = [];
  if (flags.config && flags.config !== true) cands.push(String(flags.config));
  cands.push(require('path').join(__dirname, 'wxwork.json'));
  if (process.env.USERPROFILE) cands.push(require('path').join(process.env.USERPROFILE, '.workbuddy', 'wxwork.json'));
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        cfg.__path = p;
        return cfg;
      }
    } catch (e) {
      console.error(`  ⚠️ 企微配置读取失败：${p} —— ${e.message}`);
    }
  }
  return { __path: null };
}
function resolveWxWorkConfig() {
  const file = loadWxWorkConfig();
  const pick = (flagVal, envKey, fileKey) => {
    if (flagVal !== undefined && flagVal !== true && flagVal !== '') return String(flagVal);
    if (process.env[envKey]) return String(process.env[envKey]);
    return file[fileKey] != null ? String(file[fileKey]) : '';
  };
  return {
    corpid: pick(flags['wx-corpid'], 'WXWORK_CORPID', 'corpid'),
    agentid: pick(flags['wx-agentid'], 'WXWORK_AGENTID', 'agentid'),
    secret: pick(flags['wx-secret'], 'WXWORK_SECRET', 'secret'),
    touser: pick(flags['wx-touser'], 'WXWORK_TOUSER', 'touser'),
    robotwebhook: pick(flags['wx-robot'], 'WXWORK_ROBOT_WEBHOOK', 'robotwebhook'),
    // 运行日志群（2026-09-22）：只有你自己 + yoosee 的小群，免打扰。
    // 每次运行结束都往这里发一条运行情况，用来确认「程序是否自行运行」+「结果有没有问题」。
    // 不单独配时，回退用 robotwebhook（若你把原来的机器人直接挪到了这个日志群，就不用另配）。
    runlogwebhook: pick(flags['wx-runlog'], 'WXWORK_RUNLOG_WEBHOOK', 'runlogwebhook'),
    // 确认页地址（2026-09-22）：手机微信里打不开 localhost，这里配公网「只读快照」地址
    confirmUrl: pick(flags['confirm-url'], 'CONFIRM_URL', 'confirmUrl'),
    wxat: pick(flags['wx-at'], 'WXWORK_AT', 'wxat'),
    wxatmobile: pick(flags['wx-at-mobile'], 'WXWORK_AT_MOBILE', 'wxatmobile'),
    // 「一人一群」映射：姓名 → 该人专属群的 Webhook（命令行/环境变量优先，其次配置文件）
    userWebhooks: (() => {
      const raw = (flags['wx-user-hooks'] && flags['wx-user-hooks'] !== true)
        ? String(flags['wx-user-hooks'])
        : (process.env.WXWORK_USER_WEBHOOKS || '');
      if (raw) {
        try {
          const o = JSON.parse(raw);
          if (o && typeof o === 'object' && !Array.isArray(o)) return o;
        } catch (e) {
          console.error('  ⚠️ --wx-user-hooks / WXWORK_USER_WEBHOOKS 不是合法 JSON，已忽略');
        }
      }
      const f = file.userWebhooks;
      return (f && typeof f === 'object' && !Array.isArray(f)) ? f : {};
    })(),
    __path: file.__path,
  };
}
function maskSecret(s) {
  const t = String(s || '');
  if (!t) return '(空)';
  return t.length <= 10 ? t.slice(0, 2) + '****' : t.slice(0, 4) + '****' + t.slice(-4);
}
function explainWxErr(parsed) {
  const m = {
    82001: '收件人不在应用「可见范围」内 —— 后台 → 应用管理 → 你的应用 → 可见范围，把成员勾上',
    81013: 'userid 或部门不存在 —— 到通讯录成员详情里核对「账号」',
    60020: '本机出口 IP 不在「企业可信IP」名单 —— 应用 → 开发者接口 → 企业可信IP',
    40056: 'agentid 无效 —— 要用应用详情页里的 AgentId（数字）',
    40014: 'access_token 无效，重试一次即可',
    45009: '接口调用超过限制',
  };
  return parsed && m[parsed.errcode] ? '  → ' + m[parsed.errcode] : '';
}
// ===== 运行日志（2026-09-22 用户定稿）=====
// 群「日报提醒运行日志」＝只有你自己 + yoosee 的小群，已设免打扰。
// **每次运行结束都发一条**（无论有缺报 / 无缺报 / 被护栏跳过），
// 用途有二：① 确认程序是否真的自行跑了；② 看运行结果有没有问题（缺报、工时异常、推送失败、被跳过的原因）。
// 状态判定（2026-09-22 用户定稿，2026-09-23 增补同步态）：
//   有缺报 / 有工时异常 / 推送失败 → 〓异常〓；全员已提交但日报同步有问题 → 〓同步异常〓；否则「正常」。
// 被护栏跳过（非工作日、名册为空）本身算正常，原因另行写在「跳过原因」行。
function runLogStatus(r, { failed = false } = {}) {
  const bad = failed || r.missing.length > 0 || (r.hoursAnomaly && r.hoursAnomaly.length > 0);
  return bad ? '〓异常〓' : '正常';
}
function buildRunLogText(r, { status = '', skipReason = '', actions = [], failed = false, appendConfirmUrl = false } = {}) {
  const nowBj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [];
  // 标题统一为「日报检查」（2026-09-23 用户定稿：原来叫「日报检查·运行日志」，太长）
  lines.push('【日报检查】');
  lines.push(status || runLogStatus(r, { failed }));
  lines.push(`运行：${nowBj.slice(5)}`);                       // 09-22 22:28（年份省略）
  // 「今天 / 昨天 / 前天 / 上周五…」按目标日期与今天的相对位置算，不再固定写星期几
  const dayLabel = relativeDayLabel(r.targetDate);
  lines.push(`日报日期：${r.targetDate.slice(5)} ${dayLabel}${isWorkday(r.targetDate) ? '' : '（非工作日）'}`);
  // 「基准」也用相对日（2026-09-22 用户定稿）：09-21 昨天 / 09-20 前天 / 09-18 上周五 / N天前
  const basisLabel = r.rosterBasisDate
    ? `${r.rosterBasisDate.slice(5)} ${relativeDayLabel(r.rosterBasisDate)}`
    : '无';
  lines.push(`预期 ${r.roster.length} 人（基准 ${basisLabel}）`);
  lines.push(`已提交 ${r.submitted.length} 人：${r.submitted.length ? r.submitted.join('、') : '无'}`);
  lines.push(`缺报 ${r.missing.length} 人：${r.missing.length ? r.missing.join('、') : '无'}`);
  const hasAnomaly = !!(r.hoursAnomaly && r.hoursAnomaly.length);
  lines.push(hasAnomaly
    ? `工时异常（≠${fmtH(r.expectedHours || 8)}h）：${r.hoursAnomaly.map(x => `${x.name} ${fmtH(x.hours)}h`).join('、')}`
    : '工时异常：无');
  if (r.outsiders && r.outsiders.length) lines.push(`名册外提交：${r.outsiders.join('、')}`);
  if (skipReason) lines.push(`跳过原因：${skipReason}`);
  if (actions.length) lines.push(actions.join('；'));
  // 确认页地址固定放最后一行（2026-09-22 用户定稿）：需要人工核对时才出现
  // —— 工时异常，或**全员已提交但日报同步有问题（待确认）**（2026-09-23 新增）。
  // **只有裸 URL、不带任何引导文字**（标题、冒号、"详情"这些都不要，用户看一眼就知道是链接）。
  // URL 由微信/企微自动识别成蓝色可点链接（text 消息不支持 markdown 的 [文字](链接)）。
  if (hasAnomaly || appendConfirmUrl) lines.push(confirmUrl());
  return lines.join('\n');
}
// ===== 「本次跳过」的日志（2026-09-23 用户定稿）=====
// 触发跳过的情形有二，都发同样四行的「〓跳过〓」日志，只在第四行说明理由：
//   ① 刚执行过：距上次运行不足 AUTO_MIN_GAP_SEC 秒（见 main 里的节流判定）
//   ② 已同步完成：该日日报在本次之前的运行里已写回模版表，不必再查再催
// 共同点：不查 FlowUs、不推送任何个人提醒，只在日志群留一条说明，
// 让你知道「自动那次确实触发了，但发现不必跑所以没重复催」。
// 文案固定四行，状态行用「〓跳过〓」。
function bjShort(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ').slice(5);
}
// tailLine：自定义第四行说明。省略时用「发现X已执行过…」默认文案。
async function sendSkipLog(lastTs, lastMode, { tailLine } = {}) {
  const defaultTail = `发现${bjShort(lastTs)}已执行过日报检查${lastMode === 'manual' ? '（手动）' : ''}，本次检查取消`;
  const text = [
    '【日报检查】',
    '〓跳过〓',
    `运行：${bjShort(Date.now())}`,
    tailLine || defaultTail,
  ].join('\n');
  const cfg = resolveWxWorkConfig();
  const url = cfg.runlogwebhook || cfg.robotwebhook;
  console.log('  ---- 运行日志正文（跳过）----');
  for (const ln of text.split('\n')) console.log(`  | ${ln}`);
  if (!url) {
    console.log('  ⓘ 未配置运行日志群 Webhook（runlogwebhook / robotwebhook），跳过日志未发出。');
    return null;
  }
  try {
    const res = await wxRobotSend(url, text, { format: 'text' });
    const ok = res.parsed && res.parsed.errcode === 0;
    if (ok) console.log('  ✅ 跳过日志已发到「日报提醒运行日志」群');
    else console.log(`  ❌ 跳过日志发送失败：${res.parsed ? res.parsed.errcode + ' ' + res.parsed.errmsg + explainWxErr(res.parsed) : 'HTTP ' + res.status + ' ' + res.raw.slice(0, 200)}`);
    return ok;
  } catch (e) {
    console.error(`  ❌ 跳过日志推送异常：${e.message}`);
    return false;
  }
}
async function sendRunLog(r, { status, skipReason, actions, failed = false, appendConfirmUrl = false }) {
  const cfg = resolveWxWorkConfig();
  const url = cfg.runlogwebhook || cfg.robotwebhook;
  if (!url) {
    console.log('  ⓘ 未配置运行日志群 Webhook（runlogwebhook / robotwebhook），跳过运行日志。');
    return null;   // null = 没配，不算失败
  }
  const text = buildRunLogText(r, { status, skipReason, actions, failed, appendConfirmUrl });
  console.log('  ---- 运行日志正文 ----');
  for (const ln of text.split('\n')) console.log(`  | ${ln}`);
  try {
    const res = await wxRobotSend(url, text, { format: 'text' });
    const ok = res.parsed && res.parsed.errcode === 0;
    if (ok) console.log('  ✅ 运行日志已发到「日报提醒运行日志」群');
    else console.log(`  ❌ 运行日志发送失败：${res.parsed ? res.parsed.errcode + ' ' + res.parsed.errmsg + explainWxErr(res.parsed) : 'HTTP ' + res.status + ' ' + res.raw.slice(0, 200)}`);
    return ok;
  } catch (e) {
    console.error(`  ❌ 运行日志推送异常：${e.message}`);
    return false;
  }
}
// ===== 全员已提交 → 自动执行「日报同步」（2026-09-23 用户定稿）=====
// 触发条件：本次是真实推送运行（过了"仅检测"那关）+ 缺报人数为 0 + 没加 --no-sync。
// sync_report.js 两种模式：
//   auto    = 模版全空且无问题 → 直接写入工时与备注，无需人工介入 → 日志写「全员已提交，日报已同步」
//   confirm = 模版已有数据或存在问题（工时≠8h / 找不到模版项 / 多条模版 / 有差异）→ 需人工在本机确认页核对
//             → 日志写「全员已提交，日报同步异常，……，待确认」+ 确认页地址，状态 〓同步异常〓
function runDailySync(targetDate) {
  const script = path.join(__dirname, 'sync_report.js');
  console.log(`\n  全员已提交 → 自动执行日报同步：sync_report.js ${targetDate}`);
  let r;
  try {
    r = spawnSync(process.execPath, [script, targetDate], { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    return { ok: false, error: `同步脚本启动失败：${e.message}` };
  }
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/^\uFEFF/, '');
  const line = (out.split('\n').find(l => l.trim().startsWith('[RESULT]')) || '').trim();
  const kv = {};
  for (const m of line.matchAll(/(\w+)=("[^"]*"|\S+)/g)) kv[m[1]] = m[2].replace(/^"|"$/g, '');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(__dirname, `fill_state_${targetDate}.json`), 'utf8')); } catch (e) { /* 读不到状态文件就只靠 RESULT 行 */ }
  if (!line && r.status !== 0) {
    return { ok: false, kv, state, error: `同步脚本退出码 ${r.status}`, tail: out.slice(-300) };
  }
  return { ok: true, kv, state, tail: out.slice(-300) };
}

// 把同步结果翻译成一行中文（写进运行日志）+ 是否需要人工确认
function summarizeSync(sync) {
  if (!sync.ok) return { text: `全员已提交，日报同步异常：${sync.error}`, needConfirm: true };
  const s = (sync.state && sync.state.summary) || {};
  const rows = (sync.state && sync.state.rows) || [];
  // 同一状态可能有多行（一人多条日报），去重后只报人名
  const namesOf = (st) => [...new Set(rows.filter(x => x.status === st).map(x => x.person).filter(Boolean))];
  const problems = [];
  const mentioned = new Set();   // 同一个人已在前面点过名就不再重复（如「工时≠8h」+「模版未写入」是同一人）
  const pushNames = (names, suffix) => {
    const uniq = names.filter(n => !mentioned.has(n));
    uniq.forEach(n => mentioned.add(n));
    if (uniq.length) problems.push(`${uniq.join('、')}${suffix}`);
  };
  // ① 填报工时≠8h：summary.notEightPersons 形如「郑志伟(46h)」
  for (const item of (s.notEightPersons || [])) {
    const m = /^(.+?)\(([\d.]+)h\)$/.exec(String(item));
    if (m) mentioned.add(m[1]);
    problems.push(m ? `${m[1]}填报不是8小时（${m[2]}h）` : `${item}填报不是8小时`);
  }
  // ② 仅日报（日报里有这个项目，模版里找不到对应项）
  pushNames(namesOf('report_only'), '找不到模版项');
  // ③ 模版已填工时但与日报对不上
  pushNames(namesOf('diff'), '模版工时与日报不一致');
  // ④ 一个项目匹配到多条模版
  pushNames(namesOf('multi'), '有多条模版项');
  // ⑤ 模版没有工时、且本次没被自动写入（auto 模式下这些行会被写入，所以只在 confirm 模式算问题）
  if (sync.kv && sync.kv.mode === 'confirm') pushNames(namesOf('pending'), '的模版工时未写入');
  // ⑥ 自动写入失败
  if (Number(s.autoFail) > 0) problems.push(`${s.autoFail} 条写入失败`);

  const needConfirm = problems.length > 0;
  const text = needConfirm
    ? `全员已提交，日报同步异常，${problems.join('，')}，待确认`
    : `全员已提交，日报已同步${Number(s.autoWritten) > 0 ? `（写入 ${s.autoWritten} 条）` : ''}`;
  return { text, needConfirm, problems };
}

// 需要人工确认时，保证本机确认页（默认 localhost:8790）跑着、且目标日期正确。
// - 已在跑且日期一致 → 不动；
// - 没在跑 → 后台起一个（detached，脱离本进程存活）；
// - 在跑但日期不对 → 换日期只能重启，会先结束占用该端口的 node 进程再起。
async function ensureConfirmServer(targetDate) {
  const url = confirmUrl();
  let port = '80';
  try { port = (new URL(url)).port || '80'; } catch (e) { /* 地址异常就用默认端口 */ }
  const isLocal = /localhost|127\.0\.0\.1/i.test(url);
  if (!isLocal) return '公网地址，无需本机服务';
  let running = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/state`, { signal: ctl.signal });
    clearTimeout(t);
    running = await res.json();
  } catch (e) { /* 没起服务 */ }
  if (running && running.targetDate === targetDate) return '确认页已在运行且日期一致';
  // 端口被别的日期的服务占着 → 先结束占用该端口的 node 进程
  if (running) {
    try {
      const ns = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
      const pid = (ns.stdout || '').split('\n')
        .filter(l => l.includes(`:${port}`) && /LISTENING/i.test(l))
        .map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p))[0];
      if (pid) {
        const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        if (/node/i.test(tl.stdout || '')) spawnSync('taskkill', ['/PID', pid, '/F'], { encoding: 'utf8' });
      }
    } catch (e) { /* 结束失败就往下走，重启时会因端口占用失败，仅影响链接可打开性 */ }
  }
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), targetDate], {
      cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    return '已后台启动确认页（' + targetDate + '）';
  } catch (e) {
    return '确认页启动失败：' + e.message;
  }
}
// 定向版正文（发给「一人一群」的专属群）：只讲本人，不出现别人的名字与统计，
// 群里只有他（+ 你自己），所以可以直接用「你的日报还没提交」这种口吻。
function buildPersonalText(name, r) {
  // 「今天 / 昨天 / 前天 / 上周五…」由目标日期与今天的相对位置算出来（2026-09-22 用户定稿）：
  // 白天三次（9:30 / 10:50 / 13:35）查上一个工作日 → 通常显示「昨天」，周一则是「上周五」；
  // 晚上 17:20 那次查当天 → 显示「今天」。
  const dayWord = relativeDayLabel(r.targetDate);
  // 括号里补具体日期（2026-09-23 用户定稿）：「你今天（9月22日）的日报还未提交」，
  // 避免长假回来、一天多跑等场景下对不上是哪天。格式＝「M月D日」，去掉前导零。
  const [mm, dd] = [Number(String(r.targetDate).slice(5, 7)), Number(String(r.targetDate).slice(8, 10))];
  const dateCn = (mm && dd) ? `（${mm}月${dd}日）` : '';
  // 尾句跟随相对日词（2026-09-23 用户定稿，改掉了原来写死的「今日」）：
  // 早上三次查「上一个工作日」，正文说的是「你昨天…」，尾句却说「今日」——收件人会把「今日」
  // 理解成收到消息的那天，反而以为"我今天没参与、可以忽略"，把该催的人劝退。
  // 现在两句共用同一个 dayWord（与上一行字面一致，零歧义）；只有 17:20 那次查当天才显示「今天」。
  return [
    '【日报未提交提醒】',
    `${name}，你${dayWord}${dateCn}的日报还未提交，请点击以下链接登录提交`,
    REPORT_URL,
    `（${dayWord}日报已提交，则不会收到本提醒。如果${dayWord}未参与项目，请忽略）`,
  ].join('\n');
}
// 消息格式：默认 text（个人微信/微信插件只渲染 text）；--wx-md 才用 markdown（企微 App 里更好看，但微信里会显示"暂不支持此类型"）
const WX_FORMAT = flags['wx-md'] ? 'markdown' : 'text';
// 微信插件只支持 text，测试消息也用纯文本，避免误判成"链路不通"
const WX_ROBOT_TEST_MESSAGE = [
  '【测试消息】日报提醒链路测试（群消息通道）',
  '如果你是在个人微信里看到这条，说明群消息 → 微信插件这条路是通的。',
].join('\n');

// ===== 企业微信「群机器人」推送（不走 access_token，因此不受「企业可信IP」限制）=====
// ⚠️ 格式默认 text：个人微信（微信插件）只渲染 text 类型，markdown 会显示「暂不支持此类型，请前往企业微信查看」。
async function wxRobotSend(webhook, content, { atUserIds, atMobiles, format = 'text' } = {}) {
  if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=/.test(webhook)) {
    throw Object.assign(new Error(`Webhook 地址格式不对（应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头）：${webhook.slice(0, 60)}`), { code: 'config' });
  }
  const payload = format === 'markdown'
    ? { msgtype: 'markdown', markdown: { content } }
    : { msgtype: 'text', text: { content } };
  const slot = payload[format === 'markdown' ? 'markdown' : 'text'];
  const ids = atUserIds ? String(atUserIds).split(',').map(s => s.trim()).filter(Boolean) : [];
  const mobiles = atMobiles ? String(atMobiles).split(',').map(s => s.trim()).filter(Boolean) : [];
  if (ids.length || mobiles.length) {
    slot.mentioned_list = ids;
    slot.mentioned_mobile_list = mobiles;
  }
  const res = await postJSON(webhook, payload);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (e) { /* ignore */ }
  return { status: res.status, parsed, raw: res.body };
}

// ===== main =====
(async () => {
  // 仅测试企微链路：不查 FlowUs，直接发一条测试消息
  if (flags['wx-robot-test'] || flags['wx-user-test']) {
    const cfg = resolveWxWorkConfig();
    // 「一人一群」单点验证：只往某一个人的专属群发一条测试消息
    if (flags['wx-user-test']) {
      const who = String(flags['wx-user-test']);
      const hook = (cfg.userWebhooks || {})[who];
      if (!hook) {
        console.error(`❌ wxwork.json 的 userWebhooks 里没有「${who}」的 Webhook（现有：${Object.keys(cfg.userWebhooks || {}).join('、') || '空'}）`);
        process.exit(1);
      }
      console.log(`【企微链路测试 · ${who} 的专属群】（只发一条测试消息，不查询 FlowUs）`);
      console.log(`  配置文件：${cfg.__path || '(未找到，改用命令行/环境变量)'}`);
      try {
        const res = await wxRobotSend(hook, WX_ROBOT_TEST_MESSAGE, { format: WX_FORMAT });
        const ok = res.parsed && res.parsed.errcode === 0;
        console.log(`  HTTP ${res.status} | errcode=${res.parsed ? res.parsed.errcode : '?'} | ${ok
          ? `✅ 已发出，请让 ${who} 看下微信里是否收到`
          : '❌ ' + (res.parsed ? res.parsed.errmsg + explainWxErr(res.parsed) : res.raw.slice(0, 200))}`);
        if (!ok) process.exit(3);
      } catch (e) {
        console.error(`  ❌ 发送失败：${e.message}`);
        process.exit(e.code === 'config' ? 1 : 3);
      }
      return;
    }
    // 群机器人模式（无需 corpid/secret/agentid）
    if (cfg.robotwebhook) {
      if (!cfg.robotwebhook) {
        console.error('❌ 缺少群机器人 Webhook：用 --wx-robot=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx');
        console.error('   （或写进 wxwork.json 的 robotwebhook 字段）');
        process.exit(1);
      }
      console.log('【企微链路测试 · 群机器人】（只发一条测试消息，不查询 FlowUs）');
      console.log(`  配置文件：${cfg.__path || '(未找到，改用命令行/环境变量)'}`);
      console.log(`  webhook key=${String(cfg.robotwebhook).split('key=')[1] ? maskSecret(String(cfg.robotwebhook).split('key=')[1]) : '(解析不出)'}`);
      try {
        const res = await wxRobotSend(cfg.robotwebhook, WX_ROBOT_TEST_MESSAGE, { atUserIds: cfg.wxat, atMobiles: cfg.wxatmobile, format: WX_FORMAT });
        const ok = res.parsed && res.parsed.errcode === 0;
        console.log(`  HTTP ${res.status} | errcode=${res.parsed ? res.parsed.errcode : '?'} | ${ok
          ? '✅ 已发出，请到群里/微信「通讯录 → 我的企业」看是否收到'
          : '❌ ' + (res.parsed ? res.parsed.errmsg + explainWxErr(res.parsed) : res.raw.slice(0, 200))}`);
        if (!ok) process.exit(3);
      } catch (e) {
        console.error(`  ❌ 发送失败：${e.message}`);
        process.exit(e.code === 'config' ? 1 : 3);
      }
      return;
    }
    // 走不到这里：没配 robotwebhook 时上面已经报错退出
  }

  let targetDate;
  try { targetDate = parseDateExpr(dateExpr); }
  catch (e) { console.error('❌ ' + e.message); process.exit(1); }

  const rosterRecent = Number(flags['roster-recent'] || 0) || 0;
  const rosterFrom = String(flags['roster-from'] || DEFAULT_ROSTER_FROM).trim();
  const rosterNames = String(flags['roster-names'] || '').trim();
  if (!ROSTER_FROM_KINDS.includes(rosterFrom)) {
    console.error(`❌ --roster-from 只支持 ${ROSTER_FROM_KINDS.join(' / ')}，收到：${rosterFrom}`);
    process.exit(1);
  }
  if (rosterFrom === 'fixed' && !rosterNames) {
    console.error('❌ --roster-from=fixed 必须同时给 --roster-names=甲,乙');
    process.exit(1);
  }
  const isDefaultTarget = !dateExpr || ['上一个工作日', '上一工作日', '最近工作日', 'auto'].includes(dateExpr.trim());
  const todayStr = beijingToday();

  // ===== 触发来源判定：--scheduled-at=HH:MM（2026-09-24 用户定稿）=====
  // 痛点：用户在自动化面板点「运行」时，平台下发的指令与定时触发**完全一致**——
  //   没有环境变量标记、prompt 包装也一模一样，脚本无法从运行来源上区分是谁发起的。
  // 解法：由定时任务把「计划时刻」写进命令，脚本拿当前北京时间比对：
  //   · 落在计划时刻 ±容差 内  → 认定为定时触发，节流 / 已同步护栏照旧生效
  //   · 落在窗口外（用户在面板手点运行、或平台延迟补跑）→ 降级为 manual，
  //     不受节流限制，本次真实查询并推送（手点就是要看结果）
  // 不给 --scheduled-at 时行为完全不变（向后兼容，白天三次不受影响）。
  const schedAt = String(flags['scheduled-at'] || '').trim();
  if (flags.auto && /^\d{1,2}:\d{2}$/.test(schedAt)) {
    const tolMin = Number(flags['sched-tolerance'] || 15);
    const [sh, sm] = schedAt.split(':').map(Number);
    const nowBJ = new Date(Date.now() + 8 * 3600 * 1000);
    const nowMin = nowBJ.getUTCHours() * 60 + nowBJ.getUTCMinutes();
    let diffMin = Math.abs(nowMin - (sh * 60 + sm));
    diffMin = Math.min(diffMin, 1440 - diffMin);            // 跨零点取近的一侧
    if (diffMin > tolMin) {
      const hhmm = `${String(nowBJ.getUTCHours()).padStart(2, '0')}:${String(nowBJ.getUTCMinutes()).padStart(2, '0')}`;
      console.log(`ⓘ 触发来源判定：当前 ${hhmm}，计划 ${schedAt}（容差 ±${tolMin} 分钟，相差 ${diffMin} 分钟）`);
      console.log('  → 判定为手动触发（面板手点 / 延迟补跑）：本次不受节流限制，真实执行');
      flags.auto = false;                                    // 降级为 manual：节流与「已同步」护栏一并跳过
    }
  }

  // ===== 自动运行节流（2026-09-22 用户定稿，2026-09-23 修订）=====
  // 只有 --auto（定时任务专用）才生效：距上次运行不足 AUTO_MIN_GAP_SEC 秒 → 跳过检测。
  //   ⭐ 2026-09-23 修订：**上次运行无论是手动还是自动都算数**（手动也会写时间戳），
  //      且跳过时**要发一条「〓跳过〓」日志**（原来是完全静默），原文案见 sendSkipLog()。
  //      场景：9:05 手动跑过一次，9:07 自动那次发现刚跑过 → 不查 FlowUs、不催人，只在日志群说明一次。
  // 场景：早上没开电脑，13:35 才开机，若平台把 9:00/10:50/13:35 三次一起补跑，
  //       有了节流就只会真正跑第一次，后面几次自己让位（这三次查的都是「上一个工作日」，日期相同）。
  //       但**查不同日期的运行互不挤占**：17:20 那次查「当天」，不受白天三次影响，
  //       即便紧接着前一次运行也会照常检查并提醒当天日报。
  // 手动运行 / 对话里要求运行时**不带 --auto**，不受任何限制（但会留下时间戳，供自动那次避让）。
  const AUTO_MIN_GAP_SEC = Number(flags['min-gap'] || process.env.NOTIFY_MIN_GAP_SEC || 3600);
  const LAST_RUN_FILE = path.join(os.homedir(), '.workbuddy', 'daily-report-last-run.json');
  // 真实推送的运行才发「跳过日志」；纯检测/预览（不带 --push）保持静默跳过
  const isRealPushRun = !!(flags.push || flags['wx-robot'] || flags['wx-work'] || flags.webhook);
  // ⭐ 状态文件统一由 writeLastRun() 写，字段：mode / targetDate / synced / ts / at。
  //   synced=true 表示该日日报已写回模版表（同步完成），供下面的「已同步 → 跳过」判定读。
  const writeLastRun = (date, synced, { keepTs = false } = {}) => {
    let prev = {};
    if (keepTs) { try { prev = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8')); } catch (e) { /* 读不到就按新写 */ } }
    try {
      fs.mkdirSync(path.dirname(LAST_RUN_FILE), { recursive: true });
      fs.writeFileSync(LAST_RUN_FILE, JSON.stringify({
        mode: flags.auto ? 'auto' : 'manual',
        targetDate: date,
        synced: !!synced,
        ts: (keepTs && prev.ts) ? prev.ts : Date.now(),
        at: (keepTs && prev.at) ? prev.at : new Date().toISOString(),
      }, null, 2), 'utf8');
    } catch (e) {
      console.error(`  ⚠️ 写入上次运行状态失败：${e.message}`);
    }
  };
  const runMode = flags.auto ? 'auto' : 'manual';

  if (flags.auto) {
    let last = null;
    try { last = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8')); } catch (e) { /* 没记录＝可以跑 */ }
    const gapSec = (last && last.ts) ? (Date.now() - last.ts) / 1000 : Infinity;
    // 只有「查的是同一天」才节流（2026-09-22 用户定稿）：
    // 白天三次查「上一个工作日」、17:20 那次查「当天」，目标日期不同 → 互不挤占，
    // 所以即便开机晚到 17:10 之后、9:00 那次刚补跑过，17:20 照样会跑并提醒当天的日报。
    const lastTarget = (last && last.targetDate) ? String(last.targetDate) : null;
    const sameTarget = lastTarget === null || lastTarget === String(targetDate);
    if (sameTarget && gapSec < AUTO_MIN_GAP_SEC) {
      console.log(`ⓘ 自动运行节流：距上次运行（${last.mode === 'manual' ? '手动' : '自动'}，查 ${lastTarget || '未知日期'}）仅 ${Math.round(gapSec / 60)} 分钟（阈值 ${Math.round(AUTO_MIN_GAP_SEC / 60)} 分钟）`);
      console.log('  → 本次跳过：不查询 FlowUs、不推送个人提醒，只在日志群留一条「〓跳过〓」。');
      if (isRealPushRun) await sendSkipLog(last.ts, last.mode);
      else console.log('  （本次是纯检测/预览，不发跳过日志）');
      process.exit(0);
    }
  }

  // ===== 「该日已同步完成 → 本次跳过」（2026-09-23 用户定稿）=====
  // 场景：9:00 那次查「上一个工作日」，全员已提交且日报已自动同步写回模版表；
  //       那 10:50 / 13:35 就没必要再查一遍、再催一遍。
  // 生效条件（四条同时满足才算跳过）：
  //   ① flags.auto        —— 只有定时任务受此限制；手动运行 / 对话里要求运行时照常检查
  //   ② isDefaultTarget   —— 查的是「上一个工作日」（没带日期参数）。⭐ 17:20 那条定时任务带 `今天`，
  //                          查的是当天，永远不受此规则影响（用户明确要求）
  //   ③ 记录里的 targetDate 与本次相同 —— 换了目标日期就重新出发
  //   ④ 记录里 synced === true —— 之前那次真的成功写了库。同步异常（需人工确认）时为 false，
  //      后续运行仍会照常检查并催报 / 重试同步，不会把问题藏起来
  // ⭐ 不限「同一自然日」（2026-09-23 用户定稿，曾加过又被明确取消）：
  //    昨晚 17:20 把「昨天」的日报同步成功后，第二天早上 9:00 查的还是「昨天」，
  //    这种情况**就应该跳过**——用户明确要求。所以判定只看 targetDate 是否相同，不看隔了几天。
  // 例外：带 --force 可强制跑一次（用于排查）；不带 --auto 的手动运行也永远照常检查。
  if (flags.auto && isDefaultTarget && !flags.force) {
    let last = null;
    try { last = JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8')); } catch (e) { /* 没记录 */ }
    if (last && last.synced === true && String(last.targetDate) === String(targetDate)) {
      // 第四行的相对日要跟着检查的日报日期走：早上＝昨日，周一早上＝上周五，长假后＝N天前
      const dayWord = relativeDayLabel(targetDate);
      console.log(`ⓘ ${targetDate}（${dayWord}）的日报已在 ${bjShort(last.ts)} 同步完成（mode=${last.mode || '未知'}）`);
      console.log('  → 本次跳过：不查询 FlowUs、不推送个人提醒，只在日志群留一条「〓跳过〓」。');
      if (isRealPushRun) await sendSkipLog(last.ts, last.mode, { tailLine: `${dayWord}日报已经同步完成，本次检查取消` });
      else console.log('  （本次是纯检测/预览，不发跳过日志）');
      process.exit(0);
    }
  }
  // ===== 目标日期非工作日 → 直接跳过，不查询 FlowUs（2026-09-25 用户定稿）=====
  // 背景：17:20 那条定时任务带 `今天`、查的是当天，遇到周末 / 法定节假日时，旧逻辑会
  //   先跑一遍 detect()（查日报表 + 用「上一次有人填报那天」反推名册），日志里照样出现
  //   「预期 3 人（基准 09-24 昨天）」——那天本就不该有人填日报，却还查了一轮基准，
  //   既多打 API，日志也容易让人误以为在催节前的日报。
  // 现在：判定提到**所有查询之前**，非工作日直接发一条「〓跳过〓」日志并退出。
  // 影响范围：只对「显式指定日期」的运行生效（17:20 带 `今天`、手动带「昨天」/具体日期）。
  //   ⭐ 白天三次查的是「上一个工作日」，prevWorkday() 保证它一定是工作日，
  //      **永远走不到这里**，行为完全不变。
  // 例外：--force 可强制跑一次（用于排查）。
  if (!isWorkday(targetDate) && !flags.force) {
    const dayWord = relativeDayLabel(targetDate);
    const mm = Number(String(targetDate).slice(5, 7)), dd = Number(String(targetDate).slice(8, 10));
    const reason = `${dayWord}（${mm}月${dd}日）是${dowOf(targetDate)}${HOLIDAY_SET.has(targetDate) ? '·法定节假日' : ''}，非工作日`;
    console.log(`ⓘ ${reason}，那天本就不该有人填日报`);
    console.log('  → 本次跳过：不查询 FlowUs、不反推名册基准、不推送个人提醒，只在日志群留一条「〓跳过〓」。');
    if (isRealPushRun) await sendSkipLog(null, null, { tailLine: `${reason}，本次检查取消` });
    else console.log('  （本次是纯检测/预览，不发跳过日志）');
    process.exit(0);
  }

  console.log(`【缺报检测】${targetDate}（${dowOf(targetDate)}）`);
  if (isDefaultTarget) {
    console.log(`  目标日期＝上一个工作日（今天 ${todayStr} ${dowOf(todayStr)}）`);
  }
  const basisDesc = rosterFrom === 'fixed'
    ? `固定名单：${rosterNames}`
    : rosterFrom === 'template'
      ? '模版表「当天优先、当天没有则取最近一次」的负责人'
      : '上一次有人填报那天的填报人';
  console.log(`  名册口径：${rosterFrom}（${basisDesc}）${rosterRecent ? ` + 近 ${rosterRecent} 天` : ''}　排除 ${[...EXCLUDE].join('、')}`);

  // 记录本次运行时刻（放在检测前：即便后续失败也占位，避免补跑时反复重试刷屏）
  // ⭐ 2026-09-23 修订：**手动运行也写**（mode='manual'）——这样手动跑过之后，
  //    紧跟着的自动那次会发现"刚执行过"并自动跳过，不会在几分钟内重复催人。
  //    手动运行本身不受节流限制（上面的检查只在 --auto 时进行）。
  // ⚠️ 注意：这里写的 synced=false 会**清掉**上一次运行留下的 synced=true（文件整体覆盖）。
  //    只有当天后面的运行真的写库成功，才会再次置 true（见下方同步分支里的 writeLastRun(..., true)）。
  writeLastRun(targetDate, false);
  console.log(`  已记录本次运行时刻（mode=${runMode}，节流阈值 ${Math.round(AUTO_MIN_GAP_SEC / 60)} 分钟）`);

  let r;
  try { r = detect(targetDate, rosterRecent, rosterFrom, rosterNames); }
  catch (e) {
    console.error(`\n❌ 查询失败：${e.message}`);
    if (e.code === 'missing_token' || e.code === 'unauthorized') {
      console.error('   → FlowUs 认证异常，请先确认 FLOWUS_TOKEN（user 级环境变量）有效；不要执行 flowus.exe login。');
    }
    process.exit(2);
  }

  const basisRole = r.rosterBasisKind === 'template' ? '的模版负责人' : '填报的人';
  console.log(`  名册基准：${r.rosterBasisKind === 'fixed'
    ? '固定名单（不查基准日）'
    : r.rosterBasisDate ? `${r.rosterBasisDate}（${dowOf(r.rosterBasisDate)}）${basisRole}` : '(回退窗口内无人填报)'}`);
  console.log(`  当日模版记录：${r.templateCount} 条`);
  console.log('');
  console.log(`  应交 ${r.roster.length} 人：${r.roster.join('、') || '(空)'}`);
  console.log(`  已交 ${r.submitted.length} 人：${r.submitted.map(p => `${p}(${r.reporterEntries[p]}条/${fmtH(r.reporterHours[p])}h)`).join('、') || '(空)'}`);
  console.log(`  缺报 ${r.missing.length} 人：${r.missing.join('、') || '无'}`);
  if (r.outsiders.length) console.log(`  名册外提交：${r.outsiders.join('、')}`);

  console.log('');
  if (r.missing.length === 0) console.log('  ✅ 结论：无缺报');
  else console.log(`  ⚠️ 结论：${r.missing.join('、')} 未提交日报`);

  if (flags['show-message']) {
    console.log(`\n--- 定向版正文预览（发给缺报者本人专属群，实际发送格式 = ${WX_FORMAT}）---`);
    if (r.missing.length) {
      console.log(buildPersonalText(r.missing[0], r));
    } else {
      console.log('（本次无缺报，不会发定向提醒）');
    }
    if (WX_FORMAT === 'text') {
      console.log('（默认 text：个人微信/微信插件只渲染 text；加 --wx-md 可切 markdown，但微信里会显示"暂不支持此类型"）');
    }
    console.log('--- 预览结束 ---');
  }

  if (flags.json) {
    console.log('\n--- JSON ---');
    console.log(JSON.stringify(r, null, 2));
  }

  // 推送开关（2026-09-22 修订，2026-09-23 收敛为群机器人单一通道）：**默认只检测，不推送**。
  //   - 显式给 --wx-robot=<URL> → 按该地址推送；
  //   - 什么都不给 → 只检测；要把「配置文件里已存的通道」跑起来，用 --push；
  //   - 当日无缺报 → 默认不推（避免每天一条"无缺报"噪音），要每次都确认用 --always。
  // 修订原因：此前"配置文件里有 webhook 就自动推送"，导致手动跑诊断时误发了真实消息。
  // 2026-09-23 移除钉钉（--webhook）与企微自建应用消息（--wx-work）两条通道：均未投产，详见文件头注释。
  const wxCfgForRobot = resolveWxWorkConfig();
  const userHooks = wxCfgForRobot.userWebhooks || {};
  const hasRobot = !!flags['wx-robot']
    || (!!flags.push && (!!wxCfgForRobot.robotwebhook || Object.keys(userHooks).length > 0));
  if (!hasRobot) {
    console.log('\n  ⓘ 仅检测，未推送。要推送请显式指定通道：--wx-robot=<URL>；或用 --push 采用配置文件中已保存的通道。');
    return;
  }
  // ----- 护栏跳过：照样发一条运行日志（用户要的就是"知道程序跑过了、为什么没催"）-----
  let skipReason = null;
  if (!r.roster.length && !flags.force) {
    skipReason = `名册为空（近 ${ROSTER_LOOKBACK} 天找不到任何填报记录），无从判断`;
  } else if (!isWorkday(r.targetDate) && !flags.force) {
    skipReason = `${r.targetDate} 是${dowOf(r.targetDate)}${HOLIDAY_SET.has(r.targetDate) ? '·法定节假日' : ''}，非工作日，那天本就不该有人填日报`;
  }
  if (skipReason) {
    console.log(`\n  已跳过推送（${skipReason}；加 --force 可强制推送）。`);
    // 被护栏跳过＝程序按预期静默，状态仍算「正常」（真实原因写在「跳过原因」行）。
    await sendRunLog(r, { status: '正常', skipReason, actions: ['未推送'] });
    return;
  }

  let failed = false;
  const actions = [];   // 记录本次实际做了什么，写进运行日志

  if (hasRobot && r.missing.length > 0) {
    // 「一人一群」定向推送（2026-09-22）：配了专属群的缺报者只发他自己的群；
    // 没配专属群的才往「运行日志群」发一条提示（该群现在只有你自己 + yoosee，不会再打扰已交的人）。
    const personal = r.missing.filter(p => userHooks[p]);
    const rest = r.missing.filter(p => !userHooks[p]);

    console.log(`\n  正在推送企业微信群消息（群消息同步到微信插件，成员在个人微信里接收；格式=${WX_FORMAT}）...`);
    if (personal.length) {
      console.log(`  「一人一群」定向推送 ${personal.length} 人：${personal.join('、')}（各自独立群，其他人收不到）`);
    }
    const okNames = [];
    // ⛔ 测试开关（2026-09-23）：--no-personal 时**一条都不发给个人**，只打日志给你自己看。
    //    2026-09-23 事故复盘：验证时只把「日志群」换成了假地址，三人的专属群仍读真实配置，
    //    结果误发了 3 条真消息。此后凡是要带 --push 的验证，一律再加 --no-personal。
    if (flags['no-personal']) {
      console.log('  ⛔ --no-personal 已生效：本次**不向任何个人专属群发送**（只发运行日志，日志群只有你自己）');
      if (personal.length) {
        for (const p of personal) console.log(`    · ${p}：（已跳过，未发送）`);
        actions.push(`测试模式未发送（--no-personal）：${personal.join('、')}`);
      }
    } else {
      for (const p of personal) {
        try {
          const res = await wxRobotSend(userHooks[p], buildPersonalText(p, r), { format: WX_FORMAT });
          const ok = res.parsed && res.parsed.errcode === 0;
          console.log(`    · ${p}：${ok ? '✅ 已发出' : '❌ ' + (res.parsed ? res.parsed.errcode + ' ' + res.parsed.errmsg + explainWxErr(res.parsed) : 'HTTP ' + res.status + ' ' + res.raw.slice(0, 200))}`);
          if (ok) okNames.push(p); else failed = true;
        } catch (e) {
          console.error(`    · ${p}：❌ 推送异常：${e.message}`);
          failed = true;
        }
      }
      if (okNames.length) actions.push(`定向推送 ${okNames.length} 人：${okNames.join('、')}`);
    }

    // 没配专属群的缺报者：**不再往日志群补发一条名单**（2026-09-22 用户定稿：一次运行只在日志群留一条日志）。
    // 缺报名单本来就写在收尾那条运行日志里，这里只在控制台 + 日志的「推送动作」中标注未送达。
    if (rest.length) {
      console.log(`  ⚠️ 以下缺报者未配专属群，无法定向提醒：${rest.join('、')}（请在 wxwork.json 的 userWebhooks 补上他们的群 Webhook）`);
      actions.push(`未配专属群、未提醒：${rest.join('、')}`);
    }
    if (r.missing.length && !personal.length) {
      console.log('  ⚠️ 本次缺报者均未配专属群，无人被提醒；缺报名单见下方运行日志。');
    }
  }

  // ===== 全员已提交 → 自动执行「日报同步」（2026-09-23 用户定稿）=====
  // 只有真实推送的运行才同步（纯检测/预览不写 FlowUs）；加 --no-sync 可临时关掉。
  let syncProblem = false;
  // --force-sync 供联调用：即使还有人缺报也跑一次同步（正常逻辑下缺报就不必同步）
  const shouldSync = (r.missing.length === 0 || !!flags['force-sync']) && !flags['no-sync'];
  if (shouldSync) {
    const syncRes = runDailySync(r.targetDate);
    const sm = summarizeSync(syncRes);
    console.log(`  同步结果：${sm.text}${sm.needConfirm ? '' : ''}`);
    actions.push(sm.text);
    if (sm.needConfirm) {
      syncProblem = true;
      const st = await ensureConfirmServer(r.targetDate);
      console.log(`  确认页（${confirmUrl()}）：${st}`);
      // ⚠️ synced 保持 false：问题还没解决，后续自动运行仍会重试同步、仍会催报。
    } else {
      // 写库成功 → 标记「该日已同步」，同一目标日的后续**自动**运行会跳过（见上方判定）。
      // keepTs：保留原时间戳，不把 60 分钟节流窗口往后推（两种跳过机制各自独立）。
      writeLastRun(r.targetDate, true, { keepTs: true });
      console.log(`  已标记 ${r.targetDate} 日报同步完成（该日的后续自动检查将跳过）`);
    }
  } else if (r.missing.length === 0 && flags['no-sync']) {
    console.log('\n  ⓘ 全员已提交，但本次带了 --no-sync，跳过日报同步。');
  }

  // ===== 收尾：无论结果如何，都给「运行日志群」发一条运行情况 =====
  if (!actions.length) actions.push(r.missing.length ? '未推送' : '全员已提交，无需催报');
  // 同步异常优先级最高（它本身就意味着要人工介入），其次才是缺报/工时异常
  const finalStatus = syncProblem ? '〓同步异常〓' : runLogStatus(r, { failed });
  const logOk = await sendRunLog(r, { actions, failed, status: finalStatus, appendConfirmUrl: syncProblem });
  if (failed || logOk === false) process.exit(3);
})();
