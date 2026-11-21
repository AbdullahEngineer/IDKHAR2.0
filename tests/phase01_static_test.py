from pathlib import Path
p=Path(__file__).resolve().parents[1]
s=(p/'index.html').read_text()
m=(p/'003_add_revision_history_to_existing_schema.sql').read_text()
assert "sb.rpc('fn_add_deposit'" in s
assert "await db.update('goals', g.id, g)" not in s
assert "document.getElementById('goal-current').disabled = true" in s
assert "income_sources" in s
assert "goal_deposits" in s
assert "ADD COLUMN IF NOT EXISTS revisions" in m
print('PASS: phase02 static checks — not a live database test')
