const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
};

function isAuthorized(request, env, url) {
  const headerCode = request.headers.get("X-Access-Code");
  const queryCode = url.searchParams.get("code");
  const provided = headerCode || queryCode;
  return provided && provided === env.ACCESS_CODE;
}

function encodeValor(valor) {
  return Array.isArray(valor) ? JSON.stringify(valor) : String(valor);
}
function decodeValor(valor) {
  if (typeof valor === "string" && valor.startsWith("[")) {
    try { return JSON.parse(valor); } catch (e) { return valor; }
  }
  return valor;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/api/") && !isAuthorized(request, env, url)) {
      return Response.json({ ok: false, error: "No autorizado" }, { status: 401, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/plate-lookup") {
      const rawPlate = url.searchParams.get("plate") || "";
      const normalized = rawPlate.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!normalized) {
        return Response.json({ ok: false, error: "Falta la matrícula" }, { status: 400, headers: CORS_HEADERS });
      }
      const row = await env.DB.prepare("SELECT city FROM fleet_census WHERE plate = ?").bind(normalized).first();
      if (!row) {
        return Response.json({ ok: false, error: "Matrícula no encontrada en el censo" }, { status: 404, headers: CORS_HEADERS });
      }
      return Response.json({ ok: true, city: row.city }, { headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/api/plate-suggest") {
      const rawPrefix = url.searchParams.get("prefix") || "";
      const prefix = rawPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (prefix.length < 5) {
        return Response.json({ ok: true, plates: [] }, { headers: CORS_HEADERS });
      }
      const likePattern = prefix.replace(/[%_]/g, "\\$&") + "%";
      const { results } = await env.DB.prepare(
        "SELECT plate FROM fleet_census WHERE plate LIKE ? ESCAPE '\\' ORDER BY plate LIMIT 20"
      ).bind(likePattern).all();
      return Response.json({ ok: true, plates: results.map(r => r.plate) }, { headers: CORS_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/api/audits") {
      const body = await request.json();
      const auditId = body.audit_id;
      const city = body.city;
      const plate = body.plate || "";
      const answers = body.answers || {};
      const photoKeys = body.photo_keys || {};
      const createdAt = new Date().toISOString();

      if (!auditId || !city) {
        return Response.json({ ok: false, error: "Falta audit_id o city" }, { status: 400, headers: CORS_HEADERS });
      }

      await env.DB.prepare("DELETE FROM audit_answers WHERE audit_id = ?").bind(auditId).run();

      const statements = Object.entries(answers).map(([campo, valor]) =>
        env.DB.prepare(
          "INSERT INTO audit_answers (id, audit_id, city, plate, campo, valor, photo_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), auditId, city, plate, campo, encodeValor(valor), photoKeys[campo] || null, createdAt)
      );

      if (statements.length > 0) {
        await env.DB.batch(statements);
      }

      return Response.json({ ok: true, audit_id: auditId }, { headers: CORS_HEADERS });
    }

    if (request.method === "DELETE" && url.pathname === "/api/audits") {
      const auditId = url.searchParams.get("audit_id");
      if (!auditId) {
        return Response.json({ ok: false, error: "Falta audit_id" }, { status: 400, headers: CORS_HEADERS });
      }
      await env.DB.prepare("DELETE FROM audit_answers WHERE audit_id = ?").bind(auditId).run();
      return Response.json({ ok: true }, { headers: CORS_HEADERS });
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
            photos: {},
          };
        }
        grouped[row.audit_id].answers[row.campo] = decodeValor(row.valor);
        if (row.photo_key) {
          grouped[row.audit_id].photos[row.campo] = row.photo_key;
        }
      }

      return Response.json(Object.values(grouped), { headers: CORS_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/api/photos") {
      const auditId = url.searchParams.get("audit_id");
      const campo = url.searchParams.get("campo");
      if (!auditId || !campo) {
        return Response.json({ ok: false, error: "Falta audit_id o campo" }, { status: 400, headers: CORS_HEADERS });
      }
      const key = `${auditId}/${campo}.jpg`;
      const contentType = request.headers.get("Content-Type") || "image/jpeg";
      const bodyData = await request.arrayBuffer();
      await env.PHOTOS.put(key, bodyData, { httpMetadata: { contentType } });
      return Response.json({ ok: true, key }, { headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/photos/")) {
      const key = decodeURIComponent(url.pathname.replace("/api/photos/", ""));
      const obj = await env.PHOTOS.get(key);
      if (!obj) {
        return new Response("Not found", { status: 404, headers: CORS_HEADERS });
      }
      return new Response(obj.body, {
        headers: { ...CORS_HEADERS, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg" },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  }
};
