-- initiatives_db: All initiative data & tracking

CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  councilId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  objectives TEXT,
  expectedOutcomes TEXT,
  initiativeType TEXT,
  executionDate TEXT,
  status TEXT DEFAULT 'pending',
  isSuccessful BOOLEAN DEFAULT 0,
  successVisible BOOLEAN DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE initiative_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initiativeId TEXT NOT NULL,
  name TEXT,
  role TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE CASCADE
);

CREATE TABLE initiative_contributors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initiativeId TEXT NOT NULL,
  name TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE CASCADE
);

CREATE TABLE progress_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initiativeId TEXT NOT NULL,
  content TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE CASCADE
);

CREATE TABLE manager_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initiativeId TEXT NOT NULL,
  comment TEXT NOT NULL,
  createdBy TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE CASCADE
);

CREATE TABLE initiative_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initiativeId TEXT NOT NULL,
  oldStatus TEXT,
  newStatus TEXT,
  changedBy TEXT,
  reason TEXT,
  changedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE CASCADE
);