'use strict';
// ===== 【请假调休】任务自动保障（2026-09-25 用户定稿）=====
//
// 触发：某人日报里存在「请假 / 调休」条目。
//
// 【归属项目规则】（用户定稿，2026-09-25 21:30）
//   按 **日报条目** 逐个判断，不是按「人·天」：
//   1) 条目自带的是 **真实项目**（不是「其它项目」）→ 直接用该项目；
//   2) 条目选了 **其它项目** → 回溯该人最近一个「有真实项目日报」的日期，
//      取当日 **工时最大** 的那个项目（例：前一天 A 项目 6h、B 项目 2h → 放 A 项目）。
//   理由（用户原话）：请假调休是算在项目成本里的，不能挂到其它项目/其它下。
//
// 【位置】目标项目 → 「其它」顶级行 → 新建任务「【请假调休】」
//   - 目标项目 **没有「其它」顶级行** → **在该项目下新建「其它」顶级行**，再挂任务（用户定稿）。
//     不再回退「其它项目 / 其它」——只有在「完全找不到真实项目锚点」时才回退。
//
// 【去重】同一「其它」行下已存在 同名 + 同负责人 → 直接复用，绝不重复建。
// 【赋值】所属项目 = 该项目 / 负责人 = 该人 / 状态 = 按实统计 /【父记录】= 该项目的「其它」行。
//
// 【安全】apply=false（默认）只预演，打印“将要创建什么”，不写任何数据。

const TASK_DB = '9686c696-3b1f-4661-bb91-fec726425c4d';   // 项目任务表
const REPORT_DB = '1a9c4392-b5ae-48f4-aa3b-e05135215dce'; // 日报表（注意是 aa3b，别写成 aa4b）
const TEMPLATE_DB = 'bc84d926-8df2-4662-9751-6a35e8761d14'; // 模版表
const OTHER_PROJECT_ID = 'b59cf01c-40d9-4ea6-9a9f-3b761ce7f5ba'; // 兜底项目 id

const LEAVE_TITLE = '【请假调休】';
const OTHER_TOP = '其它';
const LEAVE_RE = /请假|调休|休假|年休|事假|病假|婚假|产假|陪产|丧假/;
const LOOKBACK_DAYS = 21;

// 与 sync_report.js 的 PROJECT_ALIAS 保持一致（改一处请同步改另一处）
const PROJECT_ALIAS = {
  '浙能法务': '浙能法务二期',
  '非HD项目': '其它项目',
  '中国诚通': '其它项目',
  '集团采购': '其它项目',
};
function normProject(name) {
  let n = String(name || '').replace(/[〓〒]/g, '').trim();
  if (PROJECT_ALIAS[n]) n = PROJECT_ALIAS[n];
  return n;
}

function isLeaveText(...parts) { return LEAVE_RE.test(parts.filter(Boolean).join(' ')); }

function shiftDate(d, n) {
  const x = new Date(String(d) + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().split('T')[0];
}
function titleOf(props) {
  for (const v of Object.values(props || {})) {
    if (v && v.type === 'title') return (v.title || []).map(t => t.plain_text || '').join('');
  }
  return '';
}
function dayOf(start) { return String(start || '').slice(0, 10).replace(/\//g, '-'); }

// ===== 项目任务表索引（一次加载，缓存在 ctx 上）=====
function loadTaskIndex(ctx) {
  if (ctx.__leaveTaskIndex) return ctx.__leaveTaskIndex;
  const rows = ctx.queryDB(TASK_DB, { page_size: 200 });
  const projIds = [...new Set(rows.flatMap(r => (r.properties['所属项目']?.relation || []).map(x => x.id)))];
  const projName = {};
  for (const pid of projIds) {
    const p = ctx.callAPI('GET', `/v2/pages/${pid}`, {});
    projName[pid] = (p.ok && p.data) ? titleOf(p.data.properties) : '';
  }
  const topRows = {};   // projId -> [{id, name}]   顶级行（无【父记录】）
  const children = {};  // parentId -> [{id, name, person}]
  for (const r of rows) {
    const pid = (r.properties['所属项目']?.relation || [])[0]?.id || '';
    const parent = (r.properties['【父记录】']?.relation || [])[0]?.id || '';
    const t = titleOf(r.properties);
    if (!parent) (topRows[pid] = topRows[pid] || []).push({ id: r.id, name: t });
    else (children[parent] = children[parent] || []).push({
      id: r.id, name: t, person: r.properties['负责人']?.select?.name || '',
    });
  }
  const projIdByName = {};
  for (const [pid, n] of Object.entries(projName)) if (n) projIdByName[n] = pid;
  ctx.__leaveTaskIndex = { rows, projName, topRows, children, projIdByName };
  return ctx.__leaveTaskIndex;
}

function reportEntriesOf(ctx, records, person) {
  const out = [];
  for (const r of records) {
    if (ctx.getPersonName(r.created_by?.id || '') !== person) continue;
    for (let i = 1; i <= 3; i++) {
      const proj = r.properties[`项目-${i}`]?.select?.name || '';
      const taskName = (r.properties[`任务名称-${i}`]?.rich_text || []).map(x => x.plain_text || '').join('');
      const prog = (r.properties[`进展说明-${i}`]?.rich_text || []).map(x => x.plain_text || '').join('');
      const hrs = r.properties[`任务工时-${i}`]?.number || 0;
      if (!proj && !hrs) continue;
      out.push({ project: proj, projectNorm: proj ? normProject(proj) : '', taskName, prog, hours: hrs });
    }
  }
  return out;
}

// ===== 回溯锚点：该人最近一个「有真实项目」的日期，取当日工时最大的项目 =====
function resolveAnchor(ctx, person, targetDate) {
  const ck = `__anchor_${person}_${targetDate}`;
  if (ctx[ck]) return ctx[ck];
  let result;
  const from = shiftDate(targetDate, -LOOKBACK_DAYS);
  const to = shiftDate(targetDate, -1);
  let records = [];
  try {
    records = ctx.queryDB(REPORT_DB, {
      filter: {
        and: [
          { property: '日期', date: { on_or_after: from.replace(/-/g, '/') } },
          { property: '日期', date: { on_or_before: to.replace(/-/g, '/') } },
        ],
      },
      sorts: [{ property: '日期', direction: 'descending' }],
      page_size: 200,
    });
  } catch (e) {
    result = { ok: false, reason: '回溯查询日报失败：' + (e && e.message ? e.message : e) };
    ctx[ck] = result;
    return result;
  }
  const byDate = {};
  for (const r of records) {
    if (ctx.getPersonName(r.created_by?.id || '') !== person) continue;
    const d = dayOf(r.properties['日期']?.date?.start);
    if (d >= targetDate) continue;
    (byDate[d] = byDate[d] || []).push(r);
  }
  for (const d of Object.keys(byDate).sort().reverse()) {
    const entries = reportEntriesOf(ctx, byDate[d], person)
      .filter(e => e.projectNorm && e.projectNorm !== '其它项目' && !isLeaveText(e.taskName, e.prog, e.project));
    if (!entries.length) continue;
    const main = entries.sort((a, b) => (b.hours || 0) - (a.hours || 0))[0];
    result = { ok: true, fromDate: d, project: main.project, projectNorm: main.projectNorm, hours: main.hours };
    ctx[ck] = result;
    return result;
  }
  result = { ok: false, reason: `${LOOKBACK_DAYS} 天内没有该人带真实项目的日报` };
  ctx[ck] = result;
  return result;
}

// ===== 归属项目决策（条目级）=====
// entry: { project, projectNorm, taskName, prog, hours }
function resolveProjectForEntry(ctx, entry, person, targetDate) {
  if (entry.projectNorm && entry.projectNorm !== '其它项目') {
    return { ok: true, projectName: entry.projectNorm, reason: `日报自带项目「${entry.project}」→ ${entry.projectNorm}` };
  }
  const a = resolveAnchor(ctx, person, targetDate);
  if (!a.ok) return { ok: false, reason: a.reason };
  return {
    ok: true, projectName: a.projectNorm,
    reason: `日报选了「其它项目」→ 回溯到 ${a.fromDate} 工时最大的项目「${a.project} → ${a.projectNorm} ${a.hours}h」`,
  };
}

// ===== 主入口：确保该人在指定项目下有【请假调休】任务 =====
// opt: { person, projectName, apply }
function ensureLeaveTask(ctx, opt) {
  const { person, apply = false } = opt;
  let targetProject = opt.projectName;
  const idx = loadTaskIndex(ctx);
  let projId = idx.projIdByName[targetProject];
  let fallbackReason = '';

  if (!projId) {
    // 兜底：项目任务表里查不到该项目 → 退回其它项目（不该发生，保持健壮）
    fallbackReason = `项目任务表里查不到项目「${targetProject}」`;
    console.log(`  ⚠️ ${fallbackReason}，回退到「其它项目」`);
    targetProject = '其它项目';
    projId = idx.projIdByName['其它项目'] || OTHER_PROJECT_ID;
  }

  // 1) 「其它」顶级行：没有就新建（用户定稿：不回退其它项目/其它）
  let otherRow = (idx.topRows[projId] || []).find(t => t.name === OTHER_TOP);
  let otherCreated = false;
  if (!otherRow) {
    const otherPlan = `项目「${targetProject}」下没有「其它」顶级行 → 先新建该行`;
    if (!apply) {
      return {
        ok: true, taskId: null, wouldCreate: true, projectName: targetProject, fallbackReason: otherPlan,
        plan: `${otherPlan}，再在其下新建「${LEAVE_TITLE}」（负责人=${person}，状态=按实统计）`,
      };
    }
    const body = {
      parent: { database_id: TASK_DB },
      properties: {
        '任务名称': { type: 'title', title: [{ type: 'text', text: { content: OTHER_TOP } }] },
        '所属项目': { type: 'relation', relation: [{ id: projId }] },
        '状态': { type: 'select', select: { name: '未开始' } },
        '负责人': { type: 'select', select: { name: person } },
        '进度': { type: 'number', number: 0 },
      },
    };
    const res = ctx.callAPI('POST', '/v2/pages', body);
    if (!res.ok) return { ok: false, reason: '新建「其它」顶级行失败：' + JSON.stringify(res).slice(0, 300) };
    otherRow = { id: res.data.id, name: OTHER_TOP };
    otherCreated = true;
    ctx.__leaveTaskIndex = null;   // 索引失效
  }

  // 2) 【请假调休】子任务：同名 + 同负责人 已存在 → 复用
  const exist = (idx.children[otherRow.id] || []).find(c => c.name === LEAVE_TITLE && c.person === person);
  if (exist) {
    return { ok: true, taskId: exist.id, created: false, projectName: targetProject, otherRowId: otherRow.id, otherCreated, fallbackReason };
  }

  const plan = `在「${targetProject} / 其它」下新建任务「${LEAVE_TITLE}」（负责人=${person}，状态=按实统计）`;
  if (!apply) {
    return { ok: true, taskId: null, wouldCreate: true, plan, projectName: targetProject, otherRowId: otherRow.id, otherCreated, fallbackReason };
  }

  const body = {
    parent: { database_id: TASK_DB },
    properties: {
      '任务名称': { type: 'title', title: [{ type: 'text', text: { content: LEAVE_TITLE } }] },
      '【父记录】': { type: 'relation', relation: [{ id: otherRow.id }] },
      '所属项目': { type: 'relation', relation: [{ id: projId }] },
      '负责人': { type: 'select', select: { name: person } },
      '状态': { type: 'select', select: { name: '按实统计' } },
    },
  };
  const res = ctx.callAPI('POST', '/v2/pages', body);
  if (!res.ok) return { ok: false, reason: '创建任务失败：' + JSON.stringify(res).slice(0, 300) };
  ctx.__leaveTaskIndex = null;
  return { ok: true, taskId: res.data.id, created: true, plan, projectName: targetProject, otherRowId: otherRow.id, otherCreated, fallbackReason };
}

// ===== 查找已存在的模版记录（同一天 + 同一任务），避免重复创建 =====
function findExistingTpl(ctx, taskId, targetDate) {
  const d = String(targetDate).replace(/-/g, '/');
  try {
    const rows = ctx.queryDB(TEMPLATE_DB, {
      filter: {
        and: [
          { property: '填报日期', date: { on_or_after: d } },
          { property: '填报日期', date: { on_or_before: d } },
        ],
      },
      page_size: 100,
    });
    for (const r of rows) {
      if ((r.properties['任务名称']?.relation || []).some(x => x.id === taskId)) return r.id;
    }
  } catch (e) { /* 查询失败就当没有，继续走创建分支 */ }
  return null;
}

// ===== 为该任务建一条模版记录（含反向关联 同步任务名称）=====
// opt: { taskId, targetDate, apply }
function createLeaveTpl(ctx, opt) {
  const { taskId, targetDate } = opt;
  const apply = !!opt.apply;
  const existing = findExistingTpl(ctx, taskId, targetDate);
  if (existing) return { ok: true, tplId: existing, created: false, reused: true };
  if (!apply) return { ok: true, tplId: null, wouldCreate: true, plan: `新建模版记录 → 「${LEAVE_TITLE}」（填报日期=${targetDate}）` };
  const body = {
    parent: { database_id: TEMPLATE_DB },
    properties: {
      '备注': { type: 'title', title: [] },
      '任务名称': { type: 'relation', relation: [{ id: taskId }] },
      '填报日期': { type: 'date', date: { start: targetDate } },
    },
  };
  const res = ctx.callAPI('POST', '/v2/pages', body);
  if (!res.ok) return { ok: false, reason: '创建模版记录失败：' + JSON.stringify(res).slice(0, 300) };
  // 反向关联（与添加模版脚本一致：不补 同步任务名称 的话 rollup 公式算不出来）
  const t = ctx.callAPI('GET', `/v2/pages/${taskId}`, {});
  if (t.ok && t.data) {
    const cur = (t.data.properties['同步任务名称']?.relation || []).map(x => x.id);
    if (!cur.includes(res.data.id)) {
      ctx.callAPI('PATCH', `/v2/pages/${taskId}`, {
        properties: {
          '同步任务名称': { type: 'relation', relation: [...cur.map(id => ({ id })), { id: res.data.id }] },
        },
      });
    }
  }
  return { ok: true, tplId: res.data.id, created: true };
}

module.exports = {
  TASK_DB, REPORT_DB, TEMPLATE_DB, OTHER_PROJECT_ID,
  LEAVE_TITLE, OTHER_TOP, LEAVE_RE, LOOKBACK_DAYS, PROJECT_ALIAS,
  isLeaveText, normProject, shiftDate, titleOf,
  loadTaskIndex, reportEntriesOf, resolveAnchor, resolveProjectForEntry,
  ensureLeaveTask, createLeaveTpl, findExistingTpl,
};
