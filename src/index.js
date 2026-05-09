/**
 * CouncilHub Backend — Cloudflare Workers + D1
 * Handles syncing for Councils, Initiatives, and Members.
 */

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type",
});

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders() });
      const readBody = async () => { try { return await request.json(); } catch { return {}; } };

      // ─── 1. AUTH: MEMBER LOGIN ──────────────────────────────────────────
      if (path === "/api/login/member" && method === "POST") {
          // 1. Destructure 'id' (from your frontend fetch) or 'councilId'
          const { username, password, id, councilId } = await readBody();
          const targetId = id || councilId; // Handle both naming conventions

          // 2. Query the 'councils' table instead of 'members'
          const councilRow = await env.cip_db.prepare(
            "SELECT data FROM councils WHERE id = ?"
          ).bind(targetId).first();

          if (!councilRow) {
            return json({ success: false, error: "Council not found" }, 404);
          }

          // 3. Parse the JSON 'data' string
          const councilData = JSON.parse(councilRow.data || "{}");
          const creds = councilData.credentials || {};

          // 4. Search for the user in the credentials object
          let foundUser = null;

          // Check the Admin/Lead slot (e.g., Dhruv)
          if (creds.username?.username === username && creds.username?.password === password) {
            foundUser = creds.username;
          } 

          // If not found, check the member slots (member_1, member_177...)
          if (!foundUser) {
            foundUser = Object.values(creds).find(u => 
              u.username === username && u.password === password
            );
          }

          if (foundUser) {
            return json({ 
              success: true, 
              session: { 
                type: 'member', 
                username, 
                name: foundUser.name, 
                role: foundUser.role, 
                councilId: targetId 
              } 
            });
          }

          return json({ success: false, error: "Invalid credentials" }, 401);
        }
      // index.js

      // 1. ADD THIS AT THE VERY TOP OF handleRequest to test connectivity
      if (path === "/api/test") {
        return json({ status: "Worker is alive", timestamp: Date.now() });
      }

      // 2. UPDATED LOGIN BLOCK
      // index.js (Worker)
      if (path === "/api/login/manager" && method === "POST") {
        const { username, password } = await readBody();
        
        if (username === "admin" && password === "manager-access-2026") {
          return json({ success: true, token: "mng_" + Date.now() });
        }
        return json({ success: false, error: "Invalid Credentials" }, 401);
      }
      // index.js (Worker)
      if (path === "/api/councils/all" && method === "GET") {
        try {
          const { results } = await env.cip_db.prepare(
            "SELECT * FROM councils" 
          ).all();

          const allData = {};
          
          // Check if we actually have rows
          if (results && results.length > 0) {
            results.forEach(row => {
              try {
                // If your column is named 'data', use row.data
                allData[row.id] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
              } catch (e) {
                allData[row.id] = row.data; // Fallback if it's not JSON
              }
            });
          }

          return json(allData); // Returns {} if empty, which is valid JSON
        } catch (err) {
          return json({ error: "QUERY_FAILED", details: err.message }, 500);
        }
      }
      // ─── 2. COUNCIL INFO: GET & SAVE ─────────────────────────────────────
      if (path === "/api/council/data" && method === "GET") {
        const id = url.searchParams.get("id");
        const council = await env.cip_db.prepare("SELECT * FROM councils WHERE id = ?").bind(id).first();

        // If DB is empty, return a fresh template so the UI doesn't crash
        if (!council) {
          return json({
            id: id,
            info: { mission: "", achievement: "", homepage: "" },
            initiatives: [],
            pendingList: [],
            approvedList: [],
            rejectedList: [],
            mainProject: { title: "", progress: 0, status: "Not Started" },
            padlets: { internal: "", personal: "", showcase: "" }
          });
        }

        // Otherwise, return existing data
        return json({
          ...council,
          mainProject: JSON.parse(council.mainProject || '{}'),
          padlets: JSON.parse(council.padlets || '{}'),
          initiatives: JSON.parse(council.initiatives || '[]'),
          approvedList: JSON.parse(council.approvedList || '[]'),
          rejectedList: JSON.parse(council.rejectedList || '[]'),
          pendingList: JSON.parse(council.pendingList || '[]'),
        });
      }

      // index.js (Worker)
      if (path === "/api/council/save" && method === "POST") {
        try {
          const body = await request.json();
          const { id, ...restOfData } = body;

          // We stringify EVERYTHING except the ID into the 'data' column
          const dataString = JSON.stringify(restOfData);

          await env.cip_db.prepare(
            "INSERT INTO councils (id, data) VALUES (?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data"
          ).bind(id, dataString).run();

          return json({ success: true });
        } catch (err) {
          // This is likely where your error is being caught now
          return json({ error: "SERVER_ERROR", msg: err.message }, 500);
        }
      }
      // ─── SAVE CREDENTIALS ──────────────────────────────────────────────
      if (path === "/api/credentials/save" && method === "POST") {
        try {
          const { councilId, credentials } = await request.json();

          // We store credentials in a dedicated row or within the council data
          // Option A: Update the 'data' column in the councils table
          const result = await env.cip_db.prepare(
            "SELECT data FROM councils WHERE id = ?"
          ).bind(councilId).first();

          let data = result ? JSON.parse(result.data) : {};
          data.credentials = credentials; // Attach the new credentials

          await env.cip_db.prepare(
            "INSERT INTO councils (id, data) VALUES (?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data"
          ).bind(councilId, JSON.stringify(data)).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "DATABASE_ERROR", message: err.message }, 500);
        }
      }
      // ─── 4. PADLETS: SAVE PER COUNCIL ────────────────────────────────────
      if (path.includes("/padlets") && method === "POST") {
        try {
          // Extract councilId from path: /api/councils/innovation-tech/padlets
          const pathParts = path.split('/');
          const councilId = pathParts[3]; 
          const { padlets } = await readBody();

          // 1. Get existing data string
          const result = await env.cip_db.prepare(
            "SELECT data FROM councils WHERE id = ?"
          ).bind(councilId).first();

          let councilData = {};
          if (result && result.data) {
            councilData = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
          }

          // 2. Update ONLY the padlets field within the JSON
          councilData.padlets = {
            ...(councilData.padlets || {}),
            ...padlets
          };

          // 3. Save it back to the 'data' column
          await env.cip_db.prepare(
            "INSERT INTO councils (id, data) VALUES (?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data"
          ).bind(councilId, JSON.stringify(councilData)).run();

          return json({ success: true, padlets: councilData.padlets });
        } catch (err) {
          return json({ error: "PADLET_SAVE_FAILED", details: err.message }, 500);
        }
      }
            // index.js (Worker)
      if (path === "/api/system/wipe" && method === "POST") {
        try {
          // Deletes all rows from the councils table
          await env.cip_db.prepare("DELETE FROM councils").run();
          
          return json({ success: true, message: "System wiped successfully" });
        } catch (err) {
          return json({ error: "WIPE_FAILED", message: err.message }, 500);
        }
      }
      // ─── 3. MEMBERS: BULK SYNC ───────────────────────────────────────────
      if (path === "/api/members/sync" && method === "POST") {
        const { councilId, members } = await readBody();
        // Clear and rebuild for simplicity (matches your existing logic)
        await env.cip_db.prepare("DELETE FROM members WHERE councilId = ?").bind(councilId).run();
        
        const statements = Object.entries(members).map(([key, m]) => {
          return env.cip_db.prepare("INSERT INTO members (councilId, memberKey, name, role, username, password) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(councilId, key, m.name, m.role, m.username, m.password);
        });
        
        await env.cip_db.batch(statements);
        return json({ success: true });
      }

      return json({ error: "NOT_FOUND" }, 404);
    } catch (err) {
      return new Response(JSON.stringify({ error: "SERVER_ERROR", msg: err.message }), { status: 500, headers: corsHeaders() });
    }
  }
};