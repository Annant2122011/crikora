export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }

    if (!request.headers.has("x-neon-trigger-invocation-id")) {
      return Response.json({ error: "Scheduled invocation required." }, { status: 403 });
    }

    const apiBaseUrl = process.env.CRIKORA_API_BASE_URL;
    const refreshSecret = process.env.CRIKORA_REFRESH_SECRET;
    if (!apiBaseUrl || !refreshSecret) {
      return Response.json({ error: "Cleanup function environment is incomplete." }, { status: 503 });
    }

    try {
      const endpoint = `${apiBaseUrl.replace(/\\/+$/, "")}/cleanup`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${refreshSecret}`,
          accept: "application/json"
        },
        cache: "no-store",
        signal: AbortSignal.timeout(25_000)
      });
      const body = await response.json().catch(() => ({}));
      return Response.json({
        ...body,
        ok: response.ok && body.ok === true,
        scheduler: "neon-function-trigger",
        retentionSeconds: 600
      }, { status: response.status });
    } catch (error) {
      console.error("Crikora scheduled cache cleanup failed", error);
      return Response.json({ error: "Crikora API cleanup request failed." }, { status: 502 });
    }
  }
};
