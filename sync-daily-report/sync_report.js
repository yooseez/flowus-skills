// 日报工时回填（对话版）
// 用法1（分析）: node fill_hours_chat.js 2026-08-24
//   - 模版里已有任何数据（张威除外）或存在任何问题 → 不写入，生成确认列表等待人工确认
//   - 模版全部无数据且无问题 → 自动写入
//   - 生成状态文件 fill_state_<date>.json 供对话确认
// 用法2（确认后写入）:   node fill_hours_chat.js write fill_state_2026-08-24.json write_items.json
//   - write_items.json: [{ "tplId": "xxx", "hours": 8 }]

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 凭证：固定使用 Windows 用户级环境变量 FLOWUS_TOKEN（静态密钥，bot trae2）。
// 不使用 ~/.flowus/credentials.json 的 OAuth 凭证——网页授权会重新签发令牌并作废同族旧令牌，
// 曾因此顶掉 TRAE 侧 MCP 令牌。此处不再对 FLOWUS_TOKEN 做任何删除/改写。
// 实测：环境变量 token 优先级高于凭证文件（文件存在且含有效令牌时，doctor 仍报 tokenSource: env），
// 故即使 credentials.json 再次出现，也不会影响本脚本使用的身份。

const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const REPORT_DB = '1a9c4392-b5ae-48f4-aa3b-e05135215dce';
const TEMPLATE_DB = 'bc84d926-8df2-4662-9751-6a35e8761d14';
const TMP_DIR = path.join(__dirname);

const USER_MAP = {
  "7b8d78bb-6099-4aa4-8f10-e8dfab37197e": "马少平",
  "050fae93-4c3e-4596-80f2-21c3fb100b07": "周彦佐",
  "ac9b1b06-4ed3-49b3-a2e1-d594252d2b99": "郑志伟",
  "1f0e0e61-dc10-4399-8074-b8e5f6e074a6": "李明",
  "94eb3da4-35cb-4a72-81b7-623ec15e649d": "张威",
};

const PROJECT_ALIAS = {
  '浙能法务': '浙能法务二期',
  '非HD项目': '其它项目',
  '中国诚通': '其它项目',
  '集团采购': '其它项目',
};

// "其它项目"下子项目路径映射：日报原始项目名 → 模版任务的【父记录】名称
// 当同一人有多条项目都映射到"其它项目"时，用子项目名做二级匹配
const OTHER_PROJECT_SUBPATH = {
  '中国诚通': '中国诚通',
  '集团采购': '公司/集团项目',
};

// 子项目显示拼接名单（2026-09-18 用户定稿）：统一规则 = 模版任务列不拼接子项目名
// （所有项目一视同仁，项目列已能区分）；只有仍挂在"其它"下、需要特殊标识的子项目
// （当前仅「公司/集团项目」）才拼接，顺序为【任务类型】在前、子项目名在后，
// 如「【其它】公司/集团项目」。中国诚通等已是独立项目，不在此名单，走统一规则。
// 注意：仅影响显示，匹配逻辑（二级匹配）不受影响。
const SUBPROJECT_DISPLAY_SHOW = new Set(['公司/集团项目']);

// ===== “其它项目”子项目识别（2026-09-21 用户规则）=====
// 日报项目直选〓其它项目〓时，真实项目名一般写在任务名称/进展说明里（如“北银项目”）：
//   1) 在「项目任务表」的“其它项目”下能找到类似项目 → 标记建议归属，确认页面询问是否归入该项目的任务；
//   2) 找不到 → 默认归入 其它项目-其它-【其它】（模版已有该行则直接匹配写入；
//      模版没有该行 → 保持仅日报，确认页面提供“新建模版记录并写入”选项，不静默建记录）。
const TASK_DB = '9686c696-3b1f-4661-bb91-fec726425c4d';
const OTHER_PROJECT_ID = 'b59cf01c-40d9-4ea6-9a9f-3b761ce7f5ba'; // 兜底，正常可从 projectMap 反查

// 查询「项目任务表」，取“其它项目”下的子项目（顶级行）与任务（子行）
function fetchOtherProjectTree(projectMap) {
  const empty = { subProjects: [], tasks: [] };
  const otherProjId = Object.keys(projectMap).find(id => projectMap[id] === '其它项目') || OTHER_PROJECT_ID;
  try {
    const rows = queryDB(TASK_DB, { page_size: 100 });
    const mine = rows.filter(r => (r.properties['所属项目']?.relation || []).some(x => x.id === otherProjId));
    const subProjects = [], tasks = [], idName = {};
    for (const r of mine) {
      const props = r.properties;
      let title = '';
      for (const [n, v] of Object.entries(props)) if (v.type === 'title') { title = (v.title || []).map(t => t.plain_text).join(''); break; }
      const parentId = props['【父记录】']?.relation?.[0]?.id || '';
      if (!parentId) { subProjects.push({ id: r.id, name: title }); idName[r.id] = title; }
      else tasks.push({ id: r.id, parentId, person: props['负责人']?.select?.name || '', title });
    }
    for (const t of tasks) t.parentName = idName[t.parentId] || '';
    return { subProjects, tasks };
  } catch (e) {
    console.log('  ⚠️ 项目任务表查询失败，跳过“其它项目”识别：' + (e && e.message ? e.message : e));
    return empty;
  }
}

// 从任务名称/进展说明里识别“其它项目”下的子项目名；返回 { sub, token }（sub 为空 = 未找到类似项目）
function detectSubProject(taskName, prog, subProjects) {
  const text = `${taskName || ''}\n${prog || ''}`;
  const names = subProjects.map(s => s.name).filter(n => n && n !== '其它');
  // 1) 直接包含子项目名（如“中国诚通”）
  for (const n of names) if (text.includes(n)) return { sub: n, token: n };
  // 2) 提取「XX项目/系统/平台/工程/产品」词，与子项目名（按 / 拆段）互相包含
  const tokens = new Set();
  for (const m of text.matchAll(/([一-龥A-Za-z0-9]{2,12}?)(?:项目|系统|平台|工程|产品)/g)) tokens.add(m[1]);
  for (const tk of tokens) {
    if (tk.length < 2 || tk === '其它') continue;
    for (const n of names) {
      for (const seg of n.split('/')) {
        if (seg.length >= 2 && (seg.includes(tk) || tk.includes(seg))) return { sub: n, token: tk };
      }
    }
  }
  return { sub: '', token: [...tokens].find(t => t.length >= 2) || '' };
}

// ===== 认证 / API 错误判定 =====
// 实测 CLI 失败时 stdout 仍是 JSON，同时 stderr 有一行纯文本：
//   token 无效 : {"error":{"code":"unauthorized","message":"Invalid or expired token","status":401}}            退出码 2
//   token 为空 : {"error":{"code":"unauthorized","message":"Authorization header format must be: Bearer <token>"}}
//   token 缺失 : {"error":{"code":"local_error","message":"Missing FlowUs token. Pass --token or set FLOWUS_TOKEN."}} 退出码 1
// ⚠️ 这些情况过去会让 queryDB 直接 break 并返回空数组，最终表现为"该日期无数据"——最迷惑的失败形态。
function classifyFailure(parsed) {
  const err = (parsed && parsed.error) || {};
  const code = typeof err === 'string' ? '' : (err.code || '');
  const message = ((typeof err === 'string' ? err : err.message) || (parsed && parsed.__cliStderr) || '(无错误信息)');
  const status = (typeof err === 'object' && err.status) || 0;
  const hay = `${code} ${message}`;
  let kind = 'api';
  if (/unauthor|token|bearer|expired|missing flowus token/i.test(hay) || status === 401) kind = 'token';
  else if (/forbidden|permission/i.test(hay) || status === 403) kind = 'permission';
  return { kind, code, message, status, cliStatus: parsed ? parsed.__cliStatus : null };
}

function reportQueryFailure(where, info) {
  const line = '='.repeat(64);
  const out = [''];
  out.push(line);
  out.push(`❌ 读取失败：${where}`);
  out.push('   ⚠️ 这不是"该日期无数据"——API 调用本身出错了，已中止，未写入任何内容。');
  out.push('-'.repeat(64));
  out.push(`   类型    : ${info.kind === 'token' ? '认证 / TOKEN 问题' : info.kind === 'permission' ? '权限问题（缺数据库权限）' : '其他 API 错误'}`);
  out.push(`   代码    : ${info.code || '(无)'}`);
  out.push(`   HTTP    : ${info.status || '(无)'}   CLI 退出码: ${info.cliStatus === null || info.cliStatus === undefined ? '(无)' : info.cliStatus}`);
  out.push(`   原始信息: ${info.message}`);
  if (info.kind === 'token') {
    out.push('-'.repeat(64));
    out.push('   【TOKEN 排查步骤】');
    out.push('   1) 确认用户级环境变量是否存在（PowerShell）：');
    out.push("        [Environment]::GetEnvironmentVariable('FLOWUS_TOKEN','User')");
    out.push('   2) 确认 CLI 认证状态：');
    out.push(`        "${CLI}" doctor`);
    out.push('        期望：authenticated=true / authMode=static / tokenSource=env / user.name=trae2');
    out.push('   3) 第 1 步为空 → 变量丢失，重新设置；第 2 步 unauthorized → 密钥已失效，');
    out.push('      到 FlowUs 开发者中心重新获取外部应用密钥并更新该用户级环境变量。');
    out.push('   ⛔ 不要运行 flowus.exe login：网页授权会作废同族旧令牌（曾因此顶掉 TRAE 侧 MCP 令牌）。');
  }
  out.push(line);
  out.push('');
  console.error(out.join('\n'));
}

function callAPI(method, apiPath, body) {
  const args = ['--json', 'api', 'call', method, apiPath];
  if (body) {
    const bodyPath = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\flowus_fill_${Date.now()}_${Math.random().toString(36).substr(2,5)}.json`;
    fs.writeFileSync(bodyPath, JSON.stringify(body));
    args.push('--body', bodyPath);
  }
  const result = spawnSync(CLI, args, { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout || '';
  const clean = output.replace(/^\uFEFF/, '').replace(/^#<\s*CLIXML\s*/, '').split('\n<Objs')[0];
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(clean); } catch (e) { parseErr = e; }
  if (!parsed || typeof parsed !== 'object') {
    // CLI 崩溃 / 无输出 / 输出被包裹 —— 保留原文与 stderr，交给 classifyFailure 判定
    parsed = { ok: false, error: { code: 'unparsable_output', message: parseErr ? parseErr.message : '(CLI 无输出)' } };
  }
  parsed.__cliStatus = result.status;
  parsed.__cliStderr = (result.stderr || '').trim();
  return parsed;
}

function queryDB(dbId, filterBody) {
  let allResults = [];
  let cursor = null;
  while (true) {
    const pageBody = { ...filterBody };
    if (cursor) pageBody.start_cursor = cursor;
    const parsed = callAPI('POST', `/v2/databases/${dbId}/query`, pageBody);
    if (!parsed.ok || !parsed.data) {
      // 不再静默 break 返回空数组（那会伪装成"该日期无数据"），改为抛出，由调用方上报
      const info = classifyFailure(parsed);
      const err = new Error(info.message);
      err.flowusFailure = info;
      err.dbId = dbId;
      throw err;
    }
    allResults = allResults.concat(parsed.data.results);
    if (!parsed.data.has_more) break;
    cursor = parsed.data.next_cursor;
  }
  return allResults;
}

function getProp(props, name, ptype) {
  const p = props[name] || {};
  if (!p || p.type !== ptype) return ptype === 'number' ? 0 : '';
  if (ptype === 'select') { const sel = p.select; return (sel && typeof sel === 'object') ? sel.name : ''; }
  else if (ptype === 'number') return p.number || 0;
  else if (ptype === 'date') return p.date ? p.date.start : '';
  else if (ptype === 'rich_text') return (p.rich_text || []).map(i => i.plain_text || '').join('');
  return '';
}

function getPersonName(uid) { return USER_MAP[uid] || `未知(${uid ? uid.slice(0,8) : '无'})`; }

// ===== 请假 / 调休保障（2026-09-25 用户定稿）=====
// 共享模块 leave_task.js：按「该人最近一个有真实项目日报的日期」定位项目，
// 在该项目的「其它」顶级行下确保存在【请假调休】任务（去重、自动赋值项目/负责人/状态）。
// 默认只预演；加 --leave-apply 或 LEAVE_APPLY=1 才真正写入 FlowUs。
const { isLeaveText, ensureLeaveTask, createLeaveTpl, resolveProjectForEntry, LEAVE_TITLE } = require('./leave_task.js');
const LEAVE_APPLY = process.argv.includes('--leave-apply') || process.env.LEAVE_APPLY === '1';
const LEAVE_CTX = { callAPI, queryDB, getPersonName };

function normProject(name) {
  let n = name.replace(/[〓〒]/g, '').trim();
  if (PROJECT_ALIAS[n]) n = PROJECT_ALIAS[n];
  return n;
}

// 与添加模版逻辑一致：填报日期优先，否则 created_time 转北京时间取日期
function getAutoDate(r) {
  const fillDate = r.properties['填报日期']?.date?.start;
  if (fillDate) return fillDate.includes('T') ? fillDate.split('T')[0].replace(/\//g, '-') : fillDate.replace(/\//g, '-');
  const beijing = new Date(new Date(r.created_time).getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().split('T')[0];
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// 解析日期表达式，返回 YYYY-MM-DD（北京时间）
// 支持：空/昨天/前天/今天/上周一~周日/X月X日/YYYY-MM-DD
function parseDateExpr(expr) {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  const today = now.toISOString().split('T')[0];

  if (!expr || expr.trim() === '') {
    // 默认昨天；若昨天是周末，回溯到上周五
    const yesterday = shiftDate(today, -1);
    const yDow = new Date(yesterday + 'T00:00:00Z').getUTCDay();
    if (yDow === 0) return shiftDate(today, -3); // 昨天周日 → 上周五
    if (yDow === 6) return shiftDate(today, -2); // 昨天周六 → 上周五
    return yesterday;
  }

  const s = expr.trim().toLowerCase();

  // 今天/昨天/前天
  if (s === '今天') return today;
  if (s === '昨天') return shiftDate(today, -1);
  if (s === '前天') return shiftDate(today, -2);

  // 上周一~上周日
  const weekMatch = s.match(/^上周([一二三四五六日天])$/);
  if (weekMatch) {
    const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const targetDow = dayMap[weekMatch[1]];
    const todayDow = now.getUTCDay(); // 0=周日
    // 上一周的对应星期几
    let diff = targetDow - todayDow;
    if (diff >= 0) diff -= 7;
    diff -= 7; // 再往前推一周（上上周的话就不对了，这里是"上周"）
    // 重新计算：本周周一 = today - (todayDow-1)，上周一 = 本周周一 - 7
    const thisMonday = shiftDate(today, -(todayDow === 0 ? 6 : todayDow - 1));
    const lastMonday = shiftDate(thisMonday, -7);
    const offset = targetDow === 0 ? 6 : targetDow - 1;
    return shiftDate(lastMonday, offset);
  }

  // X月X日 / X月X
  const mdMatch = s.match(/^(\d{1,2})月(\d{1,2})日?$/);
  if (mdMatch) {
    const year = now.getUTCFullYear();
    const m = mdMatch[1].padStart(2, '0');
    const d = mdMatch[2].padStart(2, '0');
    let dateStr = `${year}-${m}-${d}`;
    // 如果算出的日期晚于今天，则取上一年
    if (dateStr > today) dateStr = `${year - 1}-${m}-${d}`;
    return dateStr;
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // 默认：昨天
  return shiftDate(today, -1);
}

function writeHours(pageId, hours) {
  return callAPI('PATCH', `/v2/pages/${pageId}`, {
    properties: { '实际投入（小时）': { type: 'number', number: hours } }
  });
}

// 备注同步：模版「备注」是 title 字段，写入格式固定为 任务名称+进展说明 多行文本
function writeBeizhu(pageId, text) {
  return callAPI('PATCH', `/v2/pages/${pageId}`, {
    properties: { '备注': { type: 'title', title: [{ type: 'text', text: { content: text } }] } }
  });
}

// ===== 分析 + 自动写入 =====
function analyze(targetDate) {
  console.log(`目标日期: ${targetDate}`);

  // 1. 日报（用"日期"字段）
  console.log('1. 查询日报...');
  const rptRecords = queryDB(REPORT_DB, {
    filter: { and: [
      { property: "日期", date: { on_or_after: shiftDate(targetDate, -2).replace(/-/g, '/') } },
      { property: "日期", date: { on_or_before: shiftDate(targetDate, 1).replace(/-/g, '/') } }
    ] },
    sorts: [{ property: "日期", direction: "ascending" }],
    page_size: 100
  });
  const dayReports = rptRecords.filter(r => {
    const d = r.properties['日期']?.date?.start || '';
    return d.startsWith(targetDate.replace(/-/g, '/')) || d.startsWith(targetDate);
  });
  console.log(`  当日日报: ${dayReports.length} 条`);
  if (dayReports.length === 0) console.log('  ⓘ 本次查询成功（API 正常），该日期确实没有日报记录。');

  const reportData = [];
  for (const r of dayReports) {
    const person = getPersonName(r.created_by?.id || '');
    for (let i = 1; i <= 3; i++) {
      const proj = getProp(r.properties, `项目-${i}`, 'select');
      const taskName = getProp(r.properties, `任务名称-${i}`, 'rich_text');
      const prog = getProp(r.properties, `进展说明-${i}`, 'rich_text');
      const hrs = getProp(r.properties, `任务工时-${i}`, 'number');
      if (proj || hrs > 0) {
        const project = proj || '';
        reportData.push({ person, project, projectNorm: proj ? normProject(proj) : '', taskName, hours: hrs, prog });
        console.log(`  [日报条目] ${person} | 项目:${proj || '(空)'} | 工时:${hrs} | 任务:${taskName || '(空)'}`);
      }
    }
    const opsTask = getProp(r.properties, '运维工作', 'select');
    const opsHrs = getProp(r.properties, '运维工时', 'number');
    if (opsTask) { reportData.push({ person, project: '运维', projectNorm: '运维', taskName: opsTask, hours: opsHrs, prog: '' });
      console.log(`  [日报条目] ${person} | 项目:运维 | 工时:${opsHrs} | 任务:${opsTask}`);
    }
  }
  console.log(`  日报条目: ${reportData.length} 条`);

  // 每人当日日报总工时（排除张威，与模版排除一致）
  const personTotals = {};
  for (const r of reportData) {
    if (r.person === '张威' || r.person.startsWith('未知')) continue;
    personTotals[r.person] = (personTotals[r.person] || 0) + (r.hours || 0);
  }
  console.log('  每人日报合计:', JSON.stringify(personTotals));

  // 1.5 请假 / 调休保障（条目级，2026-09-25 用户定稿）
  //   归属项目按「日报条目」判断：条目自带真实项目 → 用它；条目选了「其它项目」→ 回溯最近真实项目中工时最大的那个。
  //   目标项目没有「其它」顶级行 → 先新建「其它」，再挂【请假调休】（请假调休算项目成本，不挂其它项目/其它）。
  //   全天请假 → 自动补一条模版记录，让工时能自动同步；
  //   混合日（如 调休3h + 开发5h）→ 只确保任务存在，不自动建模版记录（避免制造 multi，交给确认页绑定）。
  const leaveRows = [];
  {
    const byPerson = {};
    for (const r of reportData) {
      if (r.person === '张威' || r.person.startsWith('未知')) continue;
      (byPerson[r.person] = byPerson[r.person] || []).push(r);
    }
    for (const [person, entries] of Object.entries(byPerson)) {
      const leave = entries.filter(e => isLeaveText(e.taskName, e.prog, e.project));
      if (!leave.length) continue;
      const real = entries.filter(e => e.projectNorm && !isLeaveText(e.taskName, e.prog, e.project));
      leaveRows.push({ person, leave, real, allDay: real.length === 0 });
    }
  }
  if (leaveRows.length) {
    console.log(`1.5 请假/调休保障（apply=${LEAVE_APPLY ? '是' : '否 · 仅预演'}）...`);
    for (const lr of leaveRows) {
      // 按归属项目聚合：同一项目的多条请假条目只建一个任务
      const byProj = new Map();
      for (const e of lr.leave) {
        const rp = resolveProjectForEntry(LEAVE_CTX, e, lr.person, targetDate);
        if (!rp.ok) { console.log(`  ❌ ${lr.person}：${rp.reason}`); continue; }
        if (!byProj.has(rp.projectName)) byProj.set(rp.projectName, { reason: rp.reason, hours: 0 });
        byProj.get(rp.projectName).hours += (e.hours || 0);
      }
      for (const [projectName, info] of byProj) {
        console.log(`  [归属] ${lr.person} 请假 ${info.hours}h → ${info.reason}`);
        // 全天请假：把日报条目的归属项目改成【请假调休】任务所在项目，
        // 否则日报记在「其它项目」、模版记在真实项目，两组对不上，8 小时永远同步不过去。
        if (lr.allDay) {
          for (const e of lr.leave) { e.projectNorm = projectName; e.project = `〓${projectName}〓`; }
        }
        const r1 = ensureLeaveTask(LEAVE_CTX, { person: lr.person, projectName, apply: LEAVE_APPLY });
        if (!r1.ok) { console.log(`  ❌ ${lr.person} / ${projectName}：${r1.reason}`); continue; }
        if (r1.created) console.log(`  ✅ ${lr.person}：已在「${r1.projectName} / 其它」下创建「${LEAVE_TITLE}」taskId=${r1.taskId.slice(0, 8)}…`);
        else if (r1.wouldCreate) console.log(`  ⓘ ${lr.person}：${r1.plan}`);
        else console.log(`  ⓘ ${lr.person}：复用已有「${LEAVE_TITLE}」taskId=${r1.taskId.slice(0, 8)}…（${r1.projectName} / 其它）`);
        if (r1.otherCreated) console.log(`     ↳ 已先新建「其它」顶级行（该项目原本没有）`);
        if (r1.fallbackReason) console.log(`     ↳ 兜底原因：${r1.fallbackReason}`);
        if (!LEAVE_APPLY || !r1.taskId) continue;
        if (!lr.allDay) {
          console.log(`  ⓘ ${lr.person}：混合日（请假 ${info.hours}h + 实际工作 ${lr.real.reduce((s, e) => s + (e.hours || 0), 0)}h），只确保任务存在，模版记录请在确认页绑定`);
          continue;
        }
        const r2 = createLeaveTpl(LEAVE_CTX, { taskId: r1.taskId, targetDate, apply: LEAVE_APPLY });
        if (r2.ok && r2.created) console.log(`  ✅ ${lr.person}：已新建模版记录 tplId=${r2.tplId.slice(0, 8)}…（填报日期=${targetDate}）`);
        else if (r2.ok && r2.reused) console.log(`  ⓘ ${lr.person}：复用已有模版记录 tplId=${r2.tplId.slice(0, 8)}…`);
        else if (!r2.ok) console.log(`  ❌ ${lr.person}：${r2.reason}`);
      }
    }
  }

  // 2. 模版（getAutoDate 判定日期）
  // 查询窗口 = min(目标日-3天, 今天-3天)：只按目标日算时，若目标日在 3 天之后（如提前填报下周的假），
  // 今天刚创建的模版记录 created_time 会落在窗口外被漏掉（2026-09-25 修）。
  const todayBJ = new Date(Date.now() + 8 * 3600 * 1000).toISOString().split('T')[0];
  const tplWindowFrom = [shiftDate(targetDate, -3), shiftDate(todayBJ, -3)].sort()[0];
  console.log('2. 查询模版...');
  const tplRaw = queryDB(TEMPLATE_DB, {
    filter: { timestamp: "created_time", created_time: { on_or_after: tplWindowFrom } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100
  });
  const tplRecords = tplRaw.filter(r => getAutoDate(r) === targetDate);
  console.log(`  getAutoDate=${targetDate} 的模版记录: ${tplRecords.length} 条`);
  if (tplRecords.length === 0) console.log('  ⓘ 本次查询成功（API 正常），该日期确实没有模版记录。');

  // 3. 任务页 + 项目页
  console.log('3. 获取任务/项目页面...');
  const taskIds = [...new Set(tplRecords.map(r => r.properties['任务名称']?.relation?.[0]?.id).filter(Boolean))];
  const taskMap = {};
  const projectIds = new Set();
  for (const taskId of taskIds) {
    const taskPage = callAPI('GET', `/v2/pages/${taskId}`, {});
    if (taskPage.ok && taskPage.data) {
      const props = taskPage.data.properties;
      const projId = props['所属项目']?.relation?.[0]?.id || '';
      taskMap[taskId] = {
        person: props['负责人']?.select?.name || '',
        projectId: projId,
        taskTitle: (props['任务名称']?.title || []).map(t => t.plain_text).join('') || '',
        parentRecordId: props['【父记录】']?.relation?.[0]?.id || ''
      };
      if (projId) projectIds.add(projId);
    }
  }
  const projectMap = {};
  for (const projId of projectIds) {
    const projPage = callAPI('GET', `/v2/pages/${projId}`, {});
    if (projPage.ok && projPage.data) {
      for (const [name, val] of Object.entries(projPage.data.properties)) {
        if (val.type === 'title') { projectMap[projId] = (val.title || []).map(t => t.plain_text).join(''); break; }
      }
    }
  }

  // 获取"其它项目"下子项目名称（通过任务的【父记录】字段）
  const parentRecordIds = new Set();
  for (const taskId of taskIds) {
    const task = taskMap[taskId];
    if (task && task.parentRecordId && task.projectId && projectMap[task.projectId] === '其它项目') {
      parentRecordIds.add(task.parentRecordId);
    }
  }
  const subProjectMap = {};
  for (const prId of parentRecordIds) {
    const prPage = callAPI('GET', `/v2/pages/${prId}`, {});
    if (prPage.ok && prPage.data) {
      for (const [name, val] of Object.entries(prPage.data.properties)) {
        if (val.type === 'title') { subProjectMap[prId] = (val.title || []).map(t => t.plain_text).join(''); break; }
      }
    }
  }

  // 3.5 “其它项目”子项目识别树（项目任务表全量）+ 日报条目二级识别
  const otherTree = fetchOtherProjectTree(projectMap);
  for (const r of reportData) {
    r.suggestedSub = ''; r.suggestToken = ''; r.autoSub = '';
    if (r.projectNorm !== '其它项目') continue;
    const clean = (r.project || '').replace(/[〓〒]/g, '').trim();
    if (OTHER_PROJECT_SUBPATH[clean]) continue;   // 已有固定映射（中国诚通/集团采购）
    const hit = detectSubProject(r.taskName, r.prog, otherTree.subProjects);
    if (hit.sub) {
      r.suggestedSub = hit.sub; r.suggestToken = hit.token;
      console.log(`  [其它项目识别] ${r.person} 提到「${hit.token}」→ 找到类似项目「${hit.sub}」，确认页面将询问是否归入`);
    } else {
      r.autoSub = '其它'; r.suggestToken = hit.token;
      console.log(`  [其它项目识别] ${r.person} 提到「${hit.token || '未写明'}」→ “其它项目”下无该项目，归入 其它/【其它】`);
    }
  }

  // 4. 模版完整数据（排除张威，按任务负责人）
  const tplFullData = tplRecords.map(r => {
    const taskId = r.properties['任务名称']?.relation?.[0]?.id || '';
    const task = taskMap[taskId] || {};
    const projectName = task.projectId ? (projectMap[task.projectId] || '') : '';
    const projectNorm = normProject(projectName);
    let subProject = '';
    if (projectNorm === '其它项目' && task.parentRecordId) {
      subProject = subProjectMap[task.parentRecordId] || '';
    }
    return {
      tplId: r.id,
      taskId,
      hours: r.properties['实际投入（小时）']?.number,
      beizhuCur: (r.properties['备注']?.title || []).map(t => t.plain_text).join(''),
      person: task.person || '',
      project: projectName,
      projectNorm,
      taskTitle: (subProject && projectNorm === '其它项目' && SUBPROJECT_DISPLAY_SHOW.has(subProject)) ? `${task.taskTitle || ''}${subProject}` : (task.taskTitle || ''),
      subProject
    };
  }).filter(t => t.person !== '张威' && t.person !== '');
  console.log(`  排除张威后模版记录: ${tplFullData.length} 条`);

  // 5. 分组匹配（"其它项目"用子项目名做二级匹配）
  function getMatchKey(person, projectNorm, originalProject, subProject) {
    if (projectNorm === '其它项目') {
      let subKey = subProject || '';
      if (!subKey && originalProject) {
        const cleanName = originalProject.replace(/[〓〒]/g, '').trim();
        if (OTHER_PROJECT_SUBPATH[cleanName]) subKey = OTHER_PROJECT_SUBPATH[cleanName];
      }
      return subKey ? `${person}|||${projectNorm}|||${subKey}` : `${person}|||${projectNorm}`;
    }
    return `${person}|||${projectNorm}`;
  }
  const reportGrouped = {};
  for (const r of reportData) {
    const key = getMatchKey(r.person, r.projectNorm, r.project, r.autoSub || '');
    if (!reportGrouped[key]) reportGrouped[key] = [];
    reportGrouped[key].push(r);
  }
  const tplGrouped = {};
  for (const t of tplFullData) {
    const key = getMatchKey(t.person, t.projectNorm, '', t.subProject);
    if (!tplGrouped[key]) tplGrouped[key] = [];
    tplGrouped[key].push(t);
  }

  const rows = [];
  let idx = 1;
  for (const key of new Set([...Object.keys(reportGrouped), ...Object.keys(tplGrouped)])) {
    const parts = key.split('|||');
    const person = parts[0];
    const projectNorm = parts[1];
    const reports = reportGrouped[key] || [];
    const templates = tplGrouped[key] || [];
    const reportHours = reports.reduce((s, r) => s + (r.hours || 0), 0);
    const projDisplay = reports.length > 0 ? reports[0].project : (templates[0] ? templates[0].project : '');

    let status;
    if (templates.length === 0) status = 'report_only';          // 仅日报：日报有、模版没有 → 需人工补模版
    else if (reports.length === 0) status = 'unmatched';         // 仅模版：模版有、当日无日报 → 正常现象
    else if (templates.length > 1) status = 'multi';             // 多条模版记录，拿不准
    else {
      const cur = templates[0].hours;
      const hasVal = cur != null && cur > 0;
      // 待写入：模版没工时；待覆盖：模版有工时且与日报一致；有差异：模版有工时但对不上
      if (!hasVal) status = 'pending';
      else status = Math.abs(cur - reportHours) < 1e-9 ? 'pending_over' : 'diff';
    }

    const personTotal = personTotals[person] != null ? personTotals[person] : null;
    const row = {
      no: 0,
      key, person, project: projDisplay, projectNorm,
      reportHours, reportTaskNames: reports.map(r => r.taskName).filter(Boolean),
      reportProgs: [...new Set(reports.map(r => r.prog).filter(Boolean))],
      status,
      personTotal,
      notEight: personTotal != null && Math.abs(personTotal - 8) > 1e-9,
      suggestedSub: reports.length > 0 ? (reports[0].suggestedSub || '') : '',
      suggestToken: reports.length > 0 ? (reports[0].suggestToken || '') : '',
      autoSub: reports.length > 0 ? (reports[0].autoSub || '') : '',
      bindTargets: [],
      templates: templates.map(t => ({ tplId: t.tplId, taskTitle: t.taskTitle, currentHours: t.hours == null ? null : t.hours, beizhuCur: t.beizhuCur || '' })),
      defaultHours: reports.length > 0 ? reportHours : null,
      autoResult: null
    };
    rows.push(row);
  }

  // “其它项目”未匹配行的可归入目标（建议子项目优先，其次 其它）：
  // 模版已有该子项目行 → 绑定已有模版；否则用项目任务表里的任务新建模版记录（确认页面提交时才创建）
  for (const row of rows) {
    if (row.status !== 'report_only') continue;
    if (!row.suggestedSub && !row.autoSub) continue;
    const wantSubs = [...new Set([row.suggestedSub, row.autoSub].filter(Boolean))];
    for (const ws of wantSubs) {
      const tplRows = tplGrouped[`${row.person}|||其它项目|||${ws}`] || [];
      if (tplRows.length === 1) {
        row.bindTargets.push({ type: 'tpl', id: tplRows[0].tplId, taskTitle: tplRows[0].taskTitle, subProject: ws, label: `已有模版：其它项目-${ws}-${tplRows[0].taskTitle}` });
      } else {
        const task = otherTree.tasks.find(t => t.parentName === ws && t.person === row.person);
        if (task) row.bindTargets.push({ type: 'create', id: task.id, taskTitle: task.title, subProject: ws, label: `新建模版：其它项目-${ws}-${task.title}` });
      }
    }
  }

  // 排序：先按人员分组（同一人的行连在一起），人员内再按 待写入→待覆盖→有差异→多条→仅日报→仅模版
  const order = { pending: 1, pending_over: 2, diff: 3, multi: 4, report_only: 5, unmatched: 6 };
  rows.sort((a, b) => a.person.localeCompare(b.person, 'zh') || ((order[a.status] || 99) - (order[b.status] || 99)));
  rows.forEach(r => r.no = idx++);

  // 只要模版里已有任何数据（张威除外）或存在任何问题 → 必须人工确认，绝不自动写入
  const hasExistingData = rows.some(r => r.templates.some(t => t.currentHours != null && t.currentHours > 0));
  // 任一人当日总工时 ≠ 8 小时（不足或超过，含周彦佐 3h+5h 重复累加这类情况）→ 强制人工确认
  const notEqEight = t => Math.abs(t - 8) > 1e-9;
  const hasProblem = rows.some(r => ['diff', 'multi', 'report_only'].includes(r.status))
    || Object.values(personTotals).some(notEqEight);
  const needConfirm = hasExistingData || hasProblem;

  // 只有模版全部无数据且无任何问题时才自动写入（此时全部为空值待写入）
  let autoWritten = 0, autoFail = 0;
  if (!needConfirm) {
    for (const row of rows) {
      if (row.status !== 'pending') continue;
      const t = row.templates[0];
      if (t.currentHours > 0) continue;   // 理论上不会发生（needConfirm 已保证）
      console.log(`  [自动写入] ${row.person} / ${row.project} / ${t.taskTitle} ← ${row.reportHours}h`);
      const r = writeHours(t.tplId, row.reportHours);
      row.autoResult = r.ok ? 'ok' : 'fail';
      row.autoError = r.ok ? null : JSON.stringify(r).slice(0, 200);
      if (r.ok) { t.currentHours = row.reportHours; autoWritten++; } else autoFail++;
    }
  }

  // ===== 备注同步（任务名称+进展说明；无论 auto/confirm 都执行，但绝不覆盖已有备注）=====
  // 规则：仅单条模版记录且当天有对应日报条目的行才写；备注已有内容（含人工填写）一律跳过
  let bzWritten = 0, bzSkipExist = 0, bzNoProg = 0, bzFail = 0;
  for (const row of rows) {
    if (row.templates.length !== 1) continue;          // 无模版记录 / 多条模版 → 不动备注
    if (row.reportTaskNames.length === 0) continue;    // 仅模版行（当天无日报）→ 保持为空
    const t = row.templates[0];
    if (t.beizhuCur) { bzSkipExist++; continue; }
    const task = [...new Set(row.reportTaskNames)].join('、');
    const prog = row.reportProgs.join('\n');
    if (!prog) { bzNoProg++; continue; }
    const text = `任务名称：${task}\n进展说明：\n${prog}`;
    const w = writeBeizhu(t.tplId, text);
    if (w.ok) { t.beizhuCur = text; bzWritten++; console.log(`  [备注写入] ${row.person} / ${row.project} (${t.taskTitle})`); }
    else { bzFail++; console.log(`  [备注失败] ${row.person} / ${row.project}: ${JSON.stringify(w).slice(0,150)}`); }
  }
  console.log(`备注同步: 写入 ${bzWritten} / 已有跳过 ${bzSkipExist} / 无进展跳过 ${bzNoProg}` + (bzFail ? ` / 失败 ${bzFail}` : ''));

  const summary = {
    mode: needConfirm ? 'confirm' : 'auto',   // auto=模版全空且无问题，已自动写入；confirm=有数据或有问题，需人工确认
    pending: rows.filter(r => r.status === 'pending').length,            // 待写入：模版没工时
    pending_over: rows.filter(r => r.status === 'pending_over').length,  // 待覆盖：模版有工时且一致
    diff: rows.filter(r => r.status === 'diff').length,                  // 有差异：模版有工时但对不上
    multi: rows.filter(r => r.status === 'multi').length,
    report_only: rows.filter(r => r.status === 'report_only').length,
    unmatched: rows.filter(r => r.status === 'unmatched').length,
    notEightPersons: Object.entries(personTotals).filter(([p, t]) => notEqEight(t)).map(([p, t]) => `${p}(${t}h)`),
    hasExistingData, autoWritten, autoFail
  };

  // 简洁结果行（供 LLM 快速读取）
  const mode = needConfirm ? 'confirm' : 'auto';
  console.log(`\n[RESULT] mode=${mode} targetDate=${targetDate} autoWritten=${autoWritten} autoFail=${autoFail} pending=${summary.pending} pending_over=${summary.pending_over} diff=${summary.diff} multi=${summary.multi} report_only=${summary.report_only} notEight=${summary.notEightPersons.length}`);

  console.log('\n===== 汇总 =====');
  console.log(`模式: ${needConfirm ? 'confirm（模版有已有数据或存在问题，等待人工确认）' : 'auto（模版全空且无问题，已自动写入）'}`);
  console.log(`待写入: ${summary.pending}  待覆盖: ${summary.pending_over}  有差异: ${summary.diff}  多条模版: ${summary.multi}`);
  console.log(`仅日报: ${summary.report_only}  仅模版: ${summary.unmatched}`);
  console.log(`不等于8小时: ${summary.notEightPersons.length ? summary.notEightPersons.join('、') : '无'}`);
  if (!needConfirm) console.log(`自动写入: ${autoWritten} 成功 / ${autoFail} 失败`);

  // auto 模式（自动写入）时输出纯展示明细表（Markdown，无勾选/无输入），供对话页面直接展示；不输出"状态"列（结果列已能体现）
  if (!needConfirm) {
    console.log('\n===== 明细表（自动写入模式 · 仅展示） =====');
    console.log('| # | 人员 | 项目 | 日报工时 | 日报任务 | 模版任务 | 结果 |');
    console.log('|:--:|---|---|:--:|---|---|---|');
    for (const row of rows) {
      const hours = row.defaultHours != null ? row.defaultHours + 'h' : '—';
      const task = row.templates.map(t => t.taskTitle).join('、') || '—';
      const taskNames = row.reportTaskNames.join('、') || '—';
      let result = '—';
      if (row.status === 'pending') result = row.autoResult === 'ok' ? `✅ 已写入 ${row.defaultHours}h` : (row.autoResult === 'fail' ? `❌ 写入失败` : '—');
      else if (row.status === 'unmatched') result = '保持为空';
      console.log(`| ${row.no} | ${row.person} | ${row.project} | ${hours} | ${taskNames} | ${task} | ${result} |`);
    }
    const totals = Object.entries(personTotals).map(([p, t]) => `${p} ${t}h`).join(' / ');
    console.log(`\n8小时校验: ${totals}`);
  }

  const state = { targetDate, personTotals, summary, rows, generatedAt: new Date().toISOString() };
  const statePath = path.join(TMP_DIR, `fill_state_${targetDate}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`\n状态文件: ${statePath}`);
  return state;
}

// ===== 确认后写入 =====
function doWrite(statePath, itemsPath) {
  const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
  const results = [];
  for (const item of items) {
    const r = writeHours(item.tplId, item.hours);
    results.push({ tplId: item.tplId, hours: item.hours, ok: !!r.ok, error: r.ok ? null : (r.error || JSON.stringify(r).slice(0, 150)) });
    console.log(`[写入] ${item.tplId.slice(0,8)} ← ${item.hours}h : ${r.ok ? 'ok' : 'FAIL ' + (r.error || '')}`);
  }
  const okN = results.filter(r => r.ok).length;
  console.log(`\n写入完成: ${okN}/${results.length} 成功`);
  fs.writeFileSync(itemsPath.replace(/\.json$/, '_result.json'), JSON.stringify({ ok: okN === results.length, results }, null, 2));
  return results;
}

// ===== main =====
const arg1 = process.argv[2];
if (arg1 === 'write') {
  doWrite(process.argv[3], process.argv[4]);
} else {
  // arg1 可以是日期表达式（"昨天"、"上周五"、"8月21日"等）或 YYYY-MM-DD
  const targetDate = parseDateExpr(arg1 || '');
  console.log(`日期表达式: ${arg1 || '(默认昨天)'} → ${targetDate}`);
  try {
    analyze(targetDate);
  } catch (e) {
    if (e && e.flowusFailure) {
      reportQueryFailure(`查询 FlowUs 数据库 ${e.dbId}`, e.flowusFailure);
    } else {
      console.error(`\n❌ 执行失败：${e && e.message ? e.message : e}\n`);
    }
    process.exit(2); // 显式失败，避免被当成"无数据"继续往下走
  }
}
