-- Standing daily check-ins (distinct from emma_tasks, which has no
-- recurrence concept). One row per ongoing thing Ray wants nudged about
-- daily until he marks it complete.
CREATE TABLE IF NOT EXISTS emma_checkins (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'completed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- One row per day Ray reports progress against a check-in. "date" is the
-- London calendar date the report covers, used to decide whether today
-- already has a report (so nudges stop for the day) independent of what
-- time the report came in.
CREATE TABLE IF NOT EXISTS emma_checkin_progress (
  id BIGSERIAL PRIMARY KEY,
  checkin_id BIGINT NOT NULL REFERENCES emma_checkins(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkin_progress_lookup ON emma_checkin_progress (checkin_id, date);
