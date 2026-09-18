export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/audits") {
      const body = await request.json();
      const auditId = body.audit_id;
      const city = body.city;
      const plate = body.plate || "";
      const answers = body.answers || {};
      const createdAt = new Date().toISOString();

      if (!auditId || !city) {
        return Response.json({ ok: false, error: "Falta audit_id o city" }, { status: 400 });
      }

      await env.DB.prepare("DELETE FROM audit_answers WHERE audit_id = ?").bind(auditId).run();

      const statements = Object.entries(answers).map(([campo, valor]) =>
        env.DB.prepare(
          "INSERT INTO audit_answers (id, audit_id, city, plate, campo, valor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), auditId, city, plate, campo, String(valor), createdAt)
      );

      if (statements.length > 0) {
        await env.DB.batch(statements);
      }

      return Response.json({ ok: true, audit_id: auditId });
    }

    if (request.method === "GET" && url.pathname === "/api/audits") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM audit_answers ORDER BY created_at DESC"
      ).all();

      const grouped = {};
      for (const row of results) {
        if (!grouped[row.audit_id]) {
          grouped[row.audit_id] = {
            audit_id: row.audit_id,
            city: row.city,
            plate: row.plate,
            created_at: row.created_at,
            answers: {},
          };
        }
        grouped[row.audit_id].answers[row.campo] = row.valor;
      }

      return Response.json(Object.values(grouped));
    }

    return new Response("Not found", { status: 404 });
  }
};
