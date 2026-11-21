-- Masar: apply ONLY to the already-created six-table IDKHAR2.0 schema.
-- This is additive and does not drop or recreate any financial data.
BEGIN;
ALTER TABLE public.income_sources
  ADD COLUMN IF NOT EXISTS revisions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS revisions jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='income_sources_revisions_array_ck') THEN
    ALTER TABLE public.income_sources ADD CONSTRAINT income_sources_revisions_array_ck
      CHECK (jsonb_typeof(revisions)='array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_revisions_array_ck') THEN
    ALTER TABLE public.expenses ADD CONSTRAINT expenses_revisions_array_ck
      CHECK (jsonb_typeof(revisions)='array');
  END IF;
END $$;
COMMIT;
