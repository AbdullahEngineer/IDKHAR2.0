-- Masar 2.0 — Phase 03 foundation: monthly budgets + BNPL installments
-- Additive migration for the existing IDKHAR2.0 Supabase schema.
-- Does not alter or delete existing financial records.
BEGIN;

CREATE TABLE IF NOT EXISTS public.monthly_budgets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_idx integer NOT NULL,
  total_limit numeric(14,2) NOT NULL CHECK (total_limit > 0),
  rollover_mode text NOT NULL DEFAULT 'none'
    CHECK (rollover_mode IN ('none','surplus','deficit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, month_idx)
);

CREATE TABLE IF NOT EXISTS public.budget_categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_id bigint NOT NULL REFERENCES public.monthly_budgets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (char_length(trim(category)) > 0),
  limit_amount numeric(14,2) NOT NULL CHECK (limit_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(budget_id, category)
);

CREATE TABLE IF NOT EXISTS public.bnpl_plans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('tabby','tamara','other')),
  provider_label text,
  purchase_description text NOT NULL,
  purchase_amount numeric(14,2) NOT NULL CHECK (purchase_amount > 0),
  currency text NOT NULL DEFAULT 'ر.س',
  installment_count integer NOT NULL CHECK (installment_count BETWEEN 1 AND 60),
  first_due_date date NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bnpl_installments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES public.bnpl_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  installment_number integer NOT NULL CHECK (installment_number > 0),
  due_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming','paid','overdue','cancelled')),
  paid_at timestamptz,
  transaction_id bigint REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id, installment_number)
);

-- Durable reminder queue. A scheduled Edge Function/pg_cron worker will
-- deliver due rows and mark them sent; the table alone does not send push alerts.
CREATE TABLE IF NOT EXISTS public.notification_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('bnpl_installment')),
  source_id bigint NOT NULL,
  reminder_hours integer NOT NULL CHECK (reminder_hours IN (72,48,24)),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','cancelled','failed')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_type, source_id, reminder_hours)
);

ALTER TABLE public.monthly_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bnpl_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bnpl_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_jobs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'monthly_budgets','budget_categories','bnpl_plans',
    'bnpl_installments','notification_jobs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()))',
      t || '_owner_all', t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.monthly_budgets, public.budget_categories,
  public.bnpl_plans, public.bnpl_installments
TO authenticated;
GRANT SELECT ON public.notification_jobs TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

CREATE INDEX IF NOT EXISTS idx_monthly_budgets_user_month
  ON public.monthly_budgets(user_id, month_idx DESC);
CREATE INDEX IF NOT EXISTS idx_budget_categories_budget
  ON public.budget_categories(user_id, budget_id);
CREATE INDEX IF NOT EXISTS idx_bnpl_plans_user_status
  ON public.bnpl_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bnpl_installments_user_due
  ON public.bnpl_installments(user_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON public.notification_jobs(scheduled_for)
  WHERE status = 'pending';

-- Create an installment schedule atomically, distributing rounding remainder
-- into the final installment. The due date advances by calendar months.
CREATE OR REPLACE FUNCTION public.fn_create_bnpl_plan(
  p_provider text,
  p_description text,
  p_total numeric,
  p_installment_count integer,
  p_first_due_date date,
  p_provider_label text DEFAULT NULL,
  p_currency text DEFAULT 'ر.س',
  p_notes text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := (SELECT auth.uid());
  v_plan_id bigint;
  v_base numeric(14,2);
  v_last numeric(14,2);
  i integer;
  v_due date;
  v_amount numeric(14,2);
  v_job_time timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'Invalid total'; END IF;
  IF p_installment_count IS NULL OR p_installment_count NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Invalid installment count';
  END IF;
  IF p_first_due_date IS NULL OR p_first_due_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'First due date must be today or later';
  END IF;
  IF p_provider NOT IN ('tabby','tamara','other') THEN RAISE EXCEPTION 'Invalid provider'; END IF;

  INSERT INTO public.bnpl_plans(
    user_id, provider, provider_label, purchase_description,
    purchase_amount, currency, installment_count, first_due_date, notes
  ) VALUES (
    v_user, p_provider, p_provider_label, trim(p_description),
    p_total, coalesce(p_currency,'ر.س'), p_installment_count, p_first_due_date, p_notes
  ) RETURNING id INTO v_plan_id;

  v_base := floor((p_total / p_installment_count) * 100) / 100;
  v_last := p_total - (v_base * (p_installment_count - 1));

  FOR i IN 1..p_installment_count LOOP
    v_due := (p_first_due_date + ((i - 1) * interval '1 month'))::date;
    v_amount := CASE WHEN i = p_installment_count THEN v_last ELSE v_base END;

    INSERT INTO public.bnpl_installments(
      plan_id,user_id,installment_number,due_date,amount
    ) VALUES (v_plan_id,v_user,i,v_due,v_amount);

    FOREACH v_job_time IN ARRAY ARRAY[
      (v_due::timestamp - interval '72 hours') AT TIME ZONE 'Asia/Riyadh',
      (v_due::timestamp - interval '48 hours') AT TIME ZONE 'Asia/Riyadh',
      (v_due::timestamp - interval '24 hours') AT TIME ZONE 'Asia/Riyadh'
    ] LOOP
      INSERT INTO public.notification_jobs(
        user_id,source_type,source_id,reminder_hours,scheduled_for
      ) VALUES (
        v_user,'bnpl_installment',
        (SELECT id FROM public.bnpl_installments
         WHERE plan_id=v_plan_id AND installment_number=i),
        CASE
          WHEN v_job_time = ((v_due::timestamp - interval '72 hours') AT TIME ZONE 'Asia/Riyadh') THEN 72
          WHEN v_job_time = ((v_due::timestamp - interval '48 hours') AT TIME ZONE 'Asia/Riyadh') THEN 48
          ELSE 24
        END,
        v_job_time
      )
      ON CONFLICT(source_type,source_id,reminder_hours) DO NOTHING;
    END LOOP;
  END LOOP;

  RETURN v_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_bnpl_plan(text,text,numeric,integer,date,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_bnpl_plan(text,text,numeric,integer,date,text,text,text) TO authenticated;

COMMIT;
