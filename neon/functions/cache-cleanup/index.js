import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 8_000,
  idleTimeoutMillis: 5_000,
  application_name: "crikora-neon-cache-cleanup"
});

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }

    if (!request.headers.has("x-neon-trigger-invocation-id")) {
      return Response.json({ error: "Scheduled invocation required." }, { status: 403 });
    }

    try {
      const result = await pool.query(
        "DELETE FROM public.crikora_cache WHERE expires_at <= now()"
      );
      return Response.json({
        ok: true,
        deletedRows: result.rowCount ?? 0,
        retentionSeconds: 600,
        executedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("Crikora cache cleanup failed", error);
      return Response.json({ error: "Cache cleanup failed." }, { status: 500 });
    }
  }
};
