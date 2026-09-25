'use strict';
// wx_callback.js 的本地闭环自测：自己加密一个 echostr，按企微的验证请求格式打过去，应解密返回原文。
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const TOKEN = 'testToken123';
const AESKEY43 = Array.from(crypto.randomBytes(64), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).slice(0, 43).join(''); // 43位字母数字（企微同规格）
const CORPID = 'ww9e6fc4a3c0919b8f';
const PORT = 9022;

const key = Buffer.from(AESKEY43 + '=', 'base64');
const iv = key.slice(0, 16);
const plainMsg = 'selftest-echo-' + Date.now();
const random16 = crypto.randomBytes(16);
const msgBuf = Buffer.from(plainMsg, 'utf8');
const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32BE(msgBuf.length, 0);
const data = Buffer.concat([random16, lenBuf, msgBuf, Buffer.from(CORPID, 'utf8')]);
const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
const encrypt = Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');

const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = 'nonce123';
const sha1 = crypto.createHash('sha1');
sha1.update([TOKEN, timestamp, nonce, encrypt].sort().join(''));
const sig = sha1.digest('hex');

const srv = spawn(process.execPath, ['wx_callback.js', '--port=' + PORT, '--token=' + TOKEN, '--aeskey=' + AESKEY43], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', d => out += d);
srv.stderr.on('data', d => out += d);

setTimeout(() => {
  const path = `/wxcb?msg_signature=${sig}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(encrypt)}`;
  http.get({ host: '127.0.0.1', port: PORT, path }, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log('HTTP', res.statusCode, '| 返回与原文一致:', body === plainMsg);
      console.log('明文:', body.slice(0, 40));
      console.log('--- 服务日志 ---');
      console.log(out.trim());
      srv.kill();
      process.exit(body === plainMsg ? 0 : 1);
    });
  }).on('error', e => { console.log('请求失败:', e.message); console.log(out); srv.kill(); process.exit(1); });
}, 800);
