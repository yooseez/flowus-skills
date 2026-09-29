const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_ID = 'bc84d926-8df2-4662-9751-6a35e8761d14';
const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const TARGET_DATE = process.argv[2];
const SET_FILL_DATE = process.argv[3] === 'true';
const SKIP_CHECK = process.argv[4] === 'skip';
const RESULT_FILE = (process.argv[4] === 'skip' || process.argv[4] === 'noskip') ? process.argv[5] : process.argv[4];

const QUERY_BODY_FILE = process.argv[6] || '';

// ===== 增量模式（2026-09-26 新增，供 sync_report.js 自动补建调用）=====
// 用法：parse_and_create.js <targetDate> <setFillDate> <resultFile> <queryBodyFile> --incremental
// 行为：目标日期已有部分记录时，不直接退出，而是对比任务 ID，只创建缺失的任务。
// 与 skip 模式互斥：skip 是删了重建，incremental 是补建缺失的。
const INCREMENTAL = process.argv.includes('--incremental') || process.env.INCREMENTAL === '1';

// ===== 请假 / 调休覆盖（2026-09-25 用户定稿）=====
// 规则：先看目标日的日报，某人是请假/调休时 ——
//   · 全天请假 → 用该人的【请假调休】任务 **替换** 从源日期复制来的普通任务（不照抄前一天任务）
//   · 部分请假（如 调休3h + 开发5h）→ 保留原有任务，并 **追加** 【请假调休】
// 共享模块与「0-同步日报」技能复用同一份，保证两边归属规则完全一致。
const LEAVE = (() => {
  try { return require('../sync-daily-report/leave_task.js'); } catch (e) { return null; }
})();
const REPORT_DB = LEAVE ? LEAVE.REPORT_DB : '1a9c4392-b5ae-48f4-aa3b-e05135215dce';
const USER_MAP = {
  "7b8d78bb-6099-4aa4-8f10-e8dfab37197e": "马少平",
  "050fae93-4c3e-4596-80f2-21c3fb100b07": "周彦佐",
  "ac9b1b06-4ed3-49b3-a2e1-d594252d2b99": "郑志伟",
  "1f0e0e61-dc10-4399-8074-b8e5f6e074a6": "李明",
  "94eb3da4-35cb-4a72-81b7-623ec15e649d": "张威",
};
const getPersonName = uid => USER_MAP[uid] || `未知(${uid ? uid.slice(0, 8) : '无'})`;

// ===== 执行结果落盘（2026-09-23 新增，供 notify_log.js 发到日志群）=====
// 写到这里而不是技能目录，避免污染技能仓库；两边路径必须保持一致。
const RESULT_OUT = process.env.ADD_TEMPLATE_RESULT || path.join(os.tmpdir(), 'add_template_result.json');
let resultWritten = false;
function writeResult(obj) {
  try {
    fs.writeFileSync(RESULT_OUT, JSON.stringify({ ts: Date.now(), targetDate: TARGET_DATE, ...obj }, null, 2), 'utf8');
    resultWritten = true;
  } catch (e) {
    // 结果文件写失败不该影响建模版本身，只在控制台提示。
    console.log(`WARN: 写执行结果失败：${e.message}`);
  }
}
// 兜底：万一脚本在没走完任何正常分支的情况下退出（异常、被杀），也留一条记录，
// 免得日志群里没动静、或一直显示上一次的旧结果。
process.on('exit', () => {
  if (resultWritten) return;
  try {
    fs.writeFileSync(RESULT_OUT, JSON.stringify(
      { ts: Date.now(), targetDate: TARGET_DATE, status: 'error', error: '脚本中途退出，未走完正常分支' }, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
});

function callAPI(method, path, body) {
  const bodyPath = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\flowus_api_${Date.now()}_${Math.random().toString(36).substr(2,5)}.json`;
  fs.writeFileSync(bodyPath, JSON.stringify(body));
  const result = spawnSync(CLI, ['--json', 'api', 'call', method, path, '--body', bodyPath], { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout || '';
  const clean = output.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
  try { return JSON.parse(clean); } catch(e) { return { ok: false, error: e.message }; }
}

// 分页查询：自动获取所有结果，直到 has_more=false
function queryAllPages(queryBodyFile) {
  const raw = fs.readFileSync(queryBodyFile, 'utf8');
  const body = JSON.parse(raw);
  let allResults = [];
  let startCursor = null;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const pageBody = { ...body };
    if (startCursor) {
      pageBody.start_cursor = startCursor;
    }

    const bodyPath = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\flowus_query_page_${pageNum}_${Date.now()}.json`;
    fs.writeFileSync(bodyPath, JSON.stringify(pageBody));

    const result = spawnSync(CLI, ['--json', 'api', 'call', 'POST', `/v2/databases/${DB_ID}/query`, '--body', bodyPath], { encoding: 'utf8', timeout: 30000 });
    const output = result.stdout || '';
    const clean = output.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      throw new Error(`QUERY_PARSE_FAILED: ${clean.slice(0, 300)}`);
    }

    // 不再静默 break：API/认证错误必须向上抛出，否则会被误判为“无数据”(NO_SOURCE_DATA)
    if (!parsed.ok || !parsed.data) {
      const detail = (parsed.error && (parsed.error.message || parsed.error.code)) || parsed.error || JSON.stringify(parsed).slice(0, 300);
      throw new Error(`QUERY_FAILED: ${detail}`);
    }
    allResults = allResults.concat(parsed.data.results || []);

    if (!parsed.data.has_more) break;
    startCursor = parsed.data.next_cursor;
  }

  return allResults;
}

// 认证探测：在判定“无数据”之前调用 whoami，排除认证失效导致的假空结果
function checkAuth() {
  const result = spawnSync(CLI, ['--json', 'whoami'], { encoding: 'utf8', timeout: 30000 });
  const output = (result.stdout || '').replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
  try {
    const parsed = JSON.parse(output);
    if (parsed && parsed.ok && parsed.data && parsed.data.id) return { ok: true };
    const detail = (parsed && parsed.error && (parsed.error.message || parsed.error.code)) || output.slice(0, 200);
    return { ok: false, error: detail };
  } catch (e) {
    return { ok: false, error: output.slice(0, 200) || e.message };
  }
}

// 如果传入了第7个参数（查询 body 文件路径），则执行分页查询获取全部数据
// 否则继续使用 RESULT_FILE（兼容旧调用方式）
let records;
try {
  if (QUERY_BODY_FILE) {
    records = queryAllPages(QUERY_BODY_FILE);
  } else {
    const raw = fs.readFileSync(RESULT_FILE, 'utf8');
    const jsonStr = raw.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
    const data = JSON.parse(jsonStr);
    records = data.data.results;
  }
} catch (e) {
  // 查询失败（含 401 认证失效）绝不输出 NO_SOURCE_DATA
  console.log(`AUTH_ERROR: ${e.message}`);
  writeResult({ status: 'auth_error', error: e.message });
  process.exit(2);
}

function getAutoDate(r) {
  const fillDate = r.properties['填报日期']?.date?.start;
  if (fillDate) return fillDate.includes('T') ? fillDate.split('T')[0].replace(/\//g, '-') : fillDate.replace(/\//g, '-');
  const beijing = new Date(new Date(r.created_time).getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().split('T')[0];
}

// 删除已有记录并清理双向关联
function deleteRecordsWithReverse(pageIds) {
  let delOk = 0, delFail = 0, revOk = 0, revFail = 0;
  const taskPageMap = {}; // taskId -> [pageId]

  // 获取每条记录对应的 task ID
  for (const pageId of pageIds) {
    const pageRes = callAPI('GET', `/v2/pages/${pageId}`, {});
    if (pageRes.ok) {
      const taskId = pageRes.data.properties['任务名称']?.relation?.[0]?.id;
      if (taskId) {
        if (!taskPageMap[taskId]) taskPageMap[taskId] = [];
        taskPageMap[taskId].push(pageId);
      }
    }
  }

  // 清理反向关联：从原任务的 同步任务名称 中移除待删除记录的 ID
  for (const [taskId, idsToRemove] of Object.entries(taskPageMap)) {
    const taskRes = callAPI('GET', `/v2/pages/${taskId}`, {});
    if (!taskRes.ok) { revFail += idsToRemove.length; continue; }
    const syncRel = taskRes.data.properties['同步任务名称']?.relation || [];
    const currentIds = syncRel.map(r => r.id);
    const filteredIds = currentIds.filter(id => !idsToRemove.includes(id));
    if (filteredIds.length === currentIds.length) { continue; } // 无需更新
    const newRelations = filteredIds.map(id => ({ id }));
    const updateRes = callAPI('PATCH', `/v2/pages/${taskId}`, {
      properties: { '同步任务名称': { type: 'relation', relation: newRelations } }
    });
    if (updateRes.ok) revOk += idsToRemove.length;
    else revFail += idsToRemove.length;
  }

  // 删除记录（移到回收站）
  for (const pageId of pageIds) {
    const delRes = callAPI('PATCH', `/v2/pages/${pageId}`, { in_trash: true });
    if (delRes.ok) delOk++;
    else delFail++;
  }

  return { delOk, delFail, revOk, revFail };
}

// 增量模式下：收集目标日期已有的任务 ID，后续创建时跳过这些任务
const existingTaskIds = new Set();

let deletedInfo = null;   // skip 模式下的删除结果，写进执行结果文件
if (!SKIP_CHECK) {
  if (INCREMENTAL) {
    // 增量模式：单独查询目标日期的已有记录（源 records 是源日期的，不能用来判断目标日期）
    try {
      // 用 created_time 往前查 30 天（覆盖提前创建的情况），再用 getAutoDate 精确匹配
      // 不用填报日期过滤是因为：有些手动创建的记录可能没设填报日期，getAutoDate 会回退用 created_time
      const d = new Date(TARGET_DATE + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 30);
      const windowFrom = d.toISOString().split('T')[0].replace(/-/g, '/');
      let allResults = [];
      let startCursor = null;
      let pageNum = 0;
      while (true) {
        pageNum++;
        const incQueryBody = {
          filter: { timestamp: "created_time", created_time: { on_or_after: windowFrom } },
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 100
        };
        if (startCursor) incQueryBody.start_cursor = startCursor;
        const incRaw = callAPI('POST', `/v2/databases/${DB_ID}/query`, incQueryBody);
        if (!incRaw.ok || !incRaw.data) {
          throw new Error(`查询失败: ${incRaw.error?.message || JSON.stringify(incRaw).slice(0,200)}`);
        }
        allResults = allResults.concat(incRaw.data.results);
        if (!incRaw.data.has_more) break;
        startCursor = incRaw.data.next_cursor;
      }
      const existingRecords = allResults.filter(r => getAutoDate(r) === TARGET_DATE);
      for (const r of existingRecords) {
        const tid = r.properties['任务名称']?.relation?.[0]?.id;
        if (tid) existingTaskIds.add(tid);
      }
      console.log(`INCREMENTAL: 目标日期已有 ${existingRecords.length} 条记录，${existingTaskIds.size} 个任务，补建缺失的（共 ${pageNum} 页/${allResults.length} 条总记录）`);
    } catch (e) {
      console.log(`INCREMENTAL_WARN: 查询目标日期出错（${e.message}），将全部创建`);
    }
  } else {
    // 普通模式（非增量非skip）：
    //   自动补建条件（同时满足）：
    //     1. 目标日期已有记录数 < 源日期的 50%（明显缺失）
    //     2. 已有记录的任务，全部都是源日期里有的（即已有记录是"应该有的"子集，没有奇怪的额外记录）
    //   满足 → 自动切换增量模式补建缺失的，不打断用户
    //   不满足 → HAS_DATA 退出，等用户确认
    const existingRecords = records.filter(r => getAutoDate(r) === TARGET_DATE);
    if (existingRecords.length) {
      // 找到源日期（target 之前最近的一个工作日）
      const byDate = {};
      for (const r of records) {
        const d = getAutoDate(r);
        if (d < TARGET_DATE) (byDate[d] = byDate[d] || []).push(r);
      }
      const dates = Object.keys(byDate).sort().reverse();
      const srcRecords = dates.length > 0 ? byDate[dates[0]] : [];
      const srcCount = srcRecords.length;
      const threshold = Math.max(3, Math.floor(srcCount * 0.5));

      // 检查已有记录的 taskId 是否都在源日期里存在
      const srcTaskIds = new Set(srcRecords.map(r => r.properties['任务名称']?.relation?.[0]?.id).filter(Boolean));
      const existingTaskIdsNow = existingRecords.map(r => r.properties['任务名称']?.relation?.[0]?.id).filter(Boolean);
      const allMatch = existingTaskIdsNow.length > 0 && existingTaskIdsNow.every(tid => srcTaskIds.has(tid));

      if (existingRecords.length < threshold && srcCount > 0 && allMatch) {
        console.log(`SPARSE_DATA: 已有 ${existingRecords.length} 条（源日期 ${dates[0]} 有 ${srcCount} 条，阈值 ${threshold}，已有记录全部匹配源日期任务）→ 自动切换增量模式补建`);
        INCREMENTAL = true;
        existingTaskIds = new Set(existingTaskIdsNow);
      } else {
        const reason = existingRecords.length >= threshold ? '数量已超阈值' : (allMatch ? '但有不匹配的任务' : '');
        console.log('HAS_DATA');
        writeResult({ status: 'has_data', existingCount: existingRecords.length, srcCount, threshold, allMatch, reason });
        process.exit(0);
      }
    }
  }
} else {
  // 用户确认继续：先删除目标日期已有记录并清理双向关联
  const existingRecords = records.filter(r => getAutoDate(r) === TARGET_DATE);
  if (existingRecords.length > 0) {
    console.log(`DELETING: ${existingRecords.length} existing records`);
    const { delOk, delFail, revOk, revFail } = deleteRecordsWithReverse(existingRecords.map(r => r.id));
    console.log(`DELETED: ${delOk} ok, ${delFail} fail`);
    console.log(`REVERSE_CLEANED: ${revOk} ok, ${revFail} fail`);
    deletedInfo = { ok: delOk, fail: delFail, reverseOk: revOk, reverseFail: revFail };
  }
}

const beforeTarget = records
  .map(r => ({ autoDate: getAutoDate(r), taskId: r.properties['任务名称']?.relation?.[0]?.id }))
  .filter(r => r.autoDate < TARGET_DATE && r.taskId);

if (beforeTarget.length === 0) {
  // 查询成功但窗口内 0 条记录：先做认证探测，确认不是认证失效造成的假空结果
  const auth = checkAuth();
  if (!auth.ok) {
    console.log(`AUTH_ERROR: whoami failed - ${auth.error}`);
    writeResult({ status: 'auth_error', error: `whoami failed - ${auth.error}` });
    process.exit(2);
  }
  console.log('NO_SOURCE_DATA');
  writeResult({ status: 'no_source' });
  process.exit(0);
}

// 分页查询（供请假调休模块复用）
function queryDBAll(dbId, body) {
  let all = [], cur = null;
  while (true) {
    const b = { ...body };
    if (cur) b.start_cursor = cur;
    const r = callAPI('POST', `/v2/databases/${dbId}/query`, b);
    if (!r.ok || !r.data) throw new Error('查询失败：' + JSON.stringify(r.error || r).slice(0, 150));
    all = all.concat(r.data.results || []);
    if (!r.data.has_more) break;
    cur = r.data.next_cursor;
  }
  return all;
}

const byDate = {};
beforeTarget.forEach(r => {
  if (!byDate[r.autoDate]) byDate[r.autoDate] = [];
  byDate[r.autoDate].push(r.taskId);
});
const sourceDate = Object.keys(byDate).sort().reverse()[0];
let taskIds = byDate[sourceDate];

// ===== 请假 / 调休覆盖 =====
// 目标日某人是请假/调休时：全天请假 → 用【请假调休】替换该人从源日期复制来的任务；
// 部分请假 → 保留原有任务并追加【请假调休】。模块缺失或查询失败时静默降级为原行为。
if (LEAVE) {
  try {
    const d = String(TARGET_DATE).replace(/-/g, '/');
    const rpt = queryDBAll(REPORT_DB, {
      filter: { and: [{ property: '日期', date: { on_or_after: d } }, { property: '日期', date: { on_or_before: d } }] },
      page_size: 100,
    });
    const byPerson = {};
    for (const r of rpt) {
      const person = getPersonName(r.created_by && r.created_by.id ? r.created_by.id : '');
      if (person.startsWith('未知') || person === '张威') continue;
      for (let i = 1; i <= 3; i++) {
        const proj = r.properties[`项目-${i}`] && r.properties[`项目-${i}`].select ? (r.properties[`项目-${i}`].select.name || '') : '';
        const taskName = ((r.properties[`任务名称-${i}`] || {}).rich_text || []).map(x => x.plain_text || '').join('');
        const prog = ((r.properties[`进展说明-${i}`] || {}).rich_text || []).map(x => x.plain_text || '').join('');
        const hrs = (r.properties[`任务工时-${i}`] || {}).number || 0;
        if (!proj && !hrs) continue;
        (byPerson[person] = byPerson[person] || []).push({
          project: proj, projectNorm: LEAVE.normProject(proj), taskName, prog, hours: hrs,
        });
      }
    }
    const ctx = { callAPI, queryDB: queryDBAll, getPersonName };
    // 源任务的负责人（用于判断“该人全天请假时该剔除哪些任务”）
    const ownerOf = {};
    for (const tid of taskIds) {
      const t = callAPI('GET', `/v2/pages/${tid}`, {});
      ownerOf[tid] = (t.ok && t.data) ? ((t.data.properties['负责人'] || {}).select || {}).name || '' : '';
    }
    const leaveTaskOf = {};
    const allDayPersons = new Set();
    for (const [person, entries] of Object.entries(byPerson)) {
      const leave = entries.filter(e => LEAVE.isLeaveText(e.taskName, e.prog, e.project));
      if (!leave.length) continue;
      const real = entries.filter(e => e.projectNorm && !LEAVE.isLeaveText(e.taskName, e.prog, e.project));
      if (real.length === 0) allDayPersons.add(person);
      // 归属项目（条目级）：自带真实项目直接用，选了「其它项目」则回溯最近真实项目中工时最大的
      const projMap = new Map();
      for (const e of leave) {
        const rp = LEAVE.resolveProjectForEntry(ctx, e, person, TARGET_DATE);
        if (!rp.ok) { console.log(`LEAVE_WARN: ${person} — ${rp.reason}`); continue; }
        if (!projMap.has(rp.projectName)) projMap.set(rp.projectName, rp.reason);
      }
      for (const [projectName, reason] of projMap) {
        const r1 = LEAVE.ensureLeaveTask(ctx, { person, projectName, apply: true });
        if (!r1.ok || !r1.taskId) { console.log(`LEAVE_WARN: ${person} / ${projectName} — ${r1.reason || '未取到任务 id'}`); continue; }
        console.log(`LEAVE: ${person} → 「${r1.projectName} / 其它 / 【请假调休】」${r1.created ? '（新建）' : '（复用）'}｜${reason}`);
        leaveTaskOf[person] = r1.taskId;
      }
    }
    if (Object.keys(leaveTaskOf).length) {
      // 2026-09-26 修复：全天请假不剔除普通任务，只追加请假调休任务
      // 之前的逻辑是把请假人员的所有普通任务都删掉，只留请假调休——这是错的
      // 正确行为：所有普通任务照常复制 + 请假的人追加一条请假调休
      const rebuilt = [...taskIds];
      for (const tid of Object.values(leaveTaskOf)) {
        if (!rebuilt.includes(tid)) rebuilt.push(tid);
      }
      console.log(`LEAVE_OVERRIDE: 原 ${taskIds.length} 条 → 现 ${rebuilt.length} 条（追加请假调休：${[...allDayPersons].join('、') || '无'}）`);
      taskIds = rebuilt;
    }
  } catch (e) {
    // 请假覆盖失败不该阻断建模版，降级为原行为
    console.log(`LEAVE_WARN: 请假调休覆盖失败，按原逻辑复制 — ${e && e.message ? e.message : e}`);
  }
}

console.log(`SOURCE_DATE: ${sourceDate}`);
console.log(`COUNT: ${taskIds.length}`);

let success = 0, failed = 0, skipped = 0;
const createdPages = [];

for (const taskId of taskIds) {
  // 增量模式：已有该任务则跳过
  if (INCREMENTAL && existingTaskIds.has(taskId)) {
    skipped++;
    continue;
  }
  const body = {
    parent: { database_id: DB_ID },
    properties: {
      '备注': { type: 'title', title: [] },
      '任务名称': { type: 'relation', relation: [{ id: taskId }] }
    }
  };
  if (SET_FILL_DATE) {
    body.properties['填报日期'] = { type: 'date', date: { start: TARGET_DATE } };
  }
  try {
    const parsed = callAPI('POST', '/v2/pages', body);
    if (parsed.ok) {
      success++;
      createdPages.push({ pageId: parsed.data.id, taskId: taskId });
    } else { failed++; }
  } catch (e) { failed++; }
}

console.log(`CREATED: ${success}`);
if (INCREMENTAL) console.log(`SKIPPED: ${skipped}（已有）`);
console.log(`FAILED: ${failed}`);

// 建立反向关联：把新记录 ID 添加到原任务的"同步任务名称"字段
if (createdPages.length > 0) {
  console.log('\nBuilding reverse relations...');
  const taskCache = {};
  let reverseOk = 0, reverseFail = 0;

  for (const { pageId, taskId } of createdPages) {
    try {
      if (!taskCache[taskId]) {
        const taskRes = callAPI('GET', `/v2/pages/${taskId}`, {});
        if (!taskRes.ok) { reverseFail++; continue; }
        const syncRel = taskRes.data.properties['同步任务名称']?.relation || [];
        taskCache[taskId] = syncRel.map(r => r.id);
      }

      if (taskCache[taskId].includes(pageId)) { reverseOk++; continue; }

      const newRelations = [...taskCache[taskId].map(id => ({ id })), { id: pageId }];
      const updateRes = callAPI('PATCH', `/v2/pages/${taskId}`, {
        properties: { '同步任务名称': { type: 'relation', relation: newRelations } }
      });
      if (updateRes.ok) {
        taskCache[taskId].push(pageId);
        reverseOk++;
      } else { reverseFail++; }
    } catch (e) { reverseFail++; }
  }

  console.log(`REVERSE_OK: ${reverseOk}`);
  console.log(`REVERSE_FAIL: ${reverseFail}`);

  writeResult({
    status: 'ok',
    sourceDate, count: taskIds.length,
    created: success, failed, skipped,
    incremental: INCREMENTAL,
    reverseOk, reverseFail, deleted: deletedInfo,
  });
} else {
  writeResult({ status: 'ok', created: 0, failed, skipped, incremental: INCREMENTAL, reverseOk: 0, reverseFail: 0, deleted: deletedInfo });
}
