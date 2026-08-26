// 日报工时回填（交互页面版）
// 用法: node fill_hours_server.js [日期]
//   - 模版里已有任何数据（张威除外）或存在任何问题 → 页面确认后写入
//   - 模版全部无数据且无问题 → 服务启动时自动写入
// 页面: http://localhost:8790  （可勾选、可改工时、提交覆盖写入；可重新分析）

const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const REPORT_DB = '1a9c4392-b5ae-48f4-aa3b-e05135215dce';
const TEMPLATE_DB = 'bc84d926-8df2-4662-9751-6a35e8761d14';
const PORT = 8790;
const TARGET_DATE = process.argv[2] || (() => {
  // 默认：昨天（北京时间）
  const beijing = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000);
  return beijing.toISOString().split('T')[0];
})();

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
  const clean = output.replace(/^\uFEFF/, '').replace(/^#<CLIXML\s*/, '').split('\n<Objs')[0];
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

function writeHours(pageId, hours) {
  return callAPI('PATCH', `/v2/pages/${pageId}`, {
    properties: { '实际投入（小时）': { type: 'number', number: hours } }
  });
}

// ===== 分析 =====
let STATE = null;

function analyze() {
  console.log(`目标日期: ${TARGET_DATE}`);

  // 1. 日报（用"日期"字段）
  const rptRecords = queryDB(REPORT_DB, {
    filter: { and: [
      { property: "日期", date: { on_or_after: shiftDate(TARGET_DATE, -2).replace(/-/g, '/') } },
      { property: "日期", date: { on_or_before: shiftDate(TARGET_DATE, 1).replace(/-/g, '/') } }
    ] },
    sorts: [{ property: "日期", direction: "ascending" }],
    page_size: 100
  });
  const dayReports = rptRecords.filter(r => {
    const d = r.properties['日期']?.date?.start || '';
    return d.startsWith(TARGET_DATE.replace(/-/g, '/')) || d.startsWith(TARGET_DATE);
  });
  console.log(`  当日日报: ${dayReports.length} 条`);

  const reportData = [];
  for (const r of dayReports) {
    const person = getPersonName(r.created_by?.id || '');
    for (let i = 1; i <= 3; i++) {
      const proj = getProp(r.properties, `项目-${i}`, 'select');
      const taskName = getProp(r.properties, `任务名称-${i}`, 'rich_text');
      const hrs = getProp(r.properties, `任务工时-${i}`, 'number');
      if (proj) reportData.push({ person, project: proj, projectNorm: normProject(proj), taskName, hours: hrs });
    }
    const opsTask = getProp(r.properties, '运维工作', 'select');
    const opsHrs = getProp(r.properties, '运维工时', 'number');
    if (opsTask) reportData.push({ person, project: '运维', projectNorm: '运维', taskName: opsTask, hours: opsHrs });
  }

  // 每人当日日报总工时（排除张威，与模版排除一致）
  const personTotals = {};
  for (const r of reportData) {
    if (r.person === '张威' || r.person.startsWith('未知')) continue;
    personTotals[r.person] = (personTotals[r.person] || 0) + (r.hours || 0);
  }
  console.log('  每人日报合计:', JSON.stringify(personTotals));

  // 2. 模版（getAutoDate 判定日期）
  const tplRaw = queryDB(TEMPLATE_DB, {
    filter: { timestamp: "created_time", created_time: { on_or_after: shiftDate(TARGET_DATE, -3) } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100
  });
  const tplRecords = tplRaw.filter(r => getAutoDate(r) === TARGET_DATE);
  console.log(`  getAutoDate=${TARGET_DATE} 的模版记录: ${tplRecords.length} 条`);

  // 3. 任务页 + 项目页
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
    else if (reports.length === 0) status = 'unmatched';         // 仅模版：模版有、当日无日报 → 正常
    else if (templates.length > 1) status = 'multi';             // 多条模版记录
    else {
      const cur = templates[0].hours;
      const hasVal = cur != null && cur > 0;
      if (!hasVal) status = 'pending';                            // 待写入：模版没工时
      else status = Math.abs(cur - reportHours) < 1e-9 ? 'pending_over' : 'diff';  // 待覆盖 / 有差异
    }

    rows.push({
      no: 0,
      key, person, project: projDisplay, projectNorm,
      reportHours, reportTaskNames: reports.map(r => r.taskName).filter(Boolean),
      status,
      personTotal: personTotals[person] != null ? personTotals[person] : null,
      underEight: personTotals[person] != null && personTotals[person] < 8,
      templates: templates.map(t => ({ tplId: t.tplId, taskTitle: t.taskTitle, currentHours: t.hours == null ? null : t.hours })),
      defaultHours: reports.length > 0 ? reportHours : null,
      autoResult: null
    });
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

  // 只有模版全部无数据且无问题时才自动写入
  let autoWritten = 0, autoFail = 0;
  if (!needConfirm) {
    for (const row of rows) {
      if (row.status !== 'pending') continue;
      const t = row.templates[0];
      if (t.currentHours != null && t.currentHours > 0) continue;
      console.log(`  [自动写入] ${row.person} / ${row.project} / ${t.taskTitle} ← ${row.reportHours}h`);
      const r = writeHours(t.tplId, row.reportHours);
      row.autoResult = r.ok ? 'ok' : 'fail';
      if (r.ok) { t.currentHours = row.reportHours; autoWritten++; } else autoFail++;
    }
  }

  const summary = {
    mode: needConfirm ? 'confirm' : 'auto',
    pending: rows.filter(r => r.status === 'pending').length,
    pending_over: rows.filter(r => r.status === 'pending_over').length,
    diff: rows.filter(r => r.status === 'diff').length,
    multi: rows.filter(r => r.status === 'multi').length,
    report_only: rows.filter(r => r.status === 'report_only').length,
    unmatched: rows.filter(r => r.status === 'unmatched').length,
    underEightPersons: Object.entries(personTotals).filter(([p, t]) => t < 8).map(([p, t]) => `${p} ${t}h`),
    autoWritten, autoFail
  };

  console.log(`模式: ${summary.mode}  待写入:${summary.pending} 待覆盖:${summary.pending_over} 有差异:${summary.diff} 多条:${summary.multi} 仅日报:${summary.report_only} 仅模版:${summary.unmatched}  不足8小时:${summary.underEightPersons.join('、') || '无'}`);

  STATE = { targetDate: TARGET_DATE, personTotals, summary, rows, generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, `fill_state_${TARGET_DATE}.json`), JSON.stringify(STATE, null, 2));
  return STATE;
}

// ===== HTML 页面 =====
const STATUS_LABEL = { pending: '待写入', pending_over: '待覆盖', diff: '有差异', multi: '多条模版', report_only: '仅日报', unmatched: '仅模版' };

function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>日报工时回填 ${TARGET_DATE}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background: #f5f6f8; color: #1f2329; padding: 24px; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #646a73; font-size: 13px; margin-bottom: 16px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
  .card { background: #fff; border-radius: 8px; padding: 10px 16px; min-width: 96px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.06); cursor: pointer; user-select: none; }
  .card.noclick { cursor: default; }
  .card:hover { box-shadow: 0 2px 6px rgba(0,0,0,.12); }
  .card.active { outline: 2px solid #3370ff; outline-offset: -2px; }
  .card .num { font-size: 20px; font-weight: 700; }
  .card .lbl { font-size: 12px; color: #646a73; margin-top: 2px; }
  .card .names { font-size: 12px; color: #e54545; font-weight: 600; margin-top: 4px; line-height: 1.4; }
  .green .num { color: #2ea463; } .red .num { color: #e54545; } .gray .num { color: #8f959e; }
  .fhint { font-size: 12px; color: #3370ff; margin: -8px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  th, td { padding: 9px 10px; font-size: 13px; text-align: left; white-space: nowrap; border-bottom: 1px solid #f0f1f3; }
  th { background: #f9fafb; color: #41464f; font-weight: 600; }
  td input[type=number] { width: 64px; padding: 4px 6px; border: 1px solid #d4d7dc; border-radius: 5px; font-size: 13px; }
  td input[type=number]:focus { outline: none; border-color: #3370ff; }
  .row-bad { background: #fff2f2; }
  .row-bad td { border-bottom-color: #ffd7d7; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .b-ok { background: #e8f7ef; color: #2ea463; }
  .b-bad { background: #fdeaea; color: #e54545; font-weight: 600; }
  .b-gray { background: #f0f1f3; color: #8f959e; }
  .cur-bad { color: #e54545; font-weight: 700; }
  .cur-ok { color: #2ea463; font-weight: 700; }
  .person { font-weight: 600; }
  .p8bad { color: #e54545; font-weight: 700; }
  .bar { margin: 14px 0; display: flex; gap: 10px; align-items: center; }
  button { padding: 8px 22px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  #submit { background: #3370ff; color: #fff; }
  #submit:disabled { background: #94b4ff; cursor: not-allowed; }
  #refresh { background: #fff; color: #3370ff; border: 1px solid #3370ff; }
  .msg { font-size: 13px; }
  .ok-text { color: #2ea463; font-weight: 600; }
  .fail-text { color: #e54545; font-weight: 600; }
  .legend { font-size: 12px; color: #8f959e; margin-top: 10px; }
  .auto-banner { background: #e8f7ef; color: #2ea463; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>日报工时回填 <span id="tdate"></span></h1>
  <div class="sub" id="subline">点击上方统计卡可筛选对应明细（再次点击取消）；勾选要写入的行（可修改工时），提交时一律覆盖写入；标红行需重点核对</div>
  <div id="autoBanner" class="auto-banner" style="display:none"></div>
  <div class="cards" id="cards"></div>
  <div class="fhint" id="fhint"></div>
  <table>
    <thead><tr>
      <th style="width:36px"></th><th style="width:34px">#</th><th>人员</th><th>项目</th>
      <th style="width:80px">日报工时</th><th>日报任务</th><th>模版任务</th><th style="width:76px">状态</th><th style="width:96px">结果</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="bar">
    <button id="submit">提交写入</button>
    <button id="refresh">重新分析</button>
    <span class="msg" id="msg"></span>
  </div>
  <div class="legend">说明：有差异 = 模版已有工时但与日报对不上（模版任务列标红显示当前工时）；待覆盖 = 已有工时与日报一致（绿色显示）；仅日报 = 日报有但模版缺记录，需先补模版；仅模版 = 当日无日报，保持为空即可（也可手动填工时勾选写入）</div>
</div>
<script>
let STATE = null;
let curFilter = null;
const STATUS_LABEL = { pending: '待写入', pending_over: '待覆盖', diff: '有差异', multi: '多条模版', report_only: '仅日报', unmatched: '仅模版' };
const FILTERS = {
  pending: r => r.status === 'pending',
  pending_over: r => r.status === 'pending_over',
  diff: r => r.status === 'diff',
  under8: r => r.underEight,
  report_only: r => r.status === 'report_only',
  unmatched: r => r.status === 'unmatched'
};
function toggleFilter(f) {
  curFilter = (curFilter === f) ? null : f;
  render();
}

async function load() {
  const r = await fetch('/state');
  STATE = await r.json();
  render();
}

function render() {
  document.getElementById('tdate').textContent = STATE.targetDate;
  const s = STATE.summary;

  // 自动写入横幅
  const banner = document.getElementById('autoBanner');
  if (s.mode === 'auto') {
    banner.style.display = 'block';
    banner.textContent = '模版全部无数据且无问题，已自动写入 ' + s.autoWritten + ' 条' + (s.autoFail ? '（失败 ' + s.autoFail + ' 条）' : '') + '。下方为写入结果。';
  }

  // 统计卡（可点击筛选，再点一次取消）
  const cards = [];
  cards.push(card('待写入', s.pending, 'green', 'pending'));
  cards.push(card('待覆盖', s.pending_over, 'green', 'pending_over'));
  cards.push(card('有差异', s.diff, 'red', 'diff'));
  if (s.underEightPersons.length) {
    cards.push('<div class="card' + (curFilter === 'under8' ? ' active' : '') + '" onclick="toggleFilter(\\'under8\\')"><div class="names">' + s.underEightPersons.map(esc).join('、') + '</div><div class="lbl">不是8小时</div></div>');
  } else {
    cards.push(card('不是8小时', '无', 'gray noclick', null));
  }
  cards.push(card('仅日报', s.report_only, 'red', 'report_only'));
  cards.push(card('仅模版', s.unmatched, 'gray', 'unmatched'));
  document.getElementById('cards').innerHTML = cards.join('');
  document.getElementById('fhint').textContent = curFilter ? ('筛选中：' + STATUS_LABEL[curFilter] + '（点击同一卡片取消筛选）') : '';

  // 明细行（按当前筛选显示）
  const tb = document.getElementById('tbody');
  tb.innerHTML = '';
  let lastPerson = null;
  for (const row of STATE.rows) {
    if (curFilter && !FILTERS[curFilter](row)) continue;
    const tr = document.createElement('tr');
    const isBad = ['diff', 'multi', 'report_only'].includes(row.status) || row.underEight;
    if (isBad) tr.className = 'row-bad';

    const t = row.templates[0] || null;
    const canWrite = !!t;   // 有模版记录才可写（多条模版取第一条，需人工核对）
    const checkedDefault = canWrite && row.status !== 'unmatched';  // 匹配行默认勾选，仅模版默认不勾

    // 模版任务列：有差异标红当前工时；待覆盖（一致）用绿色显示当前工时；为空不展示
    let tplCell = '';
    if (row.status === 'multi') {
      tplCell = (row.templates.map(x => esc(x.taskTitle)).join(' / ')) + ' <span class="cur-bad">（' + row.templates.length + '条，请核对）</span>';
    } else if (t) {
      tplCell = esc(t.taskTitle);
      if (row.status === 'diff') tplCell += ' <span class="cur-bad">当前 ' + fmtH(t.currentHours) + '</span>';
      else if (row.status === 'pending_over') tplCell += ' <span class="cur-ok">' + fmtH(t.currentHours) + '</span>';
    } else {
      tplCell = '<span class="cur-bad">无模版记录</span>';
    }

    tr.innerHTML =
      '<td>' + (canWrite ? '<input type="checkbox" class="ck" data-no="' + row.no + '"' + (checkedDefault ? ' checked' : '') + '>' : '') + '</td>' +
      '<td>' + row.no + '</td>' +
      '<td class="person' + (row.underEight ? ' p8bad' : '') + '">' + esc(row.person) + '</td>' +
      '<td>' + esc(row.project) + '</td>' +
      '<td>' + (canWrite && row.status !== 'unmatched'
          ? '<input type="number" class="hr" data-no="' + row.no + '" step="0.5" min="0" value="' + (row.defaultHours != null ? row.defaultHours : '') + '">'
          : (row.reportHours ? row.reportHours + 'h' : '—')) + '</td>' +
      '<td>' + esc(row.reportTaskNames.join('、') || '—') + '</td>' +
      '<td>' + tplCell + '</td>' +
      '<td>' + badge(row.status) + '</td>' +
      '<td class="res" id="res-' + row.no + '">' + (row.autoResult === 'ok' ? '<span class="ok-text">已自动写入</span>' : (row.autoResult === 'fail' ? '<span class="fail-text">自动写入失败</span>' : '')) + '</td>';
    tb.appendChild(tr);
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtH(h) { return (h == null ? 0 : h) + 'h'; }
function card(lbl, num, cls, fkey) {
  const act = (fkey && curFilter === fkey) ? ' active' : '';
  const click = fkey ? ' onclick="toggleFilter(\\'' + fkey + '\\')"' : '';
  return '<div class="card ' + cls + act + '"' + click + '><div class="num">' + (typeof num === 'number' ? num : esc(num)) + '</div><div class="lbl">' + esc(lbl) + '</div></div>';
}
function badge(st) {
  const cls = st === 'pending' || st === 'pending_over' ? 'b-ok' : (st === 'unmatched' ? 'b-gray' : 'b-bad');
  return '<span class="badge ' + cls + '">' + STATUS_LABEL[st] + '</span>';
}

document.getElementById('submit').addEventListener('click', async () => {
  const items = [];
  document.querySelectorAll('input.ck:checked').forEach(ck => {
    const no = ck.dataset.no;
    const hr = document.querySelector('input.hr[data-no="' + no + '"]');
    const row = STATE.rows.find(r => r.no == no);
    const t = row && row.templates[0];
    if (t && hr && hr.value !== '') items.push({ tplId: t.tplId, hours: parseFloat(hr.value), no: Number(no) });
  });
  if (!items.length) { document.getElementById('msg').textContent = '没有勾选任何行'; return; }
  if (!confirm('确认写入 ' + items.length + ' 条工时到 FlowUs 模版（覆盖已有值）？')) return;
  document.getElementById('submit').disabled = true;
  document.getElementById('msg').textContent = '写入中...';
  try {
  const r = await fetch('/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const res = await r.json();
  let okN = 0;
  const fails = [];
  for (const it of res.results) {
    const cell = document.getElementById('res-' + it.no);
    if (it.ok) {
      okN++;
      if (cell) cell.innerHTML = '<span class="ok-text">✅ 已写入 ' + it.hours + 'h</span>';
    } else {
      const reason = it.error || '未知错误';
      const row = STATE.rows.find(r2 => r2.no == it.no);
      fails.push('#' + it.no + ' ' + (row ? row.person + '/' + row.project : '') + '：' + reason);
      if (cell) cell.innerHTML = '<span class="fail-text" title="' + esc(reason) + '">❌ 失败：' + esc(reason.length > 30 ? reason.slice(0, 30) + '…' : reason) + '</span>';
    }
  }
  if (okN === res.results.length) {
    document.getElementById('msg').innerHTML = '✅ 已更新：' + okN + ' 条工时已成功写入 FlowUs 模版';
  } else if (okN > 0) {
    document.getElementById('msg').innerHTML = '⚠️ 部分更新：' + okN + '/' + res.results.length + ' 条成功，失败 ' + fails.length + ' 条：<br>' + fails.map(f => '<span class="fail-text">' + esc(f) + '</span>').join('<br>');
  } else {
    document.getElementById('msg').innerHTML = '❌ 更新失败（0 条成功）：<br>' + fails.map(f => '<span class="fail-text">' + esc(f) + '</span>').join('<br>');
  }
  } catch (e) {
    document.getElementById('msg').innerHTML = '❌ 提交异常：' + esc(e.message || String(e)) + '（服务可能已断开，请重新打开页面或联系助手）';
  }
  document.getElementById('submit').disabled = false;
});

document.getElementById('refresh').addEventListener('click', async () => {
  document.getElementById('msg').textContent = '重新分析中（约10秒）...';
  await fetch('/analyze', { method: 'POST' });
  await load();
  document.getElementById('msg').textContent = '已重新分析';
});

load();
</script>
</body>
</html>`;
}

// ===== HTTP 服务 =====
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage());
  } else if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(STATE));
  } else if (req.method === 'POST' && req.url === '/analyze') {
    analyze();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'POST' && req.url === '/write') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { items } = JSON.parse(body);
      const results = [];
      for (const item of items) {
        const r = writeHours(item.tplId, item.hours);
        const errReason = r.ok ? null : (r.error || r.msg || (r.data && r.data.error) || JSON.stringify(r).slice(0, 200));
        results.push({ no: item.no, tplId: item.tplId, hours: item.hours, ok: !!r.ok, error: errReason });
        console.log(`[写入] ${item.tplId.slice(0, 8)} ← ${item.hours}h : ${r.ok ? 'ok' : 'FAIL ' + errReason}`);
        // 更新本地状态
        if (r.ok && STATE) {
          for (const row of STATE.rows) {
            const t = row.templates.find(t => t.tplId === item.tplId);
            if (t) t.currentHours = item.hours;
          }
        }
      }
      fs.writeFileSync(path.join(__dirname, `fill_state_${TARGET_DATE}.json`), JSON.stringify(STATE, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: results.every(r => r.ok), results }));
    });
  } else {
    res.writeHead(404); res.end('not found');
  }
});

analyze();
server.listen(PORT, () => console.log(`服务已启动: http://localhost:${PORT}  目标日期: ${TARGET_DATE}`));
