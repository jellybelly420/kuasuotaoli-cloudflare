# Deno 交易所代理

Cloudflare Worker 的出口 IP 会被 Binance 按地区封（451/403），因此 Binance 请求由 Worker
转发到本服务，再由本服务请求 Binance。Bybit 不需要代理（Worker 直连）。

## 部署到 Deno Deploy

代理脚本就是仓库根目录的 `main.ts`，新版 Deno Deploy 会自动识别为入口，无需选子目录。

1. Deno Deploy 关联本仓库（选整个仓库即可，入口默认就是根目录 `main.ts`）。
2. 添加环境变量 `PROXY_SECRET`，值随便设一个随机串。
3. 部署，得到 URL，例如 `https://xxx.deno.net`。

> 注意：本服务**不需要** Binance API Key——签名在 Cloudflare Worker 里完成，本服务只负责转发。

## Cloudflare Worker 侧对应配置

- `PROXY_URL` = Deno 的 URL（例如 `https://xxx.deno.net`）
- `EXCHANGE_PROXY_SECRET` = 与上面 `PROXY_SECRET` **完全一致** 的值

## 自测

```bash
curl -X POST https://xxx.deno.net/proxy \
  -H "x-proxy-secret: 你的PROXY_SECRET" -H "Content-Type: application/json" \
  -d '{"url":"https://api.binance.com/api/v3/time","method":"GET"}'
```

- 返回 `{"serverTime":...}` → 代理正常，且 Binance 未封该出口 IP。
- 返回 `{"error":"Unauthorized"}` → 密码不一致。
- 返回 451 / restricted location → Deno 出口 IP 被 Binance 封，需改用非受限地区的 VPS。
