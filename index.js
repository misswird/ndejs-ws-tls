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

// 从环境变量读取必要参数，设默认值
const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, '');
const port = process.env.PORT || 7860;
const nezhaKey = process.env.NEZHA_KEY;
const nezhaServer = process.env.NEZHA_SERVER;
const argoKey = process.env.TOK;  // Argo token

// 定时保持哪吒探针连接活跃
if (nezhaKey) {
  function keepNezhaAlive() {
    exec('pidof nezha.js', (err, stdout) => {
      if (err) {
        // 如果没在运行，启动nezha.js
        exec(`chmod +x ./nezha.js && nohup ./nezha.js -s ${nezhaServer}:443 -p ${nezhaKey} --tls >/dev/null 2>&1 &`, (err) => {
          if (err) log('调起nezha-命令行执行错误');
          else log('调起nezha-命令行执行成功!');
        });
      }
    });
  }
  setInterval(keepNezhaAlive, 20 * 1000);
}

// 定时保持Argo隧道活跃
if (argoKey) {
  function keepArgoAlive() {
    exec('pidof cff.js', (err, stdout) => {
      if (err) {
        // 如果没在运行，启动cff.js
        exec(`chmod +x ./cff.js && nohup ./cff.js tunnel --edge-ip-version auto run --token ${argoKey} >/dev/null 2>&1 &`, (err) => {
          if (err) log('调起ar-go-命令行执行错误');
          else log('调起ar-go-命令行执行成功!');
        });
      }
    });
  }
  setInterval(keepArgoAlive, 20 * 1000);
}

// 下载nezha文件
if (nezhaKey) {
  function downloadNezha(callback) {
    let fileName = 'nezha.js';
    // 判断当前系统架构，选择对应文件下载地址
    let url;
    if (os.arch() === 'arm64' || os.arch() === 'arm') {
      url = process.env.URL_NEZHA2 || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-arm';
    } else {
      url = process.env.URL_NEZHA || 'https://github.com/dsadsadsss/d/releases/download/sd/nezha-amd';
    }
    const fileStream = fs.createWriteStream(path.join('./', fileName));
    request(url).pipe(fileStream).on('error', () => {
      callback('下载nez文件失败');
    }).on('close', () => {
      callback(null);
    });
  }

  downloadNezha((err) => {
    if (err) log(err);
    else log('下载nez文件成功');
  });
}

// 下载cloudflared (Argo) 文件
if (argoKey) {
  function downloadArgo(callback) {
    let fileName = 'cff.js';
    let url;
    if (os.arch() === 'x64' || os.arch() === 'amd64') {
      url = process.env.URL_CF || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
    } else {
      url = process.env.URL_CF2 || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
    }
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

// 创建HTTP服务器，用于websocket绑定
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Hello World\n');
});
server.listen(port, () => {
  log(`Server is listening on port ${port}`);
});

// WebSocket服务器初始化，绑定HTTP服务器
const wss = new WebSocket.Server({ server }, log('WebSocket Server started'));

// 用于存储TCP连接的池子，key为"ip:port"
const connectionPool = new Map();

// WebSocket连接处理
wss.on('connection', (ws) => {
  ws.once('message', (data) => {
    const msg = new Uint8Array(data);

    // 验证UUID签名（第一字节为命令标识，后面16字节为UUID的十六进制形式）
    const cmd = msg[0];
    const uuidBytes = msg.slice(1, 17);
    const uuidStr = Array.from(uuidBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    if (!uuidBytes.every((b, i) => b === parseInt(uuid.substr(i * 2, 2), 16))) {
      ws.close();
      return;
    }

    // 解析目标端口和目标IP，具体解析依赖消息格式
    let pos = 18;
    const portNum = msg[pos++] + 0x13;
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
      targetIP = Array.from(msg.slice(pos, pos + 16)).map((v, i) => i % 2 ? v.toString(16).padStart(2, '0') : '').join(':');
      pos += 16;
    }

    log('conn:', targetIP, portNum, 'cmd:', cmd);

    let tcpConn = connectionPool.get(targetIP + ':' + portNum);
    if (!tcpConn) {
      tcpConn = net.connect({ host: targetIP, port: portNum });
      connectionPool.set(targetIP + ':' + portNum, tcpConn);

      tcpConn.on('error', () => {
        log('Connection Error:', targetIP, portNum);
        connectionPool.delete(targetIP + ':' + portNum);
      });
      tcpConn.on('close', () => {
        log('Target Socket Closed:', targetIP, portNum);
        connectionPool.delete(targetIP + ':' + portNum);
      });
      tcpConn.on('data', (chunk) => {
        ws.send(chunk);
      });
    }

    ws.on('message', (data) => {
      tcpConn.write(data);
    });

    ws.on('close', () => {
      tcpConn.end();
    });
  });
});
