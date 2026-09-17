export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/audits") {
      const body = await request.json();
      const id = crypto.randomUUID();
      const created_at = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO audits (id, moto_id, campo, valor, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, body.moto_id, body.campo, body.valor, created_at).run();
      return Response.json({ ok: true, id });
    }

    if (request.method === "GET" && url.pathname === "/api/audits") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM audits ORDER BY created_at DESC"
      ).all();
      return Response.json(results);
    }

    return new Response("Not found", { status: 404 });
  }
};
