DROP TABLE IF EXISTS audits;
CREATE TABLE IF NOT EXISTS audit_answers (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL,
  city TEXT NOT NULL,
  plate TEXT,
  campo TEXT NOT NULL,
  valor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
