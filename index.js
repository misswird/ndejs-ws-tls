const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('request');

const log = (...args) => console.log(...args);

// 环境变量配置
const UUID = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, '');
const PORT = process.env.PORT || 7860;
const NEZHA_KEY = process.env.NEZHA_KEY;
const NEZHA_SERVER = process.env.NEZHA_SERVER;
const ARGO_TOKEN = process.env.TOK;

// 启动 HTTP 服务器
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});
server.listen(PORT, () => {
  log(`HTTP server is listening on port ${PORT}`);
});

// WebSocket 服务
const wss = new WebSocketServer({ server });
log('WebSocket Server started');

wss.on('connection', (ws) => {
  ws.once('message', (data) => {
    const buf = Buffer.from(data);
    const cmd = buf[0];
    const clientUUID = buf.slice(1, 17).toString('hex');

    if (clientUUID !== UUID) {
      log('Invalid UUID');
      ws.close();
      return;
    }

    let offset = 17;
    const port = buf.readUInt16BE(offset);
    offset += 2;

    const addrType = buf[offset++];
    let targetHost = '';

    if (addrType === 1) {
      targetHost = Array.from(buf.slice(offset, offset + 4)).join('.');
      offset += 4;
    } else if (addrType === 2) {
      const domainLen = buf[offset++];
      targetHost = buf.slice(offset, offset + domainLen).toString();
      offset += domainLen;
    } else if (addrType === 3) {
      targetHost = buf.slice(offset, offset + 16).toString('hex').match(/.{1,4}/g).join(':');
      offset += 16;
    } else {
      log('Unknown address type:', addrType);
      ws.close();
      return;
    }

    const conn = net.connect({ host: targetHost, port: port }, () => {
      log(`Connected to ${targetHost}:${port}`);
    });

    conn.on('data', chunk => ws.send(chunk));
    conn.on('close', () => ws.close());
    conn.on('error', err => {
      log('TCP error:', err.message);
      ws.close();
    });

    ws.on('message', msg => conn.write(msg));
    ws.on('close', () => conn.end());
  });
});

// 下载 nezha.js
if (NEZHA_KEY) {
  const url = os.arch().includes('arm') ?
    (process.env.URL_NEZHA2 || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-arm') :
    (process.env.URL_NEZHA || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-amd');
  const target = path.join(__dirname, 'nezha.js');

  request(url).pipe(fs.createWriteStream(target)).on('close', () => {
    log('下载 nezha 成功');
  });
}

// 下载 cloudflared (Argo)
if (ARGO_TOKEN) {
  const url = os.arch().includes('arm') ?
    (process.env.URL_CF2 || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64') :
    (process.env.URL_CF || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
  const target = path.join(__dirname, 'cff.js');

  request(url).pipe(fs.createWriteStream(target)).on('close', () => {
    log('下载 Argo 成功');
  });
}

// 保持 nezha 探针运行
if (NEZHA_KEY && NEZHA_SERVER) {
  setInterval(() => {
    exec('pidof nezha.js', (err) => {
      if (err) {
        exec(`chmod +x nezha.js && nohup ./nezha.js -s ${NEZHA_SERVER}:443 -p ${NEZHA_KEY} --tls > /dev/null 2>&1 &`);
        log('启动 nezha');
      }
    });
  }, 15000);
}

// 保持 Argo 隧道运行
if (ARGO_TOKEN) {
  setInterval(() => {
    exec('pidof cff.js', (err) => {
      if (err) {
        exec(`chmod +x cff.js && nohup ./cff.js tunnel --edge-ip-version auto run --token ${ARGO_TOKEN} > /dev/null 2>&1 &`);
        log('启动 Argo 隧道');
      }
    });
  }, 15000);
}
