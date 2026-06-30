// Deno Deploy 交易所代理
// -----------------------------------------------------------------------------
// 作用：Cloudflare Worker 的出口 IP 会被 Binance 按地区封（451/403），
// 所以 Worker 把签好名的请求 POST 到这里，由本服务转发给 Binance 再回传。
//
// 部署：在 Deno Deploy 项目里把「入口文件 / Entrypoint」设为 deno-proxy/main.ts。
// 环境变量：只需 PROXY_SECRET（要和 Cloudflare Worker 的 EXCHANGE_PROXY_SECRET 完全一致）。
//
// 协议（与 Worker 的 proxyFetch 约定一致）：
//   POST /proxy
//   Header: x-proxy-secret: <PROXY_SECRET>
//   Body:   {"url": "...", "method": "GET", "headers": {...}, "body": null}
// 返回：原样透传 Binance 的状态码与响应体。

Deno.serve(async (req) => {
  const { pathname } = new URL(req.url);

  if (req.method === "POST" && pathname === "/proxy") {
    // 校验密码
    const got = req.headers.get("x-proxy-secret") || "";
    const want = Deno.env.get("PROXY_SECRET") || "";
    if (!want || got !== want) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    // 解析转发参数
    let p: { url?: string; method?: string; headers?: Record<string, string>; body?: string | null };
    try {
      p = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "bad json" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const { url, method = "GET", headers = {}, body = null } = p || {};
    if (!url) {
      return new Response(JSON.stringify({ error: "missing url" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // 转发给目标交易所，并原样返回状态码与响应体
    const upstream = await fetch(url, { method, headers, body: body ?? undefined });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
    });
  }

  // 健康检查
  return new Response("ok");
});
