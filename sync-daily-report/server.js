// 日报工时回填（交互页面版）
// 用法: node fill_hours_server.js [日期]
//   - 模版里已有任何数据（张威除外）或存在任何问题 → 页面确认后写入
//   - 模版全部无数据且无问题 → 服务启动时自动写入
// 页面: http://localhost:8790  （可勾选、可改工时、提交覆盖写入；可重新分析）

const http = require('http');
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
  '中国诚通': '其它项目',
  '集团采购': '其它项目',
};

// "其它项目"下子项目路径映射：日报原始项目名 → 模版任务的【父记录】名称
const OTHER_PROJECT_SUBPATH = {
  '中国诚通': '中国诚通',
  '集团采购': '公司/集团项目',
};

// 子项目显示拼接名单（2026-09-18 用户定稿）：统一规则 = 模版任务列不拼接子项目名；
// 只有仍挂在"其它"下、需要特殊标识的子项目（当前仅「公司/集团项目」）才拼接，
// 顺序为【任务类型】在前、子项目名在后。中国诚通等独立项目不在此名单，走统一规则。
// 仅影响显示，匹配逻辑不受影响。
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

// 新建模版记录（用于“其它项目”归入）：备注空 title + 任务名称关联 + 填报日期；
// 并把新记录 ID 追加到任务的「同步任务名称」反向关联（否则任务页 rollup 不计算）
function createTemplateRecord(taskId) {
  const c = callAPI('POST', '/v2/pages', {
    parent: { database_id: TEMPLATE_DB },
    properties: {
      '备注': { type: 'title', title: [] },
      '任务名称': { type: 'relation', relation: [{ id: taskId }] },
      '填报日期': { type: 'date', date: { start: TARGET_DATE } }
    }
  });
  if (!c.ok || !c.data || !c.data.id) return { ok: false, error: JSON.stringify(c).slice(0, 200) };
  const tplId = c.data.id;
  const tp = callAPI('GET', `/v2/pages/${taskId}`, {});
  if (tp.ok && tp.data) {
    const cur = (tp.data.properties['同步任务名称']?.relation || []).map(x => ({ id: x.id }));
    if (!cur.some(x => x.id === tplId)) {
      callAPI('PATCH', `/v2/pages/${taskId}`, { properties: { '同步任务名称': { type: 'relation', relation: [...cur, { id: tplId }] } } });
    }
  }
  return { ok: true, tplId };
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

// 备注同步：模版「备注」是 title 字段，写入格式固定为 任务名称+进展说明 多行文本
function writeBeizhu(pageId, text) {
  return callAPI('PATCH', `/v2/pages/${pageId}`, {
    properties: { '备注': { type: 'title', title: [{ type: 'text', text: { content: text } }] } }
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
      }
    }
    const opsTask = getProp(r.properties, '运维工作', 'select');
    const opsHrs = getProp(r.properties, '运维工时', 'number');
    if (opsTask) reportData.push({ person, project: '运维', projectNorm: '运维', taskName: opsTask, hours: opsHrs, prog: '' });
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
  if (tplRecords.length === 0) console.log('  ⓘ 本次查询成功（API 正常），该日期确实没有模版记录。');

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
      reportProgs: [...new Set(reports.map(r => r.prog).filter(Boolean))],
      status,
      personTotal: personTotals[person] != null ? personTotals[person] : null,
      notEight: personTotals[person] != null && Math.abs(personTotals[person] - 8) > 1e-9,
      suggestedSub: reports.length > 0 ? (reports[0].suggestedSub || '') : '',
      suggestToken: reports.length > 0 ? (reports[0].suggestToken || '') : '',
      autoSub: reports.length > 0 ? (reports[0].autoSub || '') : '',
      bindTargets: [],
      templates: templates.map(t => ({ tplId: t.tplId, taskTitle: t.taskTitle, currentHours: t.hours == null ? null : t.hours, beizhuCur: t.beizhuCur || '' })),
      defaultHours: reports.length > 0 ? reportHours : null,
      autoResult: null
    });
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
  // 任一人当日总工时 ≠ 8 小时（不足或超过）→ 强制人工确认，不自动写入
  const notEqEight = t => Math.abs(t - 8) > 1e-9;
  const hasExistingData = rows.some(r => r.templates.some(t => t.currentHours != null && t.currentHours > 0));
  const hasProblem = rows.some(r => ['diff', 'multi', 'report_only'].includes(r.status))
    || Object.values(personTotals).some(notEqEight);
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

  // ===== 备注同步（任务名称+进展说明；无论 auto/confirm 都执行，但绝不覆盖已有备注）=====
  let bzWritten = 0, bzSkipExist = 0, bzNoProg = 0, bzFail = 0;
  for (const row of rows) {
    if (row.templates.length !== 1) continue;
    if (row.reportTaskNames.length === 0) continue;
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
    mode: needConfirm ? 'confirm' : 'auto',
    pending: rows.filter(r => r.status === 'pending').length,
    pending_over: rows.filter(r => r.status === 'pending_over').length,
    diff: rows.filter(r => r.status === 'diff').length,
    multi: rows.filter(r => r.status === 'multi').length,
    report_only: rows.filter(r => r.status === 'report_only').length,
    unmatched: rows.filter(r => r.status === 'unmatched').length,
    notEightPersons: Object.entries(personTotals).filter(([p, t]) => notEqEight(t)).map(([p, t]) => `${p} ${t}h`),
    beizhu: { written: bzWritten, skipExist: bzSkipExist },
    autoWritten, autoFail
  };

  console.log(`模式: ${summary.mode}  待写入:${summary.pending} 待覆盖:${summary.pending_over} 有差异:${summary.diff} 多条:${summary.multi} 仅日报:${summary.report_only} 仅模版:${summary.unmatched}  不等于8小时:${summary.notEightPersons.join('、') || '无'}`);

  STATE = { targetDate: TARGET_DATE, personTotals, summary, rows, generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, `fill_state_${TARGET_DATE}.json`), JSON.stringify(STATE, null, 2));
  return STATE;
}

// ===== HTML 页面 =====
const STATUS_LABEL = { pending: '待写入', pending_over: '待覆盖', diff: '有差异', multi: '多条模版', report_only: '仅日报', unmatched: '仅模版', not8: '不等于8小时' };

function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
  /* 移动端适配（2026-09-22）：表格横向滚动、按钮加大到可点、字号放大 */
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  table { box-shadow: none; }
  @media (max-width: 640px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    .sub, .legend { font-size: 13px; line-height: 1.65; }
    .cards { gap: 8px; }
    .card { min-width: 0; flex: 1 1 44%; padding: 10px 12px; }
    .card .num { font-size: 22px; }
    th, td { padding: 11px 12px; font-size: 14px; }
    td input[type=number] { width: 78px; height: 34px; font-size: 14px; }
    .bar { flex-wrap: wrap; gap: 8px; }
    button { padding: 12px 18px; font-size: 15px; min-height: 44px; flex: 1 1 40%; }
    .legend { margin-top: 12px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>日报工时回填 <span id="tdate"></span></h1>
  <div class="sub" id="subline">点击上方统计卡可筛选对应明细（再次点击取消）；勾选要写入的行（可修改工时），提交时一律覆盖写入；标红行需重点核对</div>
  <div id="autoBanner" class="auto-banner" style="display:none"></div>
  <div class="cards" id="cards"></div>
  <div class="fhint" id="fhint"></div>
  <div class="tablewrap">
  <table>
    <thead><tr>
      <th style="width:36px"></th><th style="width:34px">#</th><th>人员</th><th>项目</th>
      <th style="width:80px">日报工时</th><th>日报任务</th><th>模版任务</th><th style="width:76px">状态</th><th style="width:96px">结果</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  </div>
  <div class="bar">
    <button id="submit">提交写入</button>
    <button id="refresh">重新分析</button>
    <span class="msg" id="msg"></span>
  </div>
  <div class="legend">说明：有差异 = 模版已有工时但与日报对不上（模版任务列标红显示当前工时）；待覆盖 = 已有工时与日报一致（绿色显示）；仅日报 = 日报有但模版缺记录——若该行出现下拉框，表示「其它项目」归入建议（绑定已有模版或新建模版记录，提交时才创建），核对归属后勾选写入；仅模版 = 当日无日报，保持为空即可（也可手动填工时勾选写入）</div>
</div>
<script>
let STATE = null;
let curFilter = null;
const STATUS_LABEL = { pending: '待写入', pending_over: '待覆盖', diff: '有差异', multi: '多条模版', report_only: '仅日报', unmatched: '仅模版', not8: '不等于8小时' };
const FILTERS = {
  pending: r => r.status === 'pending',
  pending_over: r => r.status === 'pending_over',
  diff: r => r.status === 'diff',
  not8: r => r.notEight,
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
  if (s.notEightPersons.length) {
    cards.push('<div class="card' + (curFilter === 'not8' ? ' active' : '') + '" onclick="toggleFilter(\\'not8\\')"><div class="names">' + s.notEightPersons.map(esc).join('、') + '</div><div class="lbl">不等于8小时</div></div>');
  } else {
    cards.push(card('不等于8小时', '无', 'gray noclick', null));
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
    const isBad = ['diff', 'multi', 'report_only'].includes(row.status) || row.notEight;
    if (isBad) tr.className = 'row-bad';

    const t = row.templates[0] || null;
    const canWrite = !!t;   // 有模版记录才可写（多条模版取第一条，需人工核对）
    const canBind = !canWrite && row.status === 'report_only' && (row.bindTargets || []).length > 0;  // “其它项目”归入：绑定已有模版或新建模版记录
    const writable = canWrite || canBind;
    // 匹配行默认勾选，仅模版默认不勾；自动归入其它/【其它】的行默认勾选，建议归属（找到类似项目）的行默认不勾、等人工确认
    const checkedDefault = (canWrite && row.status !== 'unmatched') || (canBind && !!row.autoSub && !row.suggestedSub);

    // 模版任务列：有差异标红当前工时；待覆盖（一致）用绿色显示当前工时；为空不展示
    let tplCell = '';
    if (row.status === 'multi') {
      tplCell = (row.templates.map(x => esc(x.taskTitle)).join(' / ')) + ' <span class="cur-bad">（' + row.templates.length + '条，请核对）</span>';
    } else if (t) {
      tplCell = esc(t.taskTitle);
      if (row.status === 'diff') tplCell += ' <span class="cur-bad">当前 ' + fmtH(t.currentHours) + '</span>';
      else if (row.status === 'pending_over') tplCell += ' <span class="cur-ok">' + fmtH(t.currentHours) + '</span>';
    } else if (canBind) {
      const opts = row.bindTargets.map(b =>
        '<option value="' + b.type + '|' + b.id + '"' + (b.subProject === (row.suggestedSub || row.autoSub) ? ' selected' : '') + '>' + esc(b.label) + '</option>'
      ).join('');
      const hint = row.suggestedSub
        ? '进展提到「' + esc(row.suggestToken || '未写明') + '」→ 找到类似项目「' + esc(row.suggestedSub) + '」，勾选即归入该项目任务'
        : '进展提到「' + esc(row.suggestToken || '未写明') + '」，其它项目下无该项目 → 归入 其它/【其它】';
      tplCell = '<div style="white-space:normal;min-width:240px"><div style="color:#b76e00;font-size:12px;margin-bottom:4px">' + hint + '</div>' +
        '<select class="bind" data-no="' + row.no + '" style="max-width:300px;padding:3px 6px;border:1px solid #d4d7dc;border-radius:5px;font-size:12px">' + opts + '</select></div>';
    } else {
      tplCell = '<span class="cur-bad">无模版记录</span>';
    }

    tr.innerHTML =
      '<td>' + (writable ? '<input type="checkbox" class="ck" data-no="' + row.no + '"' + (checkedDefault ? ' checked' : '') + '>' : '') + '</td>' +
      '<td>' + row.no + '</td>' +
      '<td class="person' + (row.notEight ? ' p8bad' : '') + '">' + esc(row.person) + '</td>' +
      '<td>' + esc(row.project) + '</td>' +
      '<td>' + (writable && row.status !== 'unmatched'
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
    if (!row || !hr || hr.value === '') return;
    const sel = document.querySelector('select.bind[data-no="' + no + '"]');
    if (sel) {
      const parts = sel.value.split('|');
      items.push({ no: Number(no), hours: parseFloat(hr.value), bindType: parts[0], bindId: parts[1] });
    } else {
      const t = row.templates[0];
      if (t) items.push({ no: Number(no), tplId: t.tplId, hours: parseFloat(hr.value) });
    }
  });
  if (!items.length) { document.getElementById('msg').textContent = '没有勾选任何行'; return; }
  const createN = items.filter(it => it.bindType === 'create').length;
  const confirmText = createN > 0
    ? '确认新建 ' + createN + ' 条模版记录，并写入 ' + items.length + ' 条工时到 FlowUs 模版（覆盖已有值）？'
    : '确认写入 ' + items.length + ' 条工时到 FlowUs 模版（覆盖已有值）？';
  if (!confirm(confirmText)) return;
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
      if (cell) cell.innerHTML = '<span class="ok-text">✅ 已写入 ' + it.hours + 'h' + (it.created ? '（含新建模版记录）' : '') + '</span>';
    } else {
      const reason = it.error || '未知错误';
      const row = STATE.rows.find(r2 => r2.no == it.no);
      fails.push('#' + it.no + ' ' + (row ? row.person + '/' + row.project : '') + '：' + reason);
      if (cell) cell.innerHTML = '<span class="fail-text" title="' + esc(reason) + '">❌ 失败：' + esc(reason.length > 30 ? reason.slice(0, 30) + '…' : reason) + '</span>';
    }
  }
  const createdN = res.results.filter(it => it.created).length;
  const createdText = createdN > 0 ? '新建 ' + createdN + ' 条模版记录，' : '';
  if (okN === res.results.length) {
    document.getElementById('msg').innerHTML = '✅ 已完成：' + createdText + okN + ' 条工时已成功写入 FlowUs 模版';
  } else if (okN > 0) {
    document.getElementById('msg').innerHTML = '⚠️ 部分完成：' + createdText + '成功写入 ' + okN + '/' + res.results.length + ' 条工时，失败 ' + fails.length + ' 条：<br>' + fails.map(f => '<span class="fail-text">' + esc(f) + '</span>').join('<br>');
  } else {
    document.getElementById('msg').innerHTML = '❌ 更新失败（0 条成功）：' + (createdN > 0 ? '（其中已新建 ' + createdN + ' 条模版记录）' : '') + '<br>' + fails.map(f => '<span class="fail-text">' + esc(f) + '</span>').join('<br>');
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
    try {
      analyze();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      const info = (e && e.flowusFailure) || null;
      if (info) reportQueryFailure(`重新分析时查询 FlowUs 数据库 ${e.dbId}`, info);
      else console.error(`\n❌ 重新分析失败：${e && e.message ? e.message : e}\n`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, failure: info }));
    }
  } else if (req.method === 'POST' && req.url === '/write') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { items } = JSON.parse(body);
      const results = [];
      for (const item of items) {
        let tplId = item.tplId || null;
        let created = false;
        // “其它项目”归入：bindType=tpl 绑定已有模版；bindType=create 先新建模版记录（含反向关联）
        if (!tplId && item.bindId) {
          if (item.bindType === 'tpl') {
            tplId = item.bindId;
          } else {
            const c = createTemplateRecord(item.bindId);
            if (c.ok) { tplId = c.tplId; created = true; console.log(`[新建模版] 任务 ${item.bindId.slice(0, 8)} → 模版记录 ${tplId.slice(0, 8)}`); }
          }
        }
        if (!tplId) {
          results.push({ no: item.no, tplId: '', hours: item.hours, ok: false, error: '模版记录创建失败' });
          console.log(`[写入] no=${item.no} : FAIL 模版记录创建失败`);
          continue;
        }
        const r = writeHours(tplId, item.hours);
        const errReason = r.ok ? null : (r.error || r.msg || (r.data && r.data.error) || JSON.stringify(r).slice(0, 200));
        // 新建模版时顺手写入备注（任务名称+进展说明），与备注同步格式一致
        if (r.ok && created && STATE) {
          const row = STATE.rows.find(x => x.no === item.no);
          if (row && row.reportTaskNames.length && row.reportProgs.length) {
            const text = `任务名称：${[...new Set(row.reportTaskNames)].join('、')}\n进展说明：\n${row.reportProgs.join('\n')}`;
            writeBeizhu(tplId, text);
          }
        }
        results.push({ no: item.no, tplId, hours: item.hours, ok: !!r.ok, error: errReason, created });
        console.log(`[写入] ${tplId.slice(0, 8)} ← ${item.hours}h : ${r.ok ? 'ok' : 'FAIL ' + errReason}${created ? '（含新建模版记录）' : ''}`);
        // 更新本地状态
        if (r.ok && STATE) {
          for (const row of STATE.rows) {
            const t = row.templates.find(t => t.tplId === tplId);
            if (t) t.currentHours = item.hours;
            if (row.no === item.no && created) row.autoResult = 'ok';
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

try {
  analyze();
} catch (e) {
  if (e && e.flowusFailure) reportQueryFailure(`启动时查询 FlowUs 数据库 ${e.dbId}`, e.flowusFailure);
  else console.error(`\n❌ 启动失败：${e && e.message ? e.message : e}\n`);
  process.exit(2); // 显式失败，避免页面把"认证故障"显示成"无数据"
}
server.listen(PORT, () => console.log(`服务已启动: http://localhost:${PORT}  目标日期: ${TARGET_DATE}`));
