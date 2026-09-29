const s = require('./fill_state_2026-09-28.json');
s.rows.forEach(r => {
  const tpls = r.templates.map(t => t.taskTitle + ':' + (t.currentHours || 0) + 'h').join(', ') || '无';
  console.log(`${r.no} ${r.person} | ${r.project} | ${r.status} | 日报:${r.reportHours}h | 模版:${tpls}`);
});
