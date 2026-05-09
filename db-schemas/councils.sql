-- councils_db: Core council & member data

CREATE TABLE councils (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  googleEmail TEXT,
  mission TEXT,
  achievement TEXT,
  homepage TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  councilId TEXT NOT NULL,
  memberKey TEXT,
  name TEXT NOT NULL,
  role TEXT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (councilId) REFERENCES councils(id) ON DELETE CASCADE
);

CREATE TABLE credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  councilId TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT,
  role TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (councilId) REFERENCES councils(id) ON DELETE CASCADE
);