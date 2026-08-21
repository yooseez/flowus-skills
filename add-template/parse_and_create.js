const { spawnSync } = require('child_process');
const fs = require('fs');

const DB_ID = 'bc84d926-8df2-4662-9751-6a35e8761d14';
const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const TARGET_DATE = process.argv[2];
const SET_FILL_DATE = process.argv[3] === 'true';
const SKIP_CHECK = process.argv[4] === 'skip';
const RESULT_FILE = (process.argv[4] === 'skip' || process.argv[4] === 'noskip') ? process.argv[5] : process.argv[4];

const raw = fs.readFileSync(RESULT_FILE, 'utf8');
const jsonStr = raw.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
const data = JSON.parse(jsonStr);
const records = data.data.results;

function getAutoDate(r) {
  const fillDate = r.properties['填报日期']?.date?.start;
  if (fillDate) return fillDate.includes('T') ? fillDate.split('T')[0].replace(/\//g, '-') : fillDate.replace(/\//g, '-');
  return r.created_time.split('T')[0];
}

function callAPI(method, path, body) {
  const bodyPath = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\flowus_api_${Date.now()}_${Math.random().toString(36).substr(2,5)}.json`;
  fs.writeFileSync(bodyPath, JSON.stringify(body));
  const result = spawnSync(CLI, ['--json', 'api', 'call', method, path, '--body', bodyPath], { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout || '';
  const clean = output.replace(/^\uFEFF/, '').replace(/^#< CLIXML\s*/, '').split('\n<Objs')[0];
  try { return JSON.parse(clean); } catch(e) { return { ok: false, error: e.message }; }
}

if (!SKIP_CHECK) {
  const hasTargetData = records.some(r => getAutoDate(r) === TARGET_DATE);
  if (hasTargetData) {
    console.log('HAS_DATA');
    process.exit(0);
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
// API 创建记录时只设置了单向的"任务名称"关联，不会自动更新原任务的"同步任务名称"反向关联
// 需要手动把新记录 ID 追加到原任务的"同步任务名称"relation 列表中，rollup 公式才能正确计算
if (createdPages.length > 0) {
  console.log('\nBuilding reverse relations...');
  const taskCache = {};
  let reverseOk = 0, reverseFail = 0;

  for (const { pageId, taskId } of createdPages) {
    try {
      // 读取原任务当前的"同步任务名称"列表（同一个任务只读一次）
      if (!taskCache[taskId]) {
        const taskRes = callAPI('GET', `/v2/pages/${taskId}`, {});
        if (!taskRes.ok) { reverseFail++; continue; }
        const syncRel = taskRes.data.properties['同步任务名称']?.relation || [];
        taskCache[taskId] = syncRel.map(r => r.id);
      }

      // 如果新记录 ID 已在列表中则跳过
      if (taskCache[taskId].includes(pageId)) { reverseOk++; continue; }

      // 追加新记录 ID 并更新原任务
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
