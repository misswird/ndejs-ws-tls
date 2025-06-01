const http = require('http');
const net = require('net');
const exec = require('child_process').exec;
const request = require('request');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocket } = require('ws');

const log = (...args) => console.log(...args);
const errorLog = (...args) => console.error(...args);

// 读取环境变量
const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, '');
const port = parseInt(process.env.PORT) || 7860;
const nezhaKey = process.env.NEZHA_KEY;
const nezhaServer = process.env.NEZHA_SERVER;
const argoKey = process.env.TOK;  // Argo token

// 哪吒探针自动启动及保持活跃
if (nezhaKey) {
  function keepNezhaAlive() {
    exec('pidof nezha.js', (err, stdout) => {
      if (err || !stdout) {
        exec(`chmod +x ./nezha.js && nohup ./nezha.js -s ${nezhaServer}:443 -p ${nezhaKey} --tls >/dev/null 2>&1 &`, (err) => {
          if (err) log('调起nezha-命令行执行错误');
          else log('调起nezha-命令行执行成功!');
        });
      }
    });
  }
  keepNezhaAlive();
  setInterval(keepNezhaAlive, 20 * 1000);
}

// Argo隧道自动启动及保持活跃
if (argoKey) {
  function keepArgoAlive() {
    exec('pidof cff.js', (err, stdout) => {
      if (err || !stdout) {
        exec(`chmod +x ./cff.js && nohup ./cff.js tunnel --edge-ip-version auto run --token ${argoKey} >/dev/null 2>&1 &`, (err) => {
          if (err) log('调起ar-go-命令行执行错误');
          else log('调起ar-go-命令行执行成功!');
        });
      }
    });
  }
  keepArgoAlive();
  setInterval(keepArgoAlive, 20 * 1000);
}

// 下载nezha文件
if (nezhaKey) {
  function downloadNezha(callback) {
    const fileName = 'nezha.js';
    const url = (os.arch() === 'arm64' || os.arch() === 'arm') ?
      (process.env.URL_NEZHA2 || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-arm') :
      (process.env.URL_NEZHA || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-amd');
    const fileStream = fs.createWriteStream(path.join('./', fileName));
    request(url).pipe(fileStream).on('error', () => {
      callback('下载nez文件失败');
    }).on('close', () => {
      callback(null);
    });
  }
  downloadNezha((err) => {
    if (err) log(err);
    else log('下载nezha文件成功');
  });
}

// 下载cloudflared文件
if (argoKey) {
  function downloadArgo(callback) {
    const fileName = 'cff.js';
    const url = (os.arch() === 'x64' || os.arch() === 'amd64') ?
      (process.env.URL_CF || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64') :
      (process.env.URL_CF2 || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64');
    const fileStream = fs.createWriteStream(path.join('./', fileName));
    request(url).pipe(fileStream).on('error', () => {
      callback('下载ar-go文件失败');
    }).on('close', () => {
      callback(null);
    });
  }
  downloadArgo((err) => {
    if (err) log(err);
    else log('下载ar-go文件成功');
  });
}

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello World\n');
});

server.listen(port, () => {
  log(`HTTP server is listening on port ${port}`);
});

// WebSocket服务器
const wss = new WebSocket.Server({ server }, () => {
  log('WebSocket Server started');
});

// TCP连接池，防止重复连接同一目标
const connectionPool = new Map();

wss.on('connection', (ws) => {
  ws.once('message', (data) => {
    const msg = new Uint8Array(data);

    // 简单验证UUID（第1字节为命令，后16字节是UUID）
    const cmd = msg[0];
    const uuidBytes = msg.slice(1, 17);
    if (!uuidBytes.every((b, i) => b === parseInt(uuid.substr(i * 2, 2), 16))) {
      log('UUID验证失败，关闭连接');
      ws.close();
      return;
    }

    // 解析目标地址和端口
    let pos = 18;
    const portNum = msg[pos++] + 0x13; // 简单端口偏移
    const ipType = msg[pos++];
    let targetIP = '';

    try {
      if (ipType === 1) { // IPv4
        targetIP = Array.from(msg.slice(pos, pos + 4)).join('.');
        pos += 4;
      } else if (ipType === 2) { // 域名
        const domainLen = msg[pos++];
        targetIP = Buffer.from(msg.slice(pos, pos + domainLen)).toString();
        pos += domainLen;
      } else if (ipType === 3) { // IPv6
        targetIP = Array.from(msg.slice(pos, pos + 16))
          .map((v, i) => i % 2 === 0 ? v.toString(16).padStart(2, '0') : '')
          .join(':');
        pos += 16;
      } else {
        log('⚠️ 未知的地址类型:', ipType);
        ws.close();
        return;
      }
    } catch (e) {
      log('⚠️ 解析地址出错:', e.message);
      ws.close();
      return;
    }

    log('连接目标:', targetIP, portNum, '命令:', cmd);

    // 获取或创建TCP连接
    let tcpConn = connectionPool.get(targetIP + ':' + portNum);
    if (!tcpConn) {
      tcpConn = net.connect({ host: targetIP, port: portNum }, () => {
        log(`TCP连接建立到 ${targetIP}:${portNum}`);
      });
      connectionPool.set(targetIP + ':' + portNum, tcpConn);

      tcpConn.on('error', (err) => {
        log('TCP连接错误:', err.message, targetIP, portNum);
        connectionPool.delete(targetIP + ':' + portNum);
        try { tcpConn.destroy(); } catch {}
      });

      tcpConn.on('close', () => {
        log('TCP连接关闭:', targetIP, portNum);
        connectionPool.delete(targetIP + ':' + portNum);
      });

      tcpConn.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(chunk);
        }
      });
    }

    // WebSocket数据转发到TCP连接
    ws.on('message', (data) => {
      if (tcpConn.writable) {
        tcpConn.write(data);
      }
    });

    // 关闭事件清理
    ws.on('close', () => {
      if (tcpConn) tcpConn.end();
    });

    ws.on('error', (e) => {
      log('WebSocket错误:', e.message);
      if (tcpConn) tcpConn.end();
    });
  });
});
