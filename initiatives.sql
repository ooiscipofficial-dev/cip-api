DROP TABLE IF EXISTS initiatives;

CREATE TABLE initiatives (
    id TEXT PRIMARY KEY,
    councilId TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    objectives TEXT,
    expectedOutcomes TEXT,
    initiativeType TEXT,
    executionDate TEXT,
    status TEXT,
    lead TEXT,           -- Stored as JSON string
    contributors TEXT,   -- Stored as JSON string
    execution TEXT,      -- Stored as JSON string
    progressReports TEXT, -- Stored as JSON string
    managerComments TEXT, -- Stored as JSON string
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (councilId) REFERENCES councils(id) ON DELETE CASCADE
);