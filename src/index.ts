// Architecture: Cloudflare edge-worker module src/index.ts; the V2 Vercel
// project is the sole active ingress target. No AWS or legacy origin exists in
// the V2 routing contract.
export interface Env {
  VERCEL_APP_ORIGIN: string;
}

function getClientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

function buildUpstreamUrl(origin: string, requestUrl: URL): string {
  const upstream = new URL(origin);
  upstream.pathname = requestUrl.pathname;
  upstream.search = requestUrl.search;
  return upstream.toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return fetch(request);
    }

    const origin = env.VERCEL_APP_ORIGIN;
    if (!origin || !/^https:\/\/dinodia-platform-v2(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin)) {
      return new Response("V2 edge origin is not configured", { status: 503 });
    }
    const upstreamUrl = buildUpstreamUrl(origin, url);

    const headers = new Headers(request.headers);
    // Ensure upstream app logic sees the original public host/proto (important for auth redirects).
    const originalHost = url.host;
    headers.set("host", originalHost);
    headers.set("x-forwarded-host", originalHost);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    const clientIp = getClientIp(request);
    if (clientIp) headers.set("x-forwarded-for", clientIp);

    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    const upstreamResponse = await fetch(upstreamRequest);
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("x-dinodia-api-backend", "vercel-v2");
    responseHeaders.set("x-dinodia-worker", "native-v2");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
