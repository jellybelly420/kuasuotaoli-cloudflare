// 交易所代理服务（Node 18+，零依赖）
// -----------------------------------------------------------------------------
// 作用：Cloudflare Worker 出口 IP 会被 Binance 按地区封（451/403）。Worker 把签好名
// 的 Binance 请求 POST 到本服务，由本服务（部署在 Binance 不封的海外 ECS 上）转发给
// Binance 再原样回传。Bybit 由 Worker 直连，不经过本服务。
//
// 协议（与 Worker 的 proxyFetch / src/index.js 的 /proxy 路由一致）：
//   POST /proxy
//   Header: x-proxy-secret: <PROXY_SECRET>
//   Body:   {"url":"...", "method":"GET", "headers":{...}, "body":null}
//   返回：原样透传上游状态码与响应体。
//   其它路径：返回 "ok"（健康检查）。
//
// 环境变量：
//   PORT          监听端口，默认 3000
//   PROXY_SECRET  鉴权密码，必须设置，且要和 Cloudflare Worker 的 EXCHANGE_PROXY_SECRET 完全一致
//
// 本服务【不需要】任何 Binance API Key —— 签名在 Cloudflare Worker 里完成。

const http = require('node:http');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PROXY_SECRET || '';

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/proxy') {
    const got = req.headers['x-proxy-secret'] || '';
    if (!SECRET || got !== SECRET) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        const { url, method = 'GET', headers = {}, body = null } = JSON.parse(raw || '{}');
        if (!url) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing url' }));
          return;
        }
        const upstream = await fetch(url, { method, headers, body: body ?? undefined });
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
    return;
  }

  // 健康检查
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

server.listen(PORT, () => console.log(`exchange proxy listening on :${PORT}`));
