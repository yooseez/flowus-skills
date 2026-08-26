const { spawnSync } = require('child_process');
const fs = require('fs');

const DB_ID = 'bc84d926-8df2-4662-9751-6a35e8761d14';
const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const TARGET_DATE = process.argv[2];
const SET_FILL_DATE = process.argv[3] === 'true';
const SKIP_CHECK = process.argv[4] === 'skip';
const RESULT_FILE = (process.argv[4] === 'skip' || process.argv[4] === 'noskip') ? process.argv[5] : process.argv[4];

const QUERY_BODY_FILE = process.argv[6] || '';

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
    const parsed = JSON.parse(clean);

    if (!parsed.ok || !parsed.data) break;
    allResults = allResults.concat(parsed.data.results);

    if (!parsed.data.has_more) break;
    startCursor = parsed.data.next_cursor;
  }

  return allResults;
}

// 如果传入了第7个参数（查询 body 文件路径），则执行分页查询获取全部数据
// 否则继续使用 RESULT_FILE（兼容旧调用方式）
let records;
if (QUERY_BODY_FILE) {
  records = queryAllPages(QUERY_BODY_FILE);
} else {
  const raw = fs.readFileSync(RESULT_FILE, 'utf8');
  const jsonStr = raw.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
  const data = JSON.parse(jsonStr);
  records = data.data.results;
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

if (!SKIP_CHECK) {
  const hasTargetData = records.some(r => getAutoDate(r) === TARGET_DATE);
  if (hasTargetData) {
    console.log('HAS_DATA');
    process.exit(0);
  }
} else {
  // 用户确认继续：先删除目标日期已有记录并清理双向关联
  const existingRecords = records.filter(r => getAutoDate(r) === TARGET_DATE);
  if (existingRecords.length > 0) {
    console.log(`DELETING: ${existingRecords.length} existing records`);
    const { delOk, delFail, revOk, revFail } = deleteRecordsWithReverse(existingRecords.map(r => r.id));
    console.log(`DELETED: ${delOk} ok, ${delFail} fail`);
    console.log(`REVERSE_CLEANED: ${revOk} ok, ${revFail} fail`);
  }
}

const beforeTarget = records
  .map(r => ({ autoDate: getAutoDate(r), taskId: r.properties['任务名称']?.relation?.[0]?.id }))
  .filter(r => r.autoDate < TARGET_DATE && r.taskId);

if (beforeTarget.length === 0) {
  console.log('NO_SOURCE_DATA');
  process.exit(0);
}

const byDate = {};
beforeTarget.forEach(r => {
  if (!byDate[r.autoDate]) byDate[r.autoDate] = [];
  byDate[r.autoDate].push(r.taskId);
});
const sourceDate = Object.keys(byDate).sort().reverse()[0];
const taskIds = byDate[sourceDate];

console.log(`SOURCE_DATE: ${sourceDate}`);
console.log(`COUNT: ${taskIds.length}`);

let success = 0, failed = 0;
const createdPages = [];

for (const taskId of taskIds) {
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
}
