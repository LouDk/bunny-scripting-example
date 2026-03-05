import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";
import * as BunnyStorageSDK from "https://esm.sh/@bunny.net/storage-sdk";
import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

/* =========================
   Config / Clients
========================= */

let db: ReturnType<typeof createClient> | null = null;
try {
  if (!process.env.DB_URL || !process.env.DB_TOKEN) {
    throw new Error("Missing DB_URL or DB_TOKEN env vars");
  }
  db = createClient({
    url: process.env.DB_URL!,
    authToken: process.env.DB_TOKEN!,
  });
} catch (err) {
  console.error("[EdgeScript] Failed to init libSQL client:", err);
}

let sz: any = null;
try {
  if (!process.env.STORAGE_ZONE || !process.env.STORAGE_ACCESS_KEY) {
    throw new Error("Missing STORAGE_ZONE or STORAGE_ACCESS_KEY env vars");
  }
  sz = BunnyStorageSDK.zone.connect_with_accesskey(
    BunnyStorageSDK.regions.StorageRegion.Falkenstein,
    process.env.STORAGE_ZONE!,
    process.env.STORAGE_ACCESS_KEY!,
  );
} catch (err) {
  console.error("[EdgeScript] Failed to init Bunny Storage client:", err);
}

const STORAGE_URL = process.env.STORAGE_URL || "";

/* =========================
   Helpers
========================= */
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function bad(msg: string, status = 400) {
  return json({ error: msg }, status);
}
function notFound() {
  return bad("Not found", 404);
}

/** Formats like "2025-09" -> "September 2025" */
function formatYearMonth(ym: string, locale = "en-US"): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const [_, y, mm] = m;
  const d = new Date(Date.UTC(Number(y), Number(mm) - 1, 1));
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

/** Formats ISO date -> "September 1, 2025" (keeps day correct via UTC) */
function formatISODate(iso: string, locale = "en-US"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function thisMonthRangeUTC() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    ym: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

function makeSimplePdf(title: string, subtitle: string, lines: string[]): Uint8Array {
  const W = 612, H = 792; // Letter
  const esc = (s: string) => s.replace(/([()\\])/g, "\\$1").replace(/\r?\n/g, " ");

  // Build the content stream with proper leading (TL) and T* for new lines
  const contentLines = [
    "BT",
    "72 750 Td",                // start position (x=72,y=750)
    "/F1 18 Tf",               // title font
    "22 TL",                   // title line height
    `(${esc(title)}) Tj`,
    "T*",
    "/F1 12 Tf",               // subtitle font
    "16 TL",
    `(${esc(subtitle)}) Tj`,
    "T*",                      // blank line
    "T*",
    "/F1 11 Tf",               // body font
    "14 TL",
    ...lines.map(l => `(${pdfEscape(l)}) Tj T*`),
    "ET",
  ];
  const stream = contentLines.join("\n");
  const content = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  const objects: string[] = [];
  const offsets: number[] = [];

  // 1: Catalog
  objects.push(`1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`);
  // 2: Pages
  objects.push(`2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj`);
  // 3: Page
  objects.push(
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj`
  );
  // 4: Content
  objects.push(`4 0 obj ${content} endobj`);
  // 5: Font (Helvetica)
  objects.push(`5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`);

  let pdf = "%PDF-1.4\n";
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + "\n";
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

function pdfEscape(s: string) {
  return s
    // Normalize to NFKD (separates accents from base letters)
    .normalize("NFKD")
    // Replace common Unicode punctuation with ASCII equivalents
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[–—−]/g, "-")   // en dash, em dash, minus → dash
    .replace(/[•·]/g, "*")
    // Remove/replace anything outside ASCII printable
    .replace(/[^\x20-\x7E]/g, "")
    // Escape special PDF characters
    .replace(/([()\\])/g, "\\$1")
    // Collapse newlines
    .replace(/\r?\n/g, " ");
}

/** ---------- OpenAPI (Swagger) spec ---------- */
function openApiSpec(origin = "https://demo-test-dash.b-cdn.net") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Bunny Standalone API",
      version: "1.0.0",
      description:
        "Simple JSON API backed by Turso (libSQL) with Bunny Storage for monthly NPS PDF reports.",
    },
    servers: [
      { url: origin, description: "Production" },
      { url: "/", description: "Relative (same origin)" },
    ],
    tags: [{ name: "Pages" }, { name: "NPS" }, { name: "Reports" }],
    paths: {
      "/api/pages": {
        get: {
          tags: ["Pages"],
          summary: "List pages",
          operationId: "listPages",
          responses: {
            "200": {
              description: "Array of pages",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Page" } },
                },
              },
            },
          },
        },
        post: {
          tags: ["Pages"],
          summary: "Create a page",
          operationId: "createPage",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PageCreate" } },
            },
          },
          responses: {
            "200": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
          },
        },
      },
      "/api/pages/{id}": {
        put: {
          tags: ["Pages"],
          summary: "Update a page",
          operationId: "updatePage",
          parameters: [{ in: "path", name: "id", schema: { type: "integer" }, required: true }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PageUpdate" } },
            },
          },
          responses: {
            "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
          },
        },
        delete: {
          tags: ["Pages"],
          summary: "Delete a page",
          operationId: "deletePage",
          parameters: [{ in: "path", name: "id", schema: { type: "integer" }, required: true }],
          responses: {
            "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
          },
        },
      },
      "/api/nps": {
        get: {
          tags: ["NPS"],
          summary: "List NPS scores",
          operationId: "listNps",
          responses: {
            "200": {
              description: "Array of NPS entries (most recent first)",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Nps" } },
                },
              },
            },
          },
        },
        post: {
          tags: ["NPS"],
          summary: "Add an NPS score",
          operationId: "addNps",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/NpsCreate" } } },
          },
          responses: {
            "200": { description: "Inserted", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
          },
        },
      },
      "/api/reports": {
        get: {
          tags: ["Reports"],
          summary: "List generated reports",
          operationId: "listReports",
          responses: {
            "200": {
              description: "Array of reports",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Report" } },
                },
              },
            },
          },
        },
      },
      "/api/reports/generate": {
        post: {
          tags: ["Reports"],
          summary: "Generate monthly NPS report (current month)",
          operationId: "generateReport",
          description:
            "Aggregates this month’s NPS by page, creates a 1-page PDF, uploads to Bunny Storage, stores a row in `reports`, and returns the public `pdf_url`.",
          responses: {
            "200": {
              description: "Generated",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GenerateReportResponse" } } },
            },
            "500": { description: "Failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
    },
    components: {
      responses: {
        BadRequest: {
          description: "Bad request",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      schemas: {
        Ok: { type: "object", properties: { ok: { type: "boolean", example: true } }, required: ["ok"] },
        Error: { type: "object", properties: { error: { type: "string", example: "Missing name or url" } }, required: ["error"] },
        Page: {
          type: "object",
          properties: {
            id: { type: "integer", example: 3 },
            name: { type: "string", example: "Storage Docs" },
            url: { type: "string", example: "/storage" },
          },
          required: ["id", "name", "url"],
        },
        PageCreate: {
          type: "object",
          properties: { name: { type: "string" }, url: { type: "string" } },
          required: ["name", "url"],
        },
        PageUpdate: {
          type: "object",
          properties: { name: { type: "string" }, url: { type: "string" } },
          required: ["name", "url"],
        },
        Nps: {
          type: "object",
          properties: {
            id: { type: "integer", example: 12 },
            user: { type: "string", example: "user@example.com" },
            page: { type: "string", example: "/storage" },
            score: { type: "string", example: "9", description: "Stored as text" },
            date: { type: "string", format: "date-time", example: "2025-09-04T12:00:00.000Z" },
          },
          required: ["id", "user", "page", "score", "date"],
        },
        NpsCreate: {
          type: "object",
          properties: {
            user: { type: "string", example: "user@example.com" },
            page: { type: "string", example: "/storage" },
            score: { type: "string", example: "8" },
          },
          required: ["user", "page", "score"],
        },
        Report: {
          type: "object",
          properties: {
            id: { type: "integer", example: 5 },
            start_date: { type: "string", format: "date-time", example: "2025-09-01T00:00:00.000Z" },
            end_date: { type: "string", format: "date-time", example: "2025-09-30T23:59:59.999Z" },
            pdf_url: { type: "string", format: "uri", example: "https://your-pull-zone.b-cdn.net/reports/2025-09/nps-report-1693839999999.pdf" },
          },
          required: ["id", "start_date", "end_date", "pdf_url"],
        },
        GenerateReportResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: true },
            pdf_url: { type: "string", format: "uri" },
            period: {
              type: "object",
              properties: { start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" } },
              required: ["start", "end"],
            },
          },
          required: ["ok", "pdf_url", "period"],
        },
      },
    },
  };
}

/** ---------- Minimal Swagger UI HTML (loads spec from /api/openapi.json) ---------- */
function swaggerHtml(specUrl: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: ${JSON.stringify(specUrl)},
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>`;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (!db) return bad("Database client not initialized", 500);

    /* -------- Pages -------- */
    if (path === "/api/pages" && method === "GET") {
      const rs = await db.execute("SELECT * FROM pages ORDER BY id DESC");
      return json(rs.rows);
    }
    if (path === "/api/pages" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { name, url: pageUrl } = body;
      if (!name || !pageUrl) return bad("Missing name or url");
      await db.execute({ sql: "INSERT INTO pages (name, url) VALUES (?, ?)", args: [name, pageUrl] });
      return json({ ok: true });
    }
    if (path.startsWith("/api/pages/") && method === "PUT") {
      const id = Number(path.split("/").pop());
      if (!id) return bad("Missing id");
      const body = await req.json().catch(() => ({}));
      const { name, url: pageUrl } = body;
      if (!name || !pageUrl) return bad("Missing name or url");
      await db.execute({ sql: "UPDATE pages SET name = ?, url = ? WHERE id = ?", args: [name, pageUrl, id] });
      return json({ ok: true });
    }
    if (path.startsWith("/api/pages/") && method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!id) return bad("Missing id");
      await db.execute({ sql: "DELETE FROM pages WHERE id = ?", args: [id] });
      return json({ ok: true });
    }

    /* -------- NPS -------- */
    if (path === "/api/nps" && method === "GET") {
      const rs = await db.execute("SELECT * FROM nps ORDER BY id DESC");
      return json(rs.rows);
    }
    if (path === "/api/nps" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { user, page, score } = body;
      if (!user || !page || score == null) return bad("Missing user, page or score");
      const date = new Date().toISOString();
      await db.execute({
        sql: "INSERT INTO nps (user, page, score, date) VALUES (?, ?, ?, ?)",
        args: [user, page, String(score), date],
      });
      return json({ ok: true });
    }

    /* -------- Reports -------- */
    if (path === "/api/reports" && method === "GET") {
      const rs = await db.execute("SELECT * FROM reports ORDER BY id DESC");
      return json(rs.rows);
    }

    if (path === "/api/reports/generate" && method === "POST") {
      if (!sz) return bad("Storage client not initialized", 500);

      const { startISO, endISO, ym } = thisMonthRangeUTC();
      const rs = await db.execute({
        sql: `
          SELECT
            n.page AS page,
            COALESCE(p.name, '') AS name,
            COUNT(*) AS count,
            AVG(CAST(n.score AS REAL)) AS avg
          FROM nps n
          LEFT JOIN pages p ON p.url = n.page
          WHERE n.date >= ? AND n.date <= ?
          GROUP BY n.page
          ORDER BY count DESC
        `,
        args: [startISO, endISO],
      });

      const title = `Monthly NPS Report (${formatYearMonth(ym)})`;
      const subtitle = `From ${formatISODate(startISO)} to ${formatISODate(endISO)}`;
      const lines: string[] = rs.rows.length
        ? rs.rows.map((r: any) => {
            const page = r.page ?? "";
            const name = r.name ?? "";
            const count = Number(r.count ?? 0);
            const avg = r.avg != null ? Number(r.avg).toFixed(2) : "n/a";
            const label = name ? `${page} (${name})` : page;
            return `${label} — responses: ${count}, average: ${avg}`;
          })
        : ["No NPS data for this month."];

      const pdfBytes = makeSimplePdf(title, subtitle, lines);

      const ts = Date.now();
      const storagePath = `/reports/${ym}/nps-report-${ts}.pdf`;
      await BunnyStorageSDK.file.upload(sz, storagePath, pdfBytes);

      const pdfUrl = `${STORAGE_URL.replace(/\/$/, "")}${storagePath}`;
      await db.execute({
        sql: "INSERT INTO reports (start_date, end_date, pdf_url) VALUES (?, ?, ?)",
        args: [startISO, endISO, pdfUrl],
      });

      return json({ ok: true, pdf_url: pdfUrl, period: { start: startISO, end: endISO } });
    }

    // Serve OpenAPI JSON
    if (path === "/api/openapi.json" && method === "GET") {
        const spec = openApiSpec(url.origin);
        return new Response(JSON.stringify(spec, null, 2), {
            headers: { "content-type": "application/json; charset=utf-8" },
        });
    }

    // Serve Swagger UI
    if (path === "/docs" && method === "GET") {
        const html = swaggerHtml(`${url.origin}/api/openapi.json`);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return notFound();
  } catch (err: any) {
    return json({ error: err?.message || String(err) }, 500);
  }
}

BunnySDK.net.http.serve(handler);
