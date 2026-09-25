// 生成「只读快照页」：把本机确认页（http://localhost:8790）的当前数据抓下来，
// 内嵌进 HTML 做成自包含静态页，供发布到公网在手机微信里「只看不提交」。
// 用法：node make_snapshot.js [输出目录]      （默认输出到 ./snapshot）
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SNAPSHOT_PORT || 8790);
const outDir = process.argv[2] || path.join(__dirname, 'snapshot');

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: pathname, method: 'GET', timeout: 15000 }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时：确认页服务未启动？')));
    req.end();
  });
}

function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

(async () => {
  const [html, stateRaw] = await Promise.all([get('/'), get('/state')]);
  let state;
  try { state = JSON.parse(stateRaw); }
  catch (e) { throw new Error('/state 返回的不是 JSON：' + stateRaw.slice(0, 200)); }

  const stamp = bjNow();
  // 注入数据：把 fetch('/state') 换成直接读内嵌快照
  let out = html.replace("fetch('/state')", '({json:()=>Promise.resolve(window.__SNAPSHOT__)})');
  if (out === html) console.warn('  ⚠️ 未找到 fetch(\'/state\')，快照可能仍会去请求后端');

  const safeJson = JSON.stringify(state).replace(/<\//g, '<\\/');
  const headInject = `<script>window.__SNAPSHOT__ = ${safeJson};</script>\n`;
  out = out.replace('</head>', headInject + '</head>');

  // 只读提示条 + 禁用一切可交互控件（含 render() 动态生成的）
  const banner = `<div style="background:#fff7e6;color:#a15c00;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:13px;line-height:1.6">只读快照 · 生成于 ${stamp}（北京时间） · 数据为生成时刻的快照，仅供查看，不能提交写入</div>\n`;
  out = out.replace('<div class="wrap">', '<div class="wrap">\n  ' + banner);

  const lockScript = `
<script>
(function(){
  function lock(){
    document.querySelectorAll('input,select,button').forEach(function(e){ e.disabled = true; });
    var b = document.querySelector('.bar'); if (b) b.style.display = 'none';
  }
  lock();
  if (window.MutationObserver) { new MutationObserver(lock).observe(document.documentElement, { childList:true, subtree:true }); }
  else { setInterval(lock, 500); }
})();
</script>
`;
  out = out.replace('</body>', lockScript + '</body>');

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'index.html');
  fs.writeFileSync(file, out, 'utf8');
  console.log(`  ✅ 只读快照已生成：${file}`);
  console.log(`     快照时刻：${stamp} | 目标日期：${state.targetDate} | 行数：${(state.rows || []).length} | 大小：${(out.length / 1024).toFixed(1)} KB`);
})().catch((e) => { console.error('  ❌ 生成失败：' + e.message); process.exit(1); });
