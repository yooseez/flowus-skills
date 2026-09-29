// 检查 9-28 模版记录的填报日期原始值
const { spawnSync } = require('child_process');
const fs = require('fs');

const CLI = 'C:\\Users\\HONOR\\AppData\\Local\\Programs\\FlowUs\\bin\\flowus.exe';
const TEMPLATE_DB = 'bc84d926-8df2-4662-9751-6a35e8761d14';
const TARGET_DATE = '2026-09-28';

function callAPI(method, apiPath, body) {
  const args = ['--json', 'api', 'call', method, apiPath];
  if (body) {
    const bodyPath = `C:\\Users\\HONOR\\AppData\\Local\\Temp\\flowus_check_${Date.now()}.json`;
    fs.writeFileSync(bodyPath, JSON.stringify(body));
    args.push('--body', bodyPath);
  }
  const result = spawnSync(CLI, args, { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout || '';
  const clean = output.replace(/^\uFEFF/, '').replace(/^#<\s*CLIXML\s*/, '').split('\n<Objs')[0];
  try { return JSON.parse(clean); } catch (e) { return { ok: false, error: { message: e.message + ' raw: ' + clean.slice(0, 300) } }; }
}

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

async function main() {
  const windowFrom = shiftDate(TARGET_DATE, -14).replace(/-/g, '/');

  let allResults = [];
  let cursor = null;
  while (true) {
    const pageBody = { filter: { timestamp: "created_time", created_time: { on_or_after: windowFrom } }, sorts: [{ timestamp: "created_time", direction: "ascending" }], page_size: 100 };
    if (cursor) pageBody.start_cursor = cursor;
    const parsed = callAPI('POST', `/v2/databases/${TEMPLATE_DB}/query`, pageBody);
    if (!parsed.ok || !parsed.data) { console.log('查询失败'); return; }
    allResults = allResults.concat(parsed.data.results);
    if (!parsed.data.has_more) break;
    cursor = parsed.data.next_cursor;
  }

  const records = allResults.filter(r => getAutoDate(r) === TARGET_DATE);
  console.log(`${TARGET_DATE} 共 ${records.length} 条\n`);
  console.log('序号 | 任务ID前8位 | 填报日期原始值 | getAutoDate结果 | created_time(UTC) | created_time(北京)');
  console.log('--- | --- | --- | --- | --- | ---');
  
  records.forEach((r, i) => {
    const taskId = r.properties['任务名称']?.relation?.[0]?.id || '';
    const fillRaw = r.properties['填报日期']?.date?.start || '(空/undefined)';
    const autoDate = getAutoDate(r);
    const createdUtc = r.created_time || '';
    const createdBj = new Date(new Date(r.created_time).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    console.log(`${i+1} | ${taskId.slice(0,8)} | ${fillRaw} | ${autoDate} | ${createdUtc.slice(0,19)} | ${createdBj}`);
  });
}

main().catch(e => console.error('出错:', e.message));
