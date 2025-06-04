const http = require('http');
const net = require('net');
const exec = require('child_process').exec;
const request = require('request');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocket, createWebSocketStream } = require('ws');

const log = (...args) => console.log(...args);
const errorLog = (...args) => console.error(...args);

// 环境变量配置
const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, '');
const port = process.env.PORT || 7860;
const nezhaKey = process.env.NEZHA_KEY;
const nezhaServer = process.env.NEZHA_SERVER;
const argoKey = process.env.TOK;

// 下载 nezha 探针
if (nezhaKey) {
  function downloadNezha(callback) {
    const fileName = 'nezha.js';
    const url = (os.arch() === 'arm64' || os.arch() === 'arm')
      ? (process.env.URL_NEZHA2 || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-arm')
      : (process.env.URL_NEZHA || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-amd');

    const fileStream = fs.createWriteStream(fileName);
    request(url)
      .pipe(fileStream)
      .on('error', (err) => callback(`下载nezha文件失败: ${err.message}`))
      .on('close', () => callback(null));
  }

  downloadNezha((err) => {
    if (err) log(err);
    else log('nezha文件下载成功');
  });

  function keepNezhaAlive() {
    exec('pgrep -f nezha.js', (err, stdout) => {
      if (!stdout) {
        exec(`nohup node nezha.js -s ${nezhaServer}:443 -p ${nezhaKey} --tls >/dev/null 2>&1 &`, (err) => {
          if (err) log('启动nezha失败');
          else log('启动nezha成功');
        });
      }
    });
  }
  setInterval(keepNezhaAlive, 20 * 1000);
}

// 下载 cloudflared (Argo)
if (argoKey) {
  function downloadArgo(callback) {
    const fileName = 'cff.js';
    const url = (os.arch() === 'x64' || os.arch() === 'amd64')
      ? (process.env.URL_CF || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64')
      : (process.env.URL_CF2 || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64');

    const fileStream = fs.createWriteStream(fileName);
    request(url)
      .pipe(fileStream)
      .on('error', (err) => callback(`下载cloudflared失败: ${err.message}`))
      .on('close', () => callback(null));
  }

  downloadArgo((err) => {
    if (err) log(err);
    else log('cloudflared文件下载成功');
  });

  function keepArgoAlive() {
    exec('pgrep -f cff.js', (err, stdout) => {
      if (!stdout) {
        exec(`nohup ./cff.js tunnel --edge-ip-version auto run --token ${argoKey} >/dev/null 2>&1 &`, (err) => {
          if (err) log('启动cloudflared失败');
          else log('启动cloudflared成功');
        });
      }
    });
  }
  setInterval(keepArgoAlive, 20 * 1000);
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Hello World\n');
});
server.listen(port, () => log(`HTTP服务器已监听端口 ${port}`));

// 初始化 WebSocket 服务器
const wss = new WebSocket.Server({ server }, () => log('WebSocket Server started'));

// 处理 WS 连接
wss.on('connection', (ws) => {
  ws.once('message', (data) => {
    const msg = new Uint8Array(data);

    const cmd = msg[0];
    const uuidBytes = msg.slice(1, 17);
    const uuidStr = Array.from(uuidBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // UUID 验证
    if (uuid.length !== 32 || uuidStr !== uuid) {
      ws.close();
      return;
    }

    let pos = 17;
    const portNum = (msg[pos++] << 8) + msg[pos++];  // 两字节端口

    const ipType = msg[pos++];
    let targetIP = '';

    if (ipType === 1) { // IPv4
      targetIP = Array.from(msg.slice(pos, pos + 4)).join('.');
      pos += 4;
    } else if (ipType === 2) { // 域名
      const domainLen = msg[pos++];
      targetIP = new TextDecoder().decode(msg.slice(pos, pos + domainLen));
      pos += domainLen;
    } else if (ipType === 3) { // IPv6
      targetIP = Array.from({ length: 8 }, (_, i) =>
        ((msg[pos + i * 2] << 8) | msg[pos + i * 2 + 1]).toString(16)
      ).join(':');
      pos += 16;
    }

    log('连接请求:', targetIP, portNum, 'CMD:', cmd);

    const tcpConn = net.connect({ host: targetIP, port: portNum }, () => {
      log('TCP连接已建立:', targetIP, portNum);
    });

    tcpConn.on('data', (chunk) => {
      ws.send(chunk);
    });

    tcpConn.on('error', (err) => {
      log(`TCP错误(${targetIP}:${portNum}):`, err.message);
      ws.close();
    });

    tcpConn.on('close', () => {
      log('TCP连接关闭:', targetIP, portNum);
      ws.close();
    });

    ws.on('message', (data) => {
      tcpConn.write(data);
    });

    ws.on('close', () => {
      tcpConn.end();
    });
  });
});

// 捕获未处理异常
process.on('uncaughtException', (err) => {
  errorLog('未捕获异常:', err);
});
