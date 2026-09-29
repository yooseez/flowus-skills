// notify_log.js —— 把「添加模版」技能的执行结果发到「日报检查」日志群
// ---------------------------------------------------------------------------
// 为什么独立成一个小文件：它只做一件事（把文本 POST 到企微群机器人），
// 不依赖任何第三方包，可以被其它技能（周报/月报）直接复制复用。
//
// 用法：
//   node notify_log.js                        读默认结果文件并格式化发送
//   node notify_log.js --file=<路径>           指定结果文件
//   node notify_log.js --text="第一行\n第二行"   直接发送任意文本（不读结果文件）
//   node notify_log.js --dry-run              只打印正文，不发送（预览用）
//   node notify_log.js --webhook=<URL>        临时指定接收群（测试时给假 key）
//
// 结果文件由 parse_and_create.js 写出，默认位置：
//   %TEMP%/add_template_result.json  （两边代码保持一致，避免污染技能仓库）
//
// 收件群取值优先级（与 notify_missing.js 保持一致）：
//   --webhook=            → 环境变量 WXWORK_RUNLOG_WEBHOOK → 环境变量 WXWORK_ROBOT_WEBHOOK
//   → 配置文件 runlogwebhook → 配置文件 robotwebhook
//   配置文件查找顺序：本脚本同目录 wxwork.json → %USERPROFILE%\.workbuddy\wxwork.json
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// ===== 参数 =====
const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
}
const str = v => (v === undefined || v === true || v === '') ? '' : String(v);

// ===== 时间与日期 =====
const pad = n => String(n).padStart(2, '0');
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dowOf = d => DOW_CN[new Date(d + 'T00:00:00Z').getUTCDay()];
const shortDate = d => (d || '').slice(5);
const dayDiff = (dateStr, baseStr) =>
  Math.round((new Date(baseStr + 'T00:00:00Z') - new Date(dateStr + 'T00:00:00Z')) / 86400000);

// 相对日说法：今天 / 昨天 / 前天 / 明天 / N天前 / N天后（>7 天仍给具体天数，便于判断长假）
function relativeDayLabel(dateStr, base = beijingToday()) {
  if (!dateStr) return '';
  const diff = dayDiff(dateStr, base);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff === -1) return '明天';
  if (diff === -2) return '后天';
  if (diff > 0) return diff <= 7 ? `${diff}天前` : `${diff}天前`;
  return `${-diff}天后`;
}

// ===== 收件群 =====
function pickWebhook() {
  const file = loadConfig();
  return str(flags.webhook)
    || process.env.WXWORK_RUNLOG_WEBHOOK
    || process.env.WXWORK_ROBOT_WEBHOOK
    || file.runlogwebhook
    || file.robotwebhook
    || '';
}
function loadConfig() {
  const cands = [
    path.join(__dirname, 'wxwork.json'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.workbuddy', 'wxwork.json') : null,
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { /* 读坏了继续找下一个 */ }
  }
  return {};
}

// ===== 发送（与 notify_missing.js 的 wxRobotSend 同口径）=====
function wxRobotSend(webhook, content) {
  if (!/^https:\/\/qyapi\.weixin\.qq\.com\//.test(webhook)) {
    throw new Error(`Webhook 地址不合法（必须是 https://qyapi.weixin.qq.com/ 开头）：${String(webhook).slice(0, 80)}`);
  }
  const payload = JSON.stringify({ msgtype: 'text', text: { content } });
  return new Promise((resolve, reject) => {
    const u = new URL(webhook);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* 忽略非 JSON 响应 */ }
        resolve({ status: res.statusCode, parsed, raw: body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.end(payload);
  });
}

// ===== 结果 → 日志正文 =====
function buildText(r) {
  const lines = [];
  lines.push('【添加模版】');
  lines.push(statusLine(r));
  lines.push(`运行：${beijingNow()}`);
  const target = r.targetDate || '';
  lines.push(`模版日期：${shortDate(target)}${target ? ' ' + relativeDayLabel(target) : ''}${target ? ' ' + dowOf(target) : ''}`);

  switch (r.status) {
    case 'has_data':
      lines.push(`该日期已存在 ${r.existingCount ?? '若干'} 条记录，未创建`);
      lines.push('等待你回复「继续」后才会删除重建');
      break;
    case 'no_source':
      lines.push('回溯窗口内没有可用的源数据，未创建任何记录');
      break;
    case 'auth_error':
      lines.push(`查询 / 认证失败：${String(r.error || '未知原因').slice(0, 120)}`);
      lines.push('未创建任何记录，请检查 FlowUs 认证');
      break;
    case 'error':
      lines.push(`执行异常：${String(r.error || '未知原因').slice(0, 120)}`);
      break;
    default: {
      const src = r.sourceDate || '';
      if (src) lines.push(`源日期：${shortDate(src)} ${relativeDayLabel(src)}（${r.count ?? 0} 条）`);
      if (r.deleted && (r.deleted.ok || r.deleted.fail)) {
        lines.push(`删除旧记录：成功 ${r.deleted.ok} 条，失败 ${r.deleted.fail} 条`);
      }
      lines.push(`已创建 ${r.created ?? 0} 条，失败 ${r.failed ?? 0} 条`);
      if (r.reverseOk !== undefined || r.reverseFail !== undefined) {
        lines.push(`反向关联：成功 ${r.reverseOk ?? 0} 条，失败 ${r.reverseFail ?? 0} 条`);
      }
      if (r.failed || r.reverseFail) lines.push('有失败的条目，请到多维表核对（失败记录可能被建了一半）');
      break;
    }
  }
  return lines.join('\n');
}

function statusLine(r) {
  switch (r.status) {
    case 'has_data': return '〓需确认〓';
    case 'no_source': return '正常';
    case 'auth_error':
    case 'error': return '〓异常〓';
    default:
      return (r.failed || r.reverseFail) ? '〓异常〓' : '正常';
  }
}

// ===== 主流程 =====
(async () => {
  const dryRun = !!flags['dry-run'];
  let content = '';

  const direct = str(flags.text);
  if (direct) {
    content = direct.replace(/\\n/g, '\n');
  } else {
    const file = str(flags.file) || path.join(os.tmpdir(), 'add_template_result.json');
    let r;
    try {
      r = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`❌ 读取结果文件失败：${file} —— ${e.message}`);
      console.error('   若 parse_and_create.js 没跑（或被中断），不会有这个文件；也可改用 --text="..." 直接发送。');
      process.exit(1);
    }
    content = buildText(r);
  }

  console.log('---- 日志正文 ----');
  console.log(content);
  console.log('---- 正文结束 ----');

  if (dryRun) {
    console.log('ⓘ --dry-run：已预览，未发送。');
    return;
  }

  const webhook = pickWebhook();
  if (!webhook) {
    console.error('❌ 找不到接收群 Webhook。请检查 wxwork.json 的 runlogwebhook / robotwebhook，或用 --webhook=<URL> 指定。');
    process.exit(1);
  }
  try {
    const res = await wxRobotSend(webhook, content);
    const ok = res.parsed && res.parsed.errcode === 0;
    console.log(`HTTP ${res.status} | errcode=${res.parsed ? res.parsed.errcode : '?'} | ${ok ? '✅ 已发到日志群' : '❌ ' + (res.parsed ? res.parsed.errmsg : res.raw.slice(0, 200))}`);
    if (!ok) process.exit(3);
  } catch (e) {
    console.error(`❌ 发送失败：${e.message}`);
    process.exit(3);
  }
})();
