// 纯静态文件服务：把本目录的网页文件发给同一 Wi-Fi 下的手机访问
// 仅用于局域网内查看网页，不涉及任何数据处理；不需要时直接关闭窗口即可
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8899;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('基金分析器（局域网版）已启动');
  console.log('本机访问:  http://localhost:' + PORT);
  for (const ip of ips) console.log('手机访问:  http://' + ip + ':' + PORT);
  console.log('请保持此窗口开启；用完直接关闭窗口即可。');
});
