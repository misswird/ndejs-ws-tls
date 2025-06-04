const http = require('http');
const net = require('net');
const exec = require('child_process').exec;
const request = require('request');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocket } = require('ws');

// 日志函数
const log = (...args) => console.log(...args);
const errorLog = (...args) => console.error(...args);

// 环境变量
const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, '');
const port = process.env.PORT || 7860;
const nezhaKey = process.env.NEZHA_KEY;
const nezhaServer = process.env.NEZHA_SERVER;
const argoKey = process.env.TOK;

// 下载哪吒探针二进制文件
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
      .on('close', () => {
        fs.chmod(fileName, 0o755, (err) => {
          if (err) callback(`设置nezha权限失败: ${err.message}`);
          else callback(null);
        });
      });
  }

  downloadNezha((err) => {
    if (err) log(err);
    else log('nezha文件下载成功');
  });

  function keepNezhaAlive() {
    exec('pidof nezha.js', (err, stdout) => {
      if (!stdout) {
        exec(`nohup ./nezha.js -s ${nezhaServer}:443 -p ${nezhaKey} --tls >/dev/null 2>&1 &`, (err) => {
          if (err) log('启动nezha失败');
          else log('启动nezha成功');
        });
      }
    });
  }
  setInterval(keepNezhaAlive, 20000);
}

// 下载 cloudflared
if (argoKey) {
  function downloadArgo(callback) {
    const fileName = 'cff.js';
    const url = (os.arch() === 'x64' || os.arch() === 'amd64')
      ? (process.env.URL_CF || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64')
      : (process.env.URL_CF2 || 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64');

    const fileStream = fs.createWriteStream(fileName);
    request(url)
      .pipe(fileStream)
      .on('error', () => callback('下载argo文件失败'))
      .on('close', () => {
        fs.chmod(fileName, 0o755, (err) => {
          if (err) callback('设置argo权限失败');
          else callback(null);
        });
      });
  }

  downloadArgo((err) => {
    if (err) log(err);
    else log('argo文件下载成功');
  });

  function keepArgoAlive() {
    exec('pidof cff.js', (err, stdout) => {
      if (!stdout) {
        exec(`nohup ./cff.js tunnel --edge-ip-version auto run --token ${argoKey} >/dev/null 2>&1 &`, (err) => {
          if (err) log('启动argo失败');
          else log('启动argo成功');
        });
      }
    });
  }
  setInterval(keepArgoAlive, 20000);
}

// 启动 HTTP 服务
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Hello World\n');
});
server.listen(port, () => log(`服务启动于端口 ${port}`));

// WebSocket 服务器
const wss = new WebSocket.Server({ server }, log('WebSocket服务器已启动'));

// WebSocket 连接池
const connectionPool = new Map();

// WebSocket 数据处理
wss.on('connection', (ws) => {
  ws.once('message', (data) => {
    const msg = new Uint8Array(data);
    const cmd = msg[0];
    const uuidBytes = msg.slice(1, 17);
    const uuidStr = Array.from(uuidBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    if (!uuidBytes.every((b, i) => b === parseInt(uuid.substr(i * 2, 2), 16))) {
      ws.close();
      return;
    }

    let pos = 18;
    const portNum = msg[pos++] + 0x13;
    const ipType = msg[pos++];
    let targetIP = '';

    if (ipType === 1) {
      targetIP = Array.from(msg.slice(pos, pos + 4)).join('.');
      pos += 4;
    } else if (ipType === 2) {
      const domainLen = msg[pos++];
      targetIP = new TextDecoder().decode(msg.slice(pos, pos + domainLen));
      pos += domainLen;
    } else if (ipType === 3) {
      targetIP = Array.from(msg.slice(pos, pos + 16)).map((v, i) => i % 2 ? v.toString(16).padStart(2, '0') : '').join(':');
      pos += 16;
    }

    log('连接目标:', targetIP, portNum, '命令:', cmd);

    let tcpConn = connectionPool.get(targetIP + ':' + portNum);
    if (!tcpConn) {
      tcpConn = net.connect({ host: targetIP, port: portNum });
      connectionPool.set(targetIP + ':' + portNum, tcpConn);

      tcpConn.on('error', () => {
        log('连接失败:', targetIP, portNum);
        connectionPool.delete(targetIP + ':' + portNum);
      });
      tcpConn.on('close', () => {
        log('目标连接关闭:', targetIP, portNum);
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
