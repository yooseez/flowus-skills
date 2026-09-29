#!/usr/bin/env node
/**
 * wx_callback.js — 企业微信「接收消息服务器URL」回调验证服务（未认证企业配可信IP的前置条件）
 *
 * 背景：未认证企业在配置「企业可信IP」时，企微要求先配置「可信域名」或「接收消息服务器URL」。
 *       可信域名需要 ICP 备案主体与企业主体一致（个人未认证主体走不通）；
 *       官方客服口径：未认证企业可先用 **IP 形式** 的接收消息服务器 URL，再配可信IP。
 * 本脚本就是那个回调服务：只需通过一次 URL 有效性验证（echostr 校验），之后发消息不依赖它在线。
 *
 * 用法：
 *   node wx_callback.js --port=9021 --token=后台生成的Token --aeskey=后台生成的EncodingAESKey
 *   （token/aeskey 也可写进 wxwork.json 的 "wxtoken" / "wxaeskey" 字段；corpid 自动从 wxwork.json 读）
 *
 * 后台操作路径：应用「日报提醒」→ 接收消息 →「设置API接收」
 *   URL            填  http://<公网IP>:<端口>/wxcb
 *   Token          页面「随机获取」生成（也要给本脚本）
 *   EncodingAESKey 页面「随机获取」生成（43 位，也要给本脚本）
 *   明文模式       不要勾（本脚本按加密模式实现）
 *   填完点「保存」，企微会立刻请求上面的 URL 做验证，服务在线即通过。
 *
 * 安全：脚本只做验证与丢弃，不存储任何消息内容；日志只打印时间与消息类型。
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const flags = parseArgs(process.argv.slice(2));

function loadConfig() {
  const cands = [];
  if (flags.config) cands.push(flags.config);
  cands.push(path.join(__dirname, 'wxwork.json'));
  if (process.env.USERPROFILE) cands.push(path.join(process.env.USERPROFILE, '.workbuddy', 'wxwork.json'));
  for (const f of cands) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* try next */ }
  }
  return {};
}
const cfg = loadConfig();

const PORT = parseInt(flags.port || cfg.wxport || '9021', 10);
const TOKEN = flags.token || cfg.wxtoken || '';
const AESKEY_B64 = (flags.aeskey || cfg.wxaeskey || '') + '='; // 43 位补一个 = 成 44 位 base64
const CORPID = flags.corpid || cfg.corpid || '';

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(2);
}
if (!TOKEN) die('缺少 Token：后台「设置API接收」页生成后用 --token= 传入，或写进 wxwork.json 的 wxtoken');
if (!/^[A-Za-z0-9]{43}$/.test(flags.aeskey || cfg.wxaeskey || '')) die('缺少/格式错误的 EncodingAESKey：须为 43 位字母数字，用 --aeskey= 传入，或写进 wxwork.json 的 wxaeskey');
if (!CORPID) die('缺少 corpid：请确认 wxwork.json 可读且含 corpid');

let AES_KEY;
try {
  AES_KEY = Buffer.from(AESKEY_B64, 'base64');
  if (AES_KEY.length !== 32) throw new Error('key length ' + AES_KEY.length);
} catch (e) {
  die('EncodingAESKey 解码失败：' + e.message);
}
const IV = AES_KEY.slice(0, 16);

// ---------- 加解密（对齐官方 WXBizMsgCrypt） ----------
function signature(token, timestamp, nonce, encrypt) {
  const sha1 = crypto.createHash('sha1');
  sha1.update([token, timestamp, nonce, encrypt].sort().join(''));
  return sha1.digest('hex');
}

function decrypt(encryptB64) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, IV);
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(Buffer.from(encryptB64, 'base64')), decipher.final()]);
  // PKCS#7 去填充
  const pad = buf[buf.length - 1];
  const plain = buf.slice(0, buf.length - pad);
  // 明文结构：random(16) + msg_len(4, 网络序) + msg + receiveid(corpid)
  if (plain.length < 20) throw new Error('解密后长度异常');
  const msgLen = plain.readUInt32BE(16);
  const msg = plain.slice(20, 20 + msgLen).toString('utf8');
  const receiveid = plain.slice(20 + msgLen).toString('utf8');
  return { msg, receiveid };
}

function verifySig(query, encrypt) {
  const sig = signature(TOKEN, query.timestamp, query.nonce, encrypt);
  return sig === query.msg_signature;
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const q = u.query || {};
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  if (req.method === 'GET') {
    // URL 有效性验证：校验签名 → 解密 echostr → 明文原样返回
    if (!q.msg_signature || !q.echostr) {
      res.writeHead(400); res.end('bad request'); return;
    }
    try {
      if (!verifySig(q, q.echostr)) throw new Error('签名校验失败');
      const { msg, receiveid } = decrypt(q.echostr);
      if (receiveid !== CORPID) console.log(`  [${ts}] ⚠️ receiveid(${receiveid}) 与 corpid(${CORPID}) 不一致（仍返回明文）`);
      console.log(`  [${ts}] ✅ URL 验证通过（echostr 解密成功，长度 ${msg.length}）`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
    } catch (e) {
      console.log(`  [${ts}] ❌ 验证失败：${e.message}`);
      res.writeHead(400); res.end('fail');
    }
    return;
  }

  if (req.method === 'POST') {
    // 接收消息：验证签名 → 解密 → 丢弃，回空 200
    let body = '';
    req.on('data', c => { body += c; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const m = body.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/);
        const encrypt = m ? m[1] : (body.match(/<Encrypt>([\s\S]*?)<\/Encrypt>/) || [])[1];
        if (!encrypt) throw new Error('未找到 Encrypt 字段');
        if (!verifySig(q, encrypt)) throw new Error('签名校验失败');
        const { msg } = decrypt(encrypt);
        const type = (msg.match(/<MsgType><!\[CDATA\[([\s\S]*?)\]\]><\/MsgType>/) || [])[1] || 'unknown';
        console.log(`  [${ts}] 收到消息（${type}），已忽略`);
      } catch (e) {
        console.log(`  [${ts}] ⚠️ POST 处理失败：${e.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('');
    });
    return;
  }

  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log('【企微回调验证服务】已启动');
  console.log(`  监听端口：${PORT}`);
  console.log(`  corpid  ：${CORPID}`);
  console.log(`  token   ：${TOKEN.slice(0, 3)}****${TOKEN.slice(-3)}`);
  console.log(`  aeskey  ：${(flags.aeskey || cfg.wxaeskey || '').slice(0, 4)}****`);
  console.log(`  后台「设置API接收」的 URL 请填：http://<你的公网IP>:${PORT}/wxcb`);
  console.log('  等待企微验证请求…（Ctrl+C 停止）');
});
