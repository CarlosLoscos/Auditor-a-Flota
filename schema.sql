CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  moto_id TEXT NOT NULL,
  campo TEXT NOT NULL,
  valor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
