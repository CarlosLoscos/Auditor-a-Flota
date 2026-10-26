const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Access-Code, X-Admin-Code",
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


// ---- Lectura de matrícula con IA de visión (Workers AI) ----
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const PLATE_PROMPT =
  "This photo shows a scooter or motorcycle, or a close-up of its license plate. " +
  "Read the license plate. Reply ONLY with the plate characters (letters and digits, no spaces, no explanation). " +
  "If you can see two or three possible readings, write each on its own line (max 3 lines). " +
  "If there is no readable plate, reply exactly: NONE";

async function readPlateWithAI(env, bytes) {
  const dataUrl = "data:image/jpeg;base64," + bytesToBase64(bytes);
  const attempts = [
    { model: "@cf/meta/llama-4-scout-17b-16e-instruct", input: () => ({
        messages: [{ role: "user", content: [
          { type: "text", text: PLATE_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } } ] }],
        max_tokens: 60, temperature: 0 }) },
    { model: "@cf/meta/llama-3.2-11b-vision-instruct", input: () => ({
        messages: [{ role: "user", content: [
          { type: "text", text: PLATE_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } } ] }],
        max_tokens: 60, temperature: 0 }) },
    { model: "@cf/meta/llama-3.2-11b-vision-instruct", input: () => ({
        prompt: PLATE_PROMPT, image: Array.from(bytes), max_tokens: 60, temperature: 0 }) },
  ];
  const errors = [];
  for (const a of attempts) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const out = await env.AI.run(a.model, a.input());
        let text = out && (out.response !== undefined ? out.response : (out.result && out.result.response));
        if (text && typeof text === "object") text = JSON.stringify(text);
        if (typeof text === "string" && text.trim()) return { model: a.model, text: text.trim() };
        errors.push(a.model + ": respuesta vacía");
        break;
      } catch (e) {
        const msg = String((e && e.message) || e);
        // Los modelos de Meta piden aceptar la licencia una sola vez
        if (retry === 0 && /agree|licen[sc]e|5016/i.test(msg)) {
          try { await env.AI.run(a.model, { prompt: "agree" }); continue; } catch (e2) { /* sigue */ }
        }
        errors.push(a.model + ": " + msg.slice(0, 160));
        break;
      }
    }
  }
  throw new Error(errors.join(" | "));
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

    if (request.method === "POST" && url.pathname === "/api/plate-ocr") {
      if (!env.AI) {
        return Response.json({ ok: false, error: "IA no configurada en el servidor (falta el binding AI)" }, { status: 501, headers: CORS_HEADERS });
      }
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.length < 1000 || buf.length > 4 * 1024 * 1024) {
        return Response.json({ ok: false, error: "Imagen no válida o demasiado grande" }, { status: 400, headers: CORS_HEADERS });
      }
      try {
        const r = await readPlateWithAI(env, buf);
        return Response.json({ ok: true, text: r.text, model: r.model }, { headers: CORS_HEADERS });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e).slice(0, 400) }, { status: 502, headers: CORS_HEADERS });
      }
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

    if (request.method === "GET" && url.pathname === "/api/census") {
      // Lista de matrículas agrupada por ciudad (la agrupación la hace la propia base de datos)
      const { results } = await env.DB.prepare(
        "SELECT city, group_concat(plate, '|') AS plates FROM fleet_census GROUP BY city"
      ).all();
      const groups = {};
      for (const r of results) groups[r.city] = r.plates;
      return Response.json({ ok: true, groups }, { headers: { ...CORS_HEADERS, "Cache-Control": "private, max-age=3600" } });
    }

    if (request.method === "GET" && url.pathname === "/api/plate-suggest") {
      const rawPrefix = url.searchParams.get("prefix") || "";
      const prefix = rawPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (prefix.length < 4) {
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
      const adminCode = request.headers.get("X-Admin-Code");
      if (!env.ADMIN_CODE || adminCode !== env.ADMIN_CODE) {
        return Response.json({ ok: false, error: "Contraseña de administrador incorrecta" }, { status: 403, headers: CORS_HEADERS });
      }
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
