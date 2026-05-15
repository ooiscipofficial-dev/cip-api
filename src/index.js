/**
 * CouncilHub Backend — Cloudflare Workers + D1 (3 Separate Databases)
 * Handles syncing for Councils, Initiatives, and Resources.
 */

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

function isTruthyFlag(value) {
  return value === true || value === 1 || value === "1";
}

function clampScore(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function calculateImpactScore(data = {}) {
  const initiatives = data.initiatives || [];
  const approved = data.approvedList || data.approved || initiatives.filter(i => String(i.status || "").toLowerCase() === "approved");
  const successful = data.successfulInitiatives || initiatives.filter(i => isTruthyFlag(i.isSuccessful));
  const rejected = data.rejectedList || data.rejected || initiatives.filter(i => String(i.status || "").toLowerCase() === "rejected");
  const rawBase = Number(data.baseScore ?? data.info?.baseScore ?? 0);
  const base = Number.isFinite(rawBase) ? clampScore(rawBase, 0, 50) : 0;

  const activity = Math.min(initiatives.length * 0.5, 10);
  const approval = Math.min(approved.length * 1.0, 10);
  const execution = Math.min(successful.length * 3.0, 30);
  const rejectionPenalty = Math.min(rejected.length * 1.5, 15);

  const today = new Date().toISOString().split("T")[0];
  const overdue = initiatives.filter(i =>
    i.executionDate &&
    i.executionDate < today &&
    !isTruthyFlag(i.isSuccessful)
  ).length * 2;

  const inactivity = initiatives.length === 0 ? 5 : 0;
  const score = base + activity + approval + execution - rejectionPenalty - overdue - inactivity;

  return clampScore(Math.round(score));
}

const INITIATIVE_AUDIT_COLUMNS = {
  executedOnTime: "INTEGER",
  successNote: "TEXT",
  completedAt: "DATETIME",
  completedBy: "TEXT",
  managerNote: "TEXT",
  reviewedBy: "TEXT",
  dateReviewed: "TEXT",
};

let initiativeAuditColumnsReady = false;

async function ensureInitiativeAuditColumns(env) {
  if (initiativeAuditColumnsReady) return;

  const { results = [] } = await env.initiatives_db.prepare("PRAGMA table_info(initiatives)").all();
  const existing = new Set(results.map(column => column.name));

  for (const [column, type] of Object.entries(INITIATIVE_AUDIT_COLUMNS)) {
    if (!existing.has(column)) {
      await env.initiatives_db.prepare(`ALTER TABLE initiatives ADD COLUMN ${column} ${type}`).run();
    }
  }

  initiativeAuditColumnsReady = true;
}

function normalizeReviewData(reviewData) {
  if (typeof reviewData === "string") {
    return { note: reviewData, name: "Manager" };
  }

  return {
    note: reviewData?.note || reviewData?.text || reviewData?.reason || "",
    name: reviewData?.name || reviewData?.author || "Manager",
  };
}

function isManagerRequest(request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token.startsWith("mng_");
}

export default {
  async fetch(request, env, ctx) {
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
          "SELECT id, name, role FROM credentials WHERE councilId = ? AND username = ? AND password = ?"
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
            name: credResult.name || username,
            role: credResult.role || 'member',
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

      // ─── 3. GET ALL COUNCILS (BASIC) ───────────────────────────────────
      if (path === "/api/councils/all" && method === "GET") {
        try {
          const { results } = await env.councils_db.prepare(
            "SELECT id, name, color, googleEmail, mission, achievement, homepage FROM councils WHERE id != 'system'"
          ).all();
          return json(results.reduce((acc, row) => ({ ...acc, [row.id]: row }), {}));
        } catch (err) {
          return json({ error: "QUERY_FAILED", details: err.message }, 500);
        }
      }

      // ─── 4.0 SUPER-AGGREGATE: GET EVERYTHING FOR ALL COUNCILS ──────────
      // This endpoint replaces 14+ individual fetches with a single bulk query
      if (path.endsWith("/api/councils/full") || path.endsWith("/councils/full")) {
        try {
          // 1. Fetch all core councils
          const { results: councils } = await env.councils_db.prepare(
            "SELECT id, name, color, googleEmail, mission, achievement, homepage FROM councils WHERE id != 'system'"
          ).all();

          // 2. Fetch all related data in BULK (minimizing D1 roundtrips)
          const { results: allInitiatives } = await env.initiatives_db.prepare("SELECT * FROM initiatives").all();
          const { results: allComments } = await env.initiatives_db.prepare("SELECT * FROM manager_comments").all();
          const { results: allLeads } = await env.initiatives_db.prepare("SELECT * FROM initiative_leads").all();
          const { results: allContributors } = await env.initiatives_db.prepare("SELECT * FROM initiative_contributors").all();
          const { results: allReports } = await env.initiatives_db.prepare("SELECT * FROM progress_reports").all();
          const { results: allPadlets } = await env.resources_db.prepare("SELECT * FROM padlets").all();
          const { results: allProjects } = await env.resources_db.prepare("SELECT * FROM projects").all();
          const { results: allAnalysis } = await env.resources_db.prepare("SELECT * FROM strategic_analysis").all();
          const { results: allTimelineEvents } = await env.resources_db.prepare("SELECT * FROM timeline_events ORDER BY eventDate ASC").all();
          const fullData = {};

          for (const c of councils) {
            const id = c.id;
            const initiatives = allInitiatives.filter(i => i.councilId === id);
            
            // Hydrate initiatives
            for (let init of initiatives) {
              const status = String(init.status || "").toLowerCase();
              init.managerComments = allComments.filter(cm => cm.initiativeId === init.id);
              init.lead = allLeads.find(l => l.initiativeId === init.id) || { name: "Pending", role: "Initiative Lead" };
              init.contributors = allContributors.filter(con => con.initiativeId === init.id);
              init.progressReports = allReports.filter(r => r.initiativeId === init.id);
              init.execution = [
                { phase: "Planning", note: "Strategy and resource mapping.", status: "Completed" },
                { phase: "Execution", note: "Active deployment.", status: status === 'approved' ? 'Completed' : 'In Progress' },
                { phase: "Feedback", note: "Outcome assessment.", status: status === 'approved' ? 'Completed' : 'Not Started' }
              ];
              init.summary = init.description || "Council-led initiative.";
            }

            const padlets = {};
            allPadlets.filter(p => p.councilId === id).forEach(p => padlets[p.padletType] = p.url);

            const calendarEvents = initiatives.map(i => ({
              date: i.executionDate || i.createdAt,
              title: i.title,
              status: i.status,
              type: isTruthyFlag(i.isSuccessful) ? "Completed" : String(i.status || "").toLowerCase() === "approved" ? "Approved" : "Pending",
              initiativeId: i.id
            }));
            const successfulInitiatives = initiatives.filter(i => isTruthyFlag(i.isSuccessful));

            const councilRecord = {
              id: id,
              info: { ...c },
              initiatives,
              pendingList: initiatives.filter(i => String(i.status || "").toLowerCase() === 'pending'),
              approvedList: initiatives.filter(i => String(i.status || "").toLowerCase() === 'approved'),
              rejectedList: initiatives.filter(i => String(i.status || "").toLowerCase() === 'rejected'),
              successfulInitiatives,
              mainProject: allProjects.find(p => p.councilId === id) || { title: "", progress: 0, status: "Not Started" },
              padlets,
              strategicAnalysis: allAnalysis.find(a => a.councilId === id) || { summary: "Strategic overview pending.", strengths: "[]", risks: "[]", focus: "[]" },
              timelineEvents: allTimelineEvents.filter(e => e.councilId === id),
              calendarEvents
            };
            councilRecord.impactScore = calculateImpactScore(councilRecord);
            councilRecord.info.impactScore = councilRecord.impactScore;
            fullData[id] = councilRecord;
          }

          const response = new Response(JSON.stringify(fullData), {
            headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store" }
          });
          return response;

        } catch (err) {
          return json({ error: "AGGREGATION_FAILED", details: err.message }, 500);
        }
      }

      // ─── 4.1 GET GLOBAL ACTIVITY ──────────────────────────────────────
      if (path === "/api/system/activity" && method === "GET") {
        try {
          // Get last 10 initiatives
          const { results: initiatives } = await env.initiatives_db.prepare(
            "SELECT i.title, i.councilId, i.status, i.updatedAt as date, c.name as councilName " +
            "FROM initiatives i JOIN councils c ON i.councilId = c.id " +
            "ORDER BY i.updatedAt DESC LIMIT 10"
          ).all();

          const activity = initiatives.map(i => ({
            date: i.date.split(' ')[0],
            tag: i.status === 'approved' ? 'ok' : i.status === 'rejected' ? 'info' : 'event',
            label: i.status,
            msg: `${i.councilName} · ${i.title}`,
            initiativeId: i.id
          }));

          return json({ activity });
        } catch (err) {
          return json({ error: "ACTIVITY_FETCH_FAILED", details: err.message }, 500);
        }
      }

      // ─── 4.2 GET COUNCIL DATA ────────────────────────────────────────────
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
              successfulInitiatives: [],
              impactScore: 0,
              mainProject: { title: "", progress: 0, status: "Not Started" },
              padlets: { internal: "", personal: "", showcase: "" }
            });
          }

          // Get initiatives from initiatives_db
          const initiativesResult = await env.initiatives_db.prepare(
            "SELECT * FROM initiatives WHERE councilId = ? AND status IN ('approved', 'pending', 'rejected')"
          ).bind(id).all();

          const initiatives = initiativesResult?.results || [];

          // Get manager comments
          const commentsResult = await env.initiatives_db.prepare(
            "SELECT mc.id, mc.initiativeId, mc.comment as text, mc.createdBy as author, mc.createdAt as date " +
            "FROM manager_comments mc JOIN initiatives i ON mc.initiativeId = i.id " +
            "WHERE i.councilId = ?"
          ).bind(id).all();
          
          const allComments = commentsResult?.results || [];
          
          // Get leads for all initiatives of this council
          const { results: allLeads } = await env.initiatives_db.prepare(
            "SELECT il.* FROM initiative_leads il JOIN initiatives i ON il.initiativeId = i.id WHERE i.councilId = ?"
          ).bind(id).all();

          // Get contributors for all initiatives of this council
          const { results: allContributors } = await env.initiatives_db.prepare(
            "SELECT ic.* FROM initiative_contributors ic JOIN initiatives i ON ic.initiativeId = i.id WHERE i.councilId = ?"
          ).bind(id).all();

          // Get progress reports
          const { results: allReports } = await env.initiatives_db.prepare(
            "SELECT pr.* FROM progress_reports pr JOIN initiatives i ON pr.initiativeId = i.id WHERE i.councilId = ?"
          ).bind(id).all();

          for (let init of initiatives) {
            const status = String(init.status || "").toLowerCase();
            init.managerComments = allComments.filter(c => c.initiativeId === init.id);
            init.lead = allLeads.find(l => l.initiativeId === init.id) || { name: "Pending", role: "Initiative Lead" };
            init.contributors = allContributors.filter(c => c.initiativeId === init.id);
            init.progressReports = allReports.filter(r => r.initiativeId === init.id);
            
            // Format for frontend expectations
            init.execution = [
              { phase: "Planning", note: "Strategy and resource mapping.", status: "Completed" },
              { phase: "Execution", note: "Active deployment and student engagement.", status: status === 'approved' ? 'Completed' : 'In Progress' },
              { phase: "Feedback", note: "Outcome assessment and teacher review.", status: status === 'approved' ? 'Completed' : 'Not Started' }
            ];
            init.summary = init.description || "Council-led initiative focused on community impact and platform innovation.";
          }

          const pendingList = initiatives.filter(i => String(i.status || "").toLowerCase() === 'pending');
          const approvedList = initiatives.filter(i => String(i.status || "").toLowerCase() === 'approved');
          const rejectedList = initiatives.filter(i => String(i.status || "").toLowerCase() === 'rejected');
          const successfulInitiatives = initiatives.filter(i => isTruthyFlag(i.isSuccessful));

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

          // Get strategic analysis from resources_db
          const analysis = await env.resources_db.prepare(
            "SELECT summary, strengths, risks, focus FROM strategic_analysis WHERE councilId = ?"
          ).bind(id).first();

          // Get timeline events from resources_db
          const timelineResult = await env.resources_db.prepare(
            "SELECT eventDate as date, title, note FROM timeline_events WHERE councilId = ? ORDER BY eventDate ASC"
          ).bind(id).all();
          const timelineEvents = timelineResult?.results || [];
          const calendarEvents = initiatives.map(i => ({
            date: i.executionDate || i.createdAt,
            title: i.title,
            description: i.description || "Active initiative from council operations.",
            type: isTruthyFlag(i.isSuccessful) ? "Completed" : String(i.status || "").toLowerCase() === "approved" ? "Approved" : "Pending",
            status: i.status,
            initiativeId: i.id
          }));
          const impactScore = calculateImpactScore({
            initiatives,
            pendingList,
            approvedList,
            rejectedList,
            successfulInitiatives,
            mainProject,
            calendarEvents
          });

          // Return data with proper info wrapper
          return json({
            id: council.id,
            impactScore,
            info: {
              mission: council.mission,
              achievement: council.achievement,
              homepage: council.homepage,
              name: council.name,
              color: council.color,
              googleEmail: council.googleEmail,
              impactScore
            },
            initiatives,
            pendingList,
            approvedList,
            rejectedList,
            mainProject,
            padlets,
            successfulInitiatives,
            calendarEvents,
            strategicAnalysis: analysis || { 
              summary: "Strategic overview pending manager analysis.", 
              strengths: "[]", 
              risks: "[]", 
              focus: "[]" 
            },
            timelineEvents
          });
        } catch (err) {
          return json({ error: "FETCH_FAILED", details: err.message }, 500);
        }
      }

      // ─── 4.5 GET SYSTEM SETTINGS ───────────────────────────────────────
      if (path === "/api/system/settings" && method === "GET") {
        try {
          const result = await env.councils_db.prepare(
            "SELECT mission as commonsPadlet FROM councils WHERE id = 'system'"
          ).first();
          
          return json({ settings: result || { commonsPadlet: "" } });
        } catch (err) {
          return json({ error: "SETTINGS_FETCH_FAILED", details: err.message }, 500);
        }
      }

      // ─── 4.6 SAVE SYSTEM SETTINGS ──────────────────────────────────────
      if (path === "/api/system/settings" && method === "POST") {
        try {
          const { commonsPadlet } = await request.json();
          
          await env.councils_db.prepare(
            "INSERT INTO councils (id, name, mission, updatedAt) VALUES ('system', 'System Settings', ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(id) DO UPDATE SET mission = excluded.mission, updatedAt = CURRENT_TIMESTAMP"
          ).bind(commonsPadlet).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "SETTINGS_SAVE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 5. SAVE COUNCIL INFO ───────────────────────────────────────────
      if (path === "/api/council/save" && method === "POST") {
        try {
          const body = await request.json();
          const { id, name, mission, achievement, homepage, color, googleEmail, info, padlets, mainProjectTitle, mainProjectProgress, mainProjectStatus } = body;

          // Extract values from either top-level or info wrapper
          const councilName = name || info?.name || '';
          const councilMission = mission || info?.mission || '';
          const councilAchievement = achievement || info?.achievement || '';
          const councilHomepage = homepage || info?.homepage || '';
          const councilColor = color || info?.color || '';
          const councilEmail = googleEmail || info?.googleEmail || '';
          
          const title = mainProjectTitle || info?.mainProjectTitle || '';
          const progress = mainProjectProgress ?? info?.mainProjectProgress ?? 0;
          const projStatus = mainProjectStatus || info?.mainProjectStatus || 'Not Started';

          await env.councils_db.prepare(
            "INSERT INTO councils (id, name, color, googleEmail, mission, achievement, homepage, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, mission = excluded.mission, achievement = excluded.achievement, homepage = excluded.homepage, color = excluded.color, googleEmail = excluded.googleEmail, updatedAt = CURRENT_TIMESTAMP"
          ).bind(id, councilName, councilColor, councilEmail, councilMission, councilAchievement, councilHomepage).run();

          // Save Main Project
          if (title && title.trim() !== '') {
            // Delete existing main project for council (we only store 1 per council for now)
            await env.resources_db.prepare("DELETE FROM projects WHERE councilId = ?").bind(id).run();
            // Insert the new one
            await env.resources_db.prepare(
              "INSERT INTO projects (councilId, title, progress, status, updatedAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
            ).bind(id, title, progress, projStatus).run();
          }

          if (padlets) {
            const stmts = Object.entries(padlets).map(([type, url]) => {
              if (url && url.trim() !== '') {
                return env.resources_db.prepare(
                  "INSERT INTO padlets (councilId, padletType, url, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
                  "ON CONFLICT(councilId, padletType) DO UPDATE SET url = excluded.url, updatedAt = CURRENT_TIMESTAMP"
                ).bind(id, type, url);
              } else {
                return env.resources_db.prepare(
                  "DELETE FROM padlets WHERE councilId = ? AND padletType = ?"
                ).bind(id, type);
              }
            });
            if (stmts.length > 0) {
              await env.resources_db.batch(stmts);
            }
          }

          return json({ success: true });
        } catch (err) {
          return json({ error: "SERVER_ERROR", msg: err.message }, 500);
        }
      }

      // ─── X. GET/SAVE PADLETS ENDPOINT (PadletSection.jsx) ───────────────
      const padletMatch = path.match(/^\/api\/councils\/([^/]+)\/padlets$/);
      if (padletMatch) {
        const councilId = padletMatch[1];
        
        if (method === "GET") {
          try {
            const padletResults = await env.resources_db.prepare(
              "SELECT padletType, url FROM padlets WHERE councilId = ?"
            ).bind(councilId).all();

            const padlets = {};
            if (padletResults?.results) {
              padletResults.results.forEach(p => {
                padlets[p.padletType] = p.url;
              });
            }
            return json({ padlets });
          } catch (err) {
            return json({ error: "FETCH_FAILED", details: err.message }, 500);
          }
        }
        
        if (method === "POST") {
          try {
            const { padlets } = await request.json();
            if (padlets) {
              const stmts = Object.entries(padlets).map(([type, url]) => {
                if (url && url.trim() !== '') {
                  return env.resources_db.prepare(
                    "INSERT INTO padlets (councilId, padletType, url, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
                    "ON CONFLICT(councilId, padletType) DO UPDATE SET url = excluded.url, updatedAt = CURRENT_TIMESTAMP"
                  ).bind(councilId, type, url);
                } else {
                   return env.resources_db.prepare(
                    "DELETE FROM padlets WHERE councilId = ? AND padletType = ?"
                  ).bind(councilId, type);
                }
              });
              if (stmts.length > 0) {
                await env.resources_db.batch(stmts);
              }
            }
            return json({ success: true });
          } catch (err) {
            return json({ error: "SAVE_FAILED", details: err.message }, 500);
          }
        }
      }

      // ─── 6. SAVE CREDENTIALS ────────────────────────────────────────────
      if (path === "/api/credentials/list" && method === "GET") {
        try {
          if (!isManagerRequest(request)) {
            return json({ error: "UNAUTHORIZED" }, 401);
          }

          const councilId = url.searchParams.get("councilId");
          if (!councilId) {
            return json({ error: "MISSING_COUNCIL_ID" }, 400);
          }

          const credsResult = await env.councils_db.prepare(
            "SELECT id, username, password, name, role FROM credentials WHERE councilId = ? ORDER BY id ASC"
          ).bind(councilId).all();

          const credentials = {};
          (credsResult?.results || []).forEach((cred) => {
            credentials[`credential_${cred.id}`] = {
              id: cred.id,
              username: cred.username,
              password: cred.password,
              name: cred.name,
              role: cred.role
            };
          });

          return json({ credentials });
        } catch (err) {
          return json({ error: "CREDENTIALS_FETCH_FAILED", details: err.message }, 500);
        }
      }

      if (path === "/api/credentials/save" && method === "POST") {
        try {
          if (!isManagerRequest(request)) {
            return json({ error: "UNAUTHORIZED" }, 401);
          }

          const { councilId, credentials } = await request.json();

          // Ensure council exists in the councils table (prevent FK constraint error)
          await env.councils_db.prepare(
            "INSERT OR IGNORE INTO councils (id, name, createdAt, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
          ).bind(councilId, councilId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')).run();

          // Clear existing credentials for this council
          await env.councils_db.prepare(
            "DELETE FROM credentials WHERE councilId = ?"
          ).bind(councilId).run();

          // Filter out entries with empty usernames to avoid UNIQUE constraint errors
          const validEntries = Object.entries(credentials).filter(
            ([, cred]) => cred.username && cred.username.trim() !== ''
          );

          if (validEntries.length > 0) {
            // Use INSERT OR IGNORE to gracefully handle any remaining duplicates
            const statements = validEntries.map(([key, cred]) => {
              return env.councils_db.prepare(
                "INSERT OR IGNORE INTO credentials (councilId, username, password, name, role, createdAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
              ).bind(councilId, cred.username.trim(), cred.password || '', cred.name || '', cred.role || 'Council Junior');
            });
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
          await ensureInitiativeAuditColumns(env);
          const {
            councilId,
            id,
            title,
            description,
            objectives,
            expectedOutcomes,
            initiativeType,
            executionDate,
            status,
            isSuccessful,
            successVisible,
            executedOnTime,
            successNote,
            completedAt,
            completedBy,
            managerNote,
            reviewedBy,
            dateReviewed
          } = await request.json();

          await env.initiatives_db.prepare(
            "INSERT INTO initiatives (id, councilId, title, description, objectives, expectedOutcomes, initiativeType, executionDate, status, isSuccessful, successVisible, executedOnTime, successNote, completedAt, completedBy, managerNote, reviewedBy, dateReviewed, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, objectives = excluded.objectives, expectedOutcomes = excluded.expectedOutcomes, initiativeType = excluded.initiativeType, executionDate = excluded.executionDate, status = excluded.status, isSuccessful = excluded.isSuccessful, successVisible = excluded.successVisible, executedOnTime = excluded.executedOnTime, successNote = excluded.successNote, completedAt = excluded.completedAt, completedBy = excluded.completedBy, managerNote = excluded.managerNote, reviewedBy = excluded.reviewedBy, dateReviewed = excluded.dateReviewed, updatedAt = CURRENT_TIMESTAMP"
          ).bind(
            id,
            councilId,
            title,
            description,
            objectives,
            expectedOutcomes,
            initiativeType,
            executionDate,
            String(status || 'pending').toLowerCase(),
            isTruthyFlag(isSuccessful) ? 1 : 0,
            isTruthyFlag(successVisible) ? 1 : 0,
            executedOnTime == null ? null : (isTruthyFlag(executedOnTime) ? 1 : 0),
            successNote || '',
            completedAt || null,
            completedBy || null,
            managerNote || null,
            reviewedBy || null,
            dateReviewed || null
          ).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "INITIATIVE_SAVE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 9. APPROVE INITIATIVE ──────────────────────────────────────────
      if (path === "/api/initiatives/approve" && method === "POST") {
        try {
          await ensureInitiativeAuditColumns(env);
          const { councilId, initiativeId, reviewData } = await request.json();
          const { note, name } = normalizeReviewData(reviewData);

          const existing = await env.initiatives_db.prepare(
            "SELECT status FROM initiatives WHERE id = ? AND councilId = ?"
          ).bind(initiativeId, councilId).first();

          if (!existing) {
            return json({ error: "INITIATIVE_NOT_FOUND" }, 404);
          }

          // Update initiative status
          await env.initiatives_db.prepare(
            "UPDATE initiatives SET status = 'approved', managerNote = ?, reviewedBy = ?, dateReviewed = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND councilId = ?"
          ).bind(note, name, new Date().toISOString().split("T")[0], initiativeId, councilId).run();

          // Log status change
          await env.initiatives_db.prepare(
            "INSERT INTO initiative_status_history (initiativeId, oldStatus, newStatus, changedBy, reason, changedAt) VALUES (?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP)"
          ).bind(initiativeId, existing.status || 'pending', name, note).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "APPROVE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 10. REJECT INITIATIVE ──────────────────────────────────────────
      if (path === "/api/initiatives/reject" && method === "POST") {
        try {
          await ensureInitiativeAuditColumns(env);
          const { councilId, initiativeId, reason } = await request.json();
          const { note, name } = normalizeReviewData(reason);

          const existing = await env.initiatives_db.prepare(
            "SELECT status FROM initiatives WHERE id = ? AND councilId = ?"
          ).bind(initiativeId, councilId).first();

          if (!existing) {
            return json({ error: "INITIATIVE_NOT_FOUND" }, 404);
          }

          // Update initiative status
          await env.initiatives_db.prepare(
            "UPDATE initiatives SET status = 'rejected', isSuccessful = 0, successVisible = 0, managerNote = ?, reviewedBy = ?, dateReviewed = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND councilId = ?"
          ).bind(note, name, new Date().toISOString().split("T")[0], initiativeId, councilId).run();

          // Log status change
          await env.initiatives_db.prepare(
            "INSERT INTO initiative_status_history (initiativeId, oldStatus, newStatus, changedBy, reason, changedAt) VALUES (?, ?, 'rejected', ?, ?, CURRENT_TIMESTAMP)"
          ).bind(initiativeId, existing.status || 'pending', name, note).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "REJECT_FAILED", details: err.message }, 500);
        }
      }

      // ─── 11. ADD COMMENT ────────────────────────────────────────────────
      if (path === "/api/initiatives/complete" && method === "POST") {
        try {
          await ensureInitiativeAuditColumns(env);
          const { councilId, initiativeId, executedOnTime, successNote, completedBy } = await request.json();

          const initiative = await env.initiatives_db.prepare(
            "SELECT * FROM initiatives WHERE id = ? AND councilId = ?"
          ).bind(initiativeId, councilId).first();

          if (!initiative) {
            return json({ error: "INITIATIVE_NOT_FOUND" }, 404);
          }

          if (String(initiative.status || "").toLowerCase() !== "approved") {
            return json({ error: "Only manager-approved initiatives can be marked completed" }, 409);
          }

          await env.initiatives_db.prepare(
            "UPDATE initiatives SET isSuccessful = 1, successVisible = 1, executedOnTime = ?, successNote = ?, completedAt = CURRENT_TIMESTAMP, completedBy = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND councilId = ?"
          ).bind(executedOnTime ? 1 : 0, successNote || "", completedBy || "President", initiativeId, councilId).run();

          await env.initiatives_db.prepare(
            "INSERT INTO initiative_status_history (initiativeId, oldStatus, newStatus, changedBy, reason, changedAt) VALUES (?, 'approved', 'completed', ?, ?, CURRENT_TIMESTAMP)"
          ).bind(initiativeId, completedBy || "President", successNote || "").run();

          const updated = await env.initiatives_db.prepare(
            "SELECT * FROM initiatives WHERE id = ? AND councilId = ?"
          ).bind(initiativeId, councilId).first();

          return json({ success: true, initiative: updated });
        } catch (err) {
          return json({ error: "COMPLETE_FAILED", details: err.message }, 500);
        }
      }

      if (path === "/api/initiatives/comment" && method === "POST") {
        try {
          const { councilId, initiativeId, comment } = await request.json();

          // comment is either string or object { text, author }
          const commentText = typeof comment === 'string' ? comment : comment.text;
          const author = typeof comment === 'string' ? 'Manager' : (comment.author || 'Manager');

          await env.initiatives_db.prepare(
            "INSERT INTO manager_comments (initiativeId, comment, createdBy, createdAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
          ).bind(initiativeId, commentText, author).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "COMMENT_FAILED", details: err.message }, 500);
        }
      }

      // ─── 11.5 DELETE COMMENT ──────────────────────────────────────────────
      if (path === "/api/initiatives/comment/delete" && method === "POST") {
        try {
          const { commentId } = await request.json();

          await env.initiatives_db.prepare(
            "DELETE FROM manager_comments WHERE id = ?"
          ).bind(commentId).run();

          return json({ success: true });
        } catch (err) {
          return json({ error: "DELETE_COMMENT_FAILED", details: err.message }, 500);
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
          await env.resources_db.prepare("DELETE FROM strategic_analysis").run();
          await env.resources_db.prepare("DELETE FROM timeline_events").run();

          return json({ success: true, message: "System wiped successfully" });
        } catch (err) {
          return json({ error: "WIPE_FAILED", details: err.message }, 500);
        }
      }

      // ─── 15. SAVE STRATEGIC ANALYSIS ──────────────────────────────────────
      if (path === "/api/council/analysis/save" && method === "POST") {
        try {
          const { councilId, summary, strengths, risks, focus } = await request.json();
          await env.resources_db.prepare(
            "INSERT INTO strategic_analysis (councilId, summary, strengths, risks, focus, updatedAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(councilId) DO UPDATE SET summary=excluded.summary, strengths=excluded.strengths, risks=excluded.risks, focus=excluded.focus, updatedAt=excluded.updatedAt"
          ).bind(councilId, summary, JSON.stringify(strengths), JSON.stringify(risks), JSON.stringify(focus)).run();
          return json({ success: true });
        } catch (err) {
          return json({ error: "SAVE_ANALYSIS_FAILED", details: err.message }, 500);
        }
      }

      // ─── 16. SAVE TIMELINE EVENTS ─────────────────────────────────────────
      if (path === "/api/council/timeline/save" && method === "POST") {
        try {
          const { councilId, events } = await request.json();
          // Clear and replace
          await env.resources_db.prepare("DELETE FROM timeline_events WHERE councilId = ?").bind(councilId).run();
          const statements = events.map(ev => {
            return env.resources_db.prepare(
              "INSERT INTO timeline_events (councilId, eventDate, title, note) VALUES (?, ?, ?, ?)"
            ).bind(councilId, ev.date, ev.title, ev.note);
          });
          if (statements.length > 0) {
            await env.resources_db.batch(statements);
          }
          return json({ success: true });
        } catch (err) {
          return json({ error: "SAVE_TIMELINE_FAILED", details: err.message }, 500);
        }
      }


      return json({ error: "NOT_FOUND" }, 404);
    } catch (err) {
      return new Response(JSON.stringify({ error: "SERVER_ERROR", msg: err.message }), { status: 500, headers: corsHeaders() });
    }
  }
};
