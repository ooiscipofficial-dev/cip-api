CREATE TABLE councils (
  id TEXT PRIMARY KEY,
  name TEXT,
  color TEXT,
  googleEmail TEXT,
  mission TEXT,
  achievement TEXT,
  homepage TEXT,
  mainProject TEXT, -- JSON String
  padlets TEXT,     -- JSON String
  initiatives TEXT, -- JSON String
  pendingList TEXT, -- JSON String
  approvedList TEXT,-- JSON String
  rejectedList TEXT -- JSON String
);

CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  councilId TEXT,
  memberKey TEXT,
  name TEXT,
  role TEXT,
  username TEXT,
  password TEXT
);