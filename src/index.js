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
              ).bind(row.id).all();

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

          // Return data with proper info wrapper
          return json({
            id: council.id,
            info: {
              mission: council.mission,
              achievement: council.achievement,
              homepage: council.homepage,
              name: council.name,
              color: council.color,
              googleEmail: council.googleEmail
            },
            initiatives,
            pendingList,
            approvedList,
            rejectedList,
            mainProject,
            padlets,
            successfulInitiatives: [],
            calendarEvents: []
          });
        } catch (err) {
          return json({ error: "FETCH_FAILED", details: err.message }, 500);
        }
      }

      // ─── 5. SAVE COUNCIL INFO ───────────────────────────────────────────
      if (path === "/api/council/save" && method === "POST") {
        try {
          const body = await request.json();
          const { id, name, mission, achievement, homepage, color, googleEmail, info } = body;

          // Extract values from either top-level or info wrapper
          const councilName = name || info?.name || '';
          const councilMission = mission || info?.mission || '';
          const councilAchievement = achievement || info?.achievement || '';
          const councilHomepage = homepage || info?.homepage || '';
          const councilColor = color || info?.color || '';
          const councilEmail = googleEmail || info?.googleEmail || '';

          await env.councils_db.prepare(
            "INSERT INTO councils (id, name, color, googleEmail, mission, achievement, homepage, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, mission = excluded.mission, achievement = excluded.achievement, homepage = excluded.homepage, color = excluded.color, googleEmail = excluded.googleEmail, updatedAt = CURRENT_TIMESTAMP"
          ).bind(id, councilName, councilColor, councilEmail, councilMission, councilAchievement, councilHomepage).run();

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
              "INSERT INTO credentials (councilId, username, password, name, role, createdAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
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
              "INSERT INTO padlets (councilId, padletType, url, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
              "ON CONFLICT(councilId, padletType) DO UPDATE SET url = excluded.url, updatedAt = CURRENT_TIMESTAMP"
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

      // ─── 8. SAVE INITIATIVE ─────────────────────────────────────────────
      if (path === "/api/initiatives/save" && method === "POST") {
        try {
          const { councilId, id, title, description, objectives, expectedOutcomes, initiativeType, executionDate, status } = await request.json();

          await env.initiatives_db.prepare(
            "INSERT INTO initiatives (id, councilId, title, description, objectives, expectedOutcomes, initiativeType, executionDate, status, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, objectives = excluded.objectives, expectedOutcomes = excluded.expectedOutcomes, initiativeType = excluded.initiativeType, executionDate = excluded.executionDate, status = excluded.status, updatedAt = CURRENT_TIMESTAMP"
          ).bind(id, councilId, title, description, objectives, expectedOutcomes, initiativeType, executionDate, status || 'pending').run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "INITIATIVE_SAVE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 9. APPROVE INITIATIVE ──────────────────────────────────────────
      if (path === "/api/initiatives/approve" && method === "POST") {
        try {
          const { councilId, initiativeId, reviewData } = await request.json();

          // Update initiative status
          await env.initiatives_db.prepare(
            "UPDATE initiatives SET status = 'approved', updatedAt = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(initiativeId).run();

          // Log status change
          await env.initiatives_db.prepare(
            "INSERT INTO initiative_status_history (initiativeId, oldStatus, newStatus, changedAt) VALUES (?, 'pending', 'approved', CURRENT_TIMESTAMP)"
          ).bind(initiativeId).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "APPROVE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 10. REJECT INITIATIVE ──────────────────────────────────────────
      if (path === "/api/initiatives/reject" && method === "POST") {
        try {
          const { councilId, initiativeId, reason } = await request.json();

          // Update initiative status
          await env.initiatives_db.prepare(
            "UPDATE initiatives SET status = 'rejected', updatedAt = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(initiativeId).run();

          // Log status change
          await env.initiatives_db.prepare(
            "INSERT INTO initiative_status_history (initiativeId, oldStatus, newStatus, reason, changedAt) VALUES (?, 'pending', 'rejected', ?, CURRENT_TIMESTAMP)"
          ).bind(initiativeId, reason || '').run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "REJECT_FAILED", details: err.message }, 500);
        }
      }

      // ─── 11. ADD COMMENT ────────────────────────────────────────────────
      if (path === "/api/initiatives/comment" && method === "POST") {
        try {
          const { councilId, initiativeId, comment } = await request.json();

          await env.initiatives_db.prepare(
            "INSERT INTO manager_comments (initiativeId, comment, createdAt) VALUES (?, ?, CURRENT_TIMESTAMP)"
          ).bind(initiativeId, comment).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "COMMENT_FAILED", details: err.message }, 500);
        }
      }

      // ─── 12. DELETE INITIATIVE ──────────────────────────────────────────
      if (path === "/api/initiatives/delete" && method === "POST") {
        try {
          const { councilId, initiativeId } = await request.json();

          // Delete related records first
          await env.initiatives_db.prepare("DELETE FROM manager_comments WHERE initiativeId = ?").bind(initiativeId).run();
          await env.initiatives_db.prepare("DELETE FROM progress_reports WHERE initiativeId = ?").bind(initiativeId).run();
          await env.initiatives_db.prepare("DELETE FROM initiative_leads WHERE initiativeId = ?").bind(initiativeId).run();
          await env.initiatives_db.prepare("DELETE FROM initiative_contributors WHERE initiativeId = ?").bind(initiativeId).run();

          // Delete the initiative
          await env.initiatives_db.prepare("DELETE FROM initiatives WHERE id = ?").bind(initiativeId).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "DELETE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 13. MEMBERS: BULK SYNC ──────────────────────────────────────────
      if (path === "/api/members/sync" && method === "POST") {
        try {
          const { councilId, members } = await request.json();

          // Clear existing members for this council
          await env.councils_db.prepare(
            "DELETE FROM members WHERE councilId = ?"
          ).bind(councilId).run();

          // Insert new members
          const statements = Object.entries(members).map(([key, m]) => {
            return env.councils_db.prepare(
              "INSERT INTO members (councilId, memberKey, name, role, username, password, createdAt) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
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

      // ─── 14. SYSTEM WIPE ─────────────────────────────────────────────────
      if (path === "/api/system/wipe" && method === "POST") {
        try {
          await env.councils_db.prepare("DELETE FROM councils").run();
          await env.councils_db.prepare("DELETE FROM members").run();
          await env.councils_db.prepare("DELETE FROM credentials").run();
          await env.initiatives_db.prepare("DELETE FROM initiatives").run();
          await env.initiatives_db.prepare("DELETE FROM progress_reports").run();
          await env.initiatives_db.prepare("DELETE FROM manager_comments").run();
          await env.initiatives_db.prepare("DELETE FROM initiative_status_history").run();
          await env.initiatives_db.prepare("DELETE FROM initiative_leads").run();
          await env.initiatives_db.prepare("DELETE FROM initiative_contributors").run();
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
