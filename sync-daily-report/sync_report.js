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
};

function callAPI(method, apiPath, body) {
  const args = ['--json', 'api', 'call', method, apiPath];
  if (body) {
    const bodyPath = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\flowus_fill_${Date.now()}_${Math.random().toString(36).substr(2,5)}.json`;
    fs.writeFileSync(bodyPath, JSON.stringify(body));
    args.push('--body', bodyPath);
  }
  const result = spawnSync(CLI, args, { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout || '';
  const clean = output.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
  try { return JSON.parse(clean); } catch(e) { return { ok: false, error: e.message }; }
}

function queryDB(dbId, filterBody) {
  let allResults = [];
  let cursor = null;
  while (true) {
    const pageBody = { ...filterBody };
    if (cursor) pageBody.start_cursor = cursor;
    const parsed = callAPI('POST', `/v2/databases/${dbId}/query`, pageBody);
    if (!parsed.ok || !parsed.data) break;
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

  const reportData = [];
  for (const r of dayReports) {
    const person = getPersonName(r.created_by?.id || '');
    for (let i = 1; i <= 3; i++) {
      const proj = getProp(r.properties, `项目-${i}`, 'select');
      const taskName = getProp(r.properties, `任务名称-${i}`, 'rich_text');
      const hrs = getProp(r.properties, `任务工时-${i}`, 'number');
      if (proj || hrs > 0) {
        const project = proj || '';
        reportData.push({ person, project, projectNorm: proj ? normProject(proj) : '', taskName, hours: hrs });
        console.log(`  [日报条目] ${person} | 项目:${proj || '(空)'} | 工时:${hrs} | 任务:${taskName || '(空)'}`);
      }
    }
    const opsTask = getProp(r.properties, '运维工作', 'select');
    const opsHrs = getProp(r.properties, '运维工时', 'number');
    if (opsTask) { reportData.push({ person, project: '运维', projectNorm: '运维', taskName: opsTask, hours: opsHrs });
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

  // 2. 模版（getAutoDate 判定日期）
  console.log('2. 查询模版...');
  const tplRaw = queryDB(TEMPLATE_DB, {
    filter: { timestamp: "created_time", created_time: { on_or_after: shiftDate(targetDate, -3) } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100
  });
  const tplRecords = tplRaw.filter(r => getAutoDate(r) === targetDate);
  console.log(`  getAutoDate=${targetDate} 的模版记录: ${tplRecords.length} 条`);

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
        taskTitle: (props['任务名称']?.title || []).map(t => t.plain_text).join('') || ''
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

  // 4. 模版完整数据（排除张威，按任务负责人）
  const tplFullData = tplRecords.map(r => {
    const taskId = r.properties['任务名称']?.relation?.[0]?.id || '';
    const task = taskMap[taskId] || {};
    return {
      tplId: r.id,
      taskId,
      hours: r.properties['实际投入（小时）']?.number,
      person: task.person || '',
      project: task.projectId ? (projectMap[task.projectId] || '') : '',
      projectNorm: normProject(task.projectId ? (projectMap[task.projectId] || '') : ''),
      taskTitle: task.taskTitle || ''
    };
  }).filter(t => t.person !== '张威' && t.person !== '');
  console.log(`  排除张威后模版记录: ${tplFullData.length} 条`);

  // 5. 分组匹配
  const reportGrouped = {};
  for (const r of reportData) {
    const key = `${r.person}|||${r.projectNorm}`;
    if (!reportGrouped[key]) reportGrouped[key] = [];
    reportGrouped[key].push(r);
  }
  const tplGrouped = {};
  for (const t of tplFullData) {
    const key = `${t.person}|||${t.projectNorm}`;
    if (!tplGrouped[key]) tplGrouped[key] = [];
    tplGrouped[key].push(t);
  }

  const rows = [];
  let idx = 1;
  for (const key of new Set([...Object.keys(reportGrouped), ...Object.keys(tplGrouped)])) {
    const [person, projectNorm] = key.split('|||');
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
      status,
      personTotal,
      underEight: personTotal != null && personTotal < 8,
      templates: templates.map(t => ({ tplId: t.tplId, taskTitle: t.taskTitle, currentHours: t.hours == null ? null : t.hours })),
      defaultHours: reports.length > 0 ? reportHours : null,
      autoResult: null
    };
    rows.push(row);
  }

  // 排序：先按人员分组（同一人的行连在一起），人员内再按 待写入→待覆盖→有差异→多条→仅日报→仅模版
  const order = { pending: 1, pending_over: 2, diff: 3, multi: 4, report_only: 5, unmatched: 6 };
  rows.sort((a, b) => a.person.localeCompare(b.person, 'zh') || ((order[a.status] || 99) - (order[b.status] || 99)));
  rows.forEach(r => r.no = idx++);

  // 只要模版里已有任何数据（张威除外）或存在任何问题 → 必须人工确认，绝不自动写入
  const hasExistingData = rows.some(r => r.templates.some(t => t.currentHours != null && t.currentHours > 0));
  const hasProblem = rows.some(r => ['diff', 'multi', 'report_only'].includes(r.status))
    || Object.values(personTotals).some(t => t < 8);
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

  const summary = {
    mode: needConfirm ? 'confirm' : 'auto',   // auto=模版全空且无问题，已自动写入；confirm=有数据或有问题，需人工确认
    pending: rows.filter(r => r.status === 'pending').length,            // 待写入：模版没工时
    pending_over: rows.filter(r => r.status === 'pending_over').length,  // 待覆盖：模版有工时且一致
    diff: rows.filter(r => r.status === 'diff').length,                  // 有差异：模版有工时但对不上
    multi: rows.filter(r => r.status === 'multi').length,
    report_only: rows.filter(r => r.status === 'report_only').length,
    unmatched: rows.filter(r => r.status === 'unmatched').length,
    underEightPersons: Object.entries(personTotals).filter(([p, t]) => t < 8).map(([p, t]) => `${p}(${t}h)`),
    hasExistingData, autoWritten, autoFail
  };

  // 简洁结果行（供 LLM 快速读取）
  const mode = needConfirm ? 'confirm' : 'auto';
  console.log(`\n[RESULT] mode=${mode} targetDate=${targetDate} autoWritten=${autoWritten} autoFail=${autoFail} pending=${summary.pending} pending_over=${summary.pending_over} diff=${summary.diff} multi=${summary.multi} report_only=${summary.report_only} underEight=${summary.underEightPersons.length}`);

  console.log('\n===== 汇总 =====');
  console.log(`模式: ${needConfirm ? 'confirm（模版有已有数据或存在问题，等待人工确认）' : 'auto（模版全空且无问题，已自动写入）'}`);
  console.log(`待写入: ${summary.pending}  待覆盖: ${summary.pending_over}  有差异: ${summary.diff}  多条模版: ${summary.multi}`);
  console.log(`仅日报: ${summary.report_only}  仅模版: ${summary.unmatched}`);
  console.log(`不足8小时: ${summary.underEightPersons.length ? summary.underEightPersons.join('、') : '无'}`);
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
  analyze(targetDate);
}
