/**
 * CouncilHub Backend — Cloudflare Workers + D1 (3 Separate Databases)
 * Handles syncing for Councils, Initiatives, and Resources.
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

      // ─── TEST ENDPOINT ──────────────────────────────────────────
      if (path === "/api/test") {
        return json({ status: "Worker is alive", timestamp: Date.now() });
      }

      // ─── 1. AUTH: MEMBER LOGIN ──────────────────────────────────────────
      if (path === "/api/login/member" && method === "POST") {
        const { username, password, id, councilId } = await readBody();
        const targetId = id || councilId;

        // Query councils_db for credentials
        const credResult = await env.councils_db.prepare(
          "SELECT id FROM credentials WHERE councilId = ? AND username = ? AND password = ?"
        ).bind(targetId, username, password).first();

        if (!credResult) {
          return json({ success: false, error: "Invalid credentials" }, 401);
        }

        // Get council info
        const council = await env.councils_db.prepare(
          "SELECT id, name FROM councils WHERE id = ?"
        ).bind(targetId).first();

        if (!council) {
          return json({ success: false, error: "Council not found" }, 404);
        }

        return json({
          success: true,
          session: {
            type: 'member',
            username,
            name: username,
            role: 'member',
            councilId: targetId
          }
        });
      }

      // ─── 2. AUTH: MANAGER LOGIN ────────────────────────────────────────
      if (path === "/api/login/manager" && method === "POST") {
        const { username, password } = await readBody();

        if (username === "admin" && password === "manager-access-2026") {
          return json({ success: true, token: "mng_" + Date.now() });
        }
        return json({ success: false, error: "Invalid Credentials" }, 401);
      }

      // ─── 3. GET ALL COUNCILS ────────────────────────────────────────────
      if (path === "/api/councils/all" && method === "GET") {
        try {
          const { results } = await env.councils_db.prepare(
            "SELECT id, name, color, googleEmail, mission, achievement, homepage FROM councils"
          ).all();

          const allData = {};

          if (results && results.length > 0) {
            for (const row of results) {
              // Get padlets from resources_db
              const padletResults = await env.resources_db.prepare(
                "SELECT padletType, url FROM padlets WHERE councilId = ?"
              ).all().bind(row.id);

              const padlets = {};
              if (padletResults?.results) {
                padletResults.results.forEach(p => {
                  padlets[p.padletType] = p.url;
                });
              }

              allData[row.id] = {
                ...row,
                padlets
              };
            }
          }

          return json(allData);
        } catch (err) {
          return json({ error: "QUERY_FAILED", details: err.message }, 500);
        }
      }

      // ─── 4. GET COUNCIL DATA ────────────────────────────────────────────
      if (path === "/api/council/data" && method === "GET") {
        const id = url.searchParams.get("id");

        try {
          const council = await env.councils_db.prepare(
            "SELECT id, name, color, googleEmail, mission, achievement, homepage FROM councils WHERE id = ?"
          ).bind(id).first();

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

          // Get initiatives from initiatives_db
          const initiativesResult = await env.initiatives_db.prepare(
            "SELECT * FROM initiatives WHERE councilId = ? AND status IN ('approved', 'pending', 'rejected')"
          ).bind(id).all();

          const initiatives = initiativesResult?.results || [];
          const pendingList = initiatives.filter(i => i.status === 'pending');
          const approvedList = initiatives.filter(i => i.status === 'approved');
          const rejectedList = initiatives.filter(i => i.status === 'rejected');

          // Get padlets from resources_db
          const padletsResult = await env.resources_db.prepare(
            "SELECT padletType, url FROM padlets WHERE councilId = ?"
          ).bind(id).all();

          const padlets = {};
          if (padletsResult?.results) {
            padletsResult.results.forEach(p => {
              padlets[p.padletType] = p.url;
            });
          }

          // Get project from resources_db
          const projectResult = await env.resources_db.prepare(
            "SELECT title, progress, status FROM projects WHERE councilId = ? LIMIT 1"
          ).bind(id).first();

          const mainProject = projectResult || { title: "", progress: 0, status: "Not Started" };

          return json({
            ...council,
            initiatives,
            pendingList,
            approvedList,
            rejectedList,
            mainProject,
            padlets
          });
        } catch (err) {
          return json({ error: "FETCH_FAILED", details: err.message }, 500);
        }
      }

      // ─── 5. SAVE COUNCIL INFO ───────────────────────────────────────────
      if (path === "/api/council/save" && method === "POST") {
        try {
          const body = await request.json();
          const { id, name, mission, achievement, homepage, color, googleEmail } = body;

          await env.councils_db.prepare(
            "INSERT INTO councils (id, name, color, googleEmail, mission, achievement, homepage) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, mission = excluded.mission, achievement = excluded.achievement, homepage = excluded.homepage, color = excluded.color, googleEmail = excluded.googleEmail"
          ).bind(id, name, color, googleEmail, mission, achievement, homepage).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "SERVER_ERROR", msg: err.message }, 500);
        }
      }

      // ─── 6. SAVE CREDENTIALS ────────────────────────────────────────────
      if (path === "/api/credentials/save" && method === "POST") {
        try {
          const { councilId, credentials } = await request.json();

          // Clear existing credentials for this council
          await env.councils_db.prepare(
            "DELETE FROM credentials WHERE councilId = ?"
          ).bind(councilId).run();

          // Insert new credentials
          const statements = Object.entries(credentials).map(([key, cred]) => {
            return env.councils_db.prepare(
              "INSERT INTO credentials (councilId, username, password, name, role) VALUES (?, ?, ?, ?, ?)"
            ).bind(councilId, cred.username, cred.password, cred.name, cred.role);
          });

          if (statements.length > 0) {
            await env.councils_db.batch(statements);
          }

          return json({ success: true });
        } catch (err) {
          return json({ error: "DATABASE_ERROR", message: err.message }, 500);
        }
      }

      // ─── 7. SAVE PADLETS ────────────────────────────────────────────────
      if (path.includes("/padlets") && method === "POST") {
        try {
          const pathParts = path.split('/');
          const councilId = pathParts[3];
          const { padlets } = await readBody();

          // Upsert padlets into resources_db
          const statements = Object.entries(padlets).map(([padletType, url]) => {
            return env.resources_db.prepare(
              "INSERT INTO padlets (councilId, padletType, url) VALUES (?, ?, ?) " +
              "ON CONFLICT(councilId, padletType) DO UPDATE SET url = excluded.url"
            ).bind(councilId, padletType, url);
          });

          if (statements.length > 0) {
            await env.resources_db.batch(statements);
          }

          return json({ success: true, padlets });
        } catch (err) {
          return json({ error: "PADLET_SAVE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 8. MEMBERS: BULK SYNC ──────────────────────────────────────────
      if (path === "/api/members/sync" && method === "POST") {
        try {
          const { councilId, members } = await readBody();

          // Clear existing members for this council
          await env.councils_db.prepare(
            "DELETE FROM members WHERE councilId = ?"
          ).bind(councilId).run();

          // Insert new members
          const statements = Object.entries(members).map(([key, m]) => {
            return env.councils_db.prepare(
              "INSERT INTO members (councilId, memberKey, name, role, username, password) VALUES (?, ?, ?, ?, ?, ?)"
            ).bind(councilId, key, m.name, m.role, m.username, m.password);
          });

          if (statements.length > 0) {
            await env.councils_db.batch(statements);
          }

          return json({ success: true });
        } catch (err) {
          return json({ error: "MEMBERS_SYNC_FAILED", details: err.message }, 500);
        }
      }

      // ─── 9. SYSTEM WIPE ─────────────────────────────────────────────────
      if (path === "/api/system/wipe" && method === "POST") {
        try {
          await env.councils_db.prepare("DELETE FROM councils").run();
          await env.councils_db.prepare("DELETE FROM members").run();
          await env.councils_db.prepare("DELETE FROM credentials").run();
          await env.initiatives_db.prepare("DELETE FROM initiatives").run();
          await env.initiatives_db.prepare("DELETE FROM progress_reports").run();
          await env.initiatives_db.prepare("DELETE FROM manager_comments").run();
          await env.resources_db.prepare("DELETE FROM padlets").run();
          await env.resources_db.prepare("DELETE FROM projects").run();
          await env.resources_db.prepare("DELETE FROM documents").run();

          return json({ success: true, message: "System wiped successfully" });
        } catch (err) {
          return json({ error: "WIPE_FAILED", message: err.message }, 500);
        }
      }

      return json({ error: "NOT_FOUND" }, 404);
    } catch (err) {
      return new Response(JSON.stringify({ error: "SERVER_ERROR", msg: err.message }), { status: 500, headers: corsHeaders() });
    }
  }
};
