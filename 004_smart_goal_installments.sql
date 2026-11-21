-- Masar 2.0 — smart monthly goal installments.
-- Apply to the EXISTING IDKHAR2.0 database after the previous migrations.
-- Additive migration: does not drop or rewrite existing financial records.
BEGIN;

-- Existing goal_deposits already stores the goal, owner, amount and month index.
ALTER TABLE public.goal_deposits
  ADD COLUMN IF NOT EXISTS installment_id bigint;

CREATE TABLE IF NOT EXISTS public.goal_installments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  goal_id bigint NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_idx integer NOT NULL,
  planned_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (planned_amount >= 0),
  paid_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  paid_at timestamptz,
  deposit_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(goal_id, month_idx)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='goal_deposits_installment_fk') THEN
    ALTER TABLE public.goal_deposits ADD CONSTRAINT goal_deposits_installment_fk
      FOREIGN KEY (installment_id) REFERENCES public.goal_installments(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='goal_deposits_installment_unique') THEN
    CREATE UNIQUE INDEX goal_deposits_installment_unique
      ON public.goal_deposits(installment_id) WHERE installment_id IS NOT NULL;
  END IF;
END $$;

ALTER TABLE public.goal_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goal_installments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goal_installments_owner_read ON public.goal_installments;
CREATE POLICY goal_installments_owner_read ON public.goal_installments
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.goal_installments FROM anon, authenticated;
GRANT SELECT ON public.goal_installments TO authenticated;

-- Keep the month rows in sync with each goal's selected start month and duration.
CREATE OR REPLACE FUNCTION public.fn_refresh_goal_installments(p_goal_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_goal public.goals%ROWTYPE; v_balance numeric(14,2); v_open integer; v_base numeric(14,2); v_last numeric(14,2);
BEGIN
  SELECT * INTO v_goal FROM public.goals WHERE id=p_goal_id AND user_id=(SELECT auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.goal_installments(goal_id,user_id,month_idx)
  SELECT v_goal.id,v_goal.user_id,v_goal.start_month_idx + n
  FROM generate_series(0,v_goal.months-1) AS n
  ON CONFLICT(goal_id,month_idx) DO NOTHING;

  -- Remove only unpaid months that are outside the edited plan. Paid history is retained.
  DELETE FROM public.goal_installments
  WHERE goal_id=v_goal.id AND paid_at IS NULL
    AND (month_idx < v_goal.start_month_idx OR month_idx >= v_goal.start_month_idx + v_goal.months);

  SELECT GREATEST(0, v_goal.target - v_goal.initial_amount - COALESCE(SUM(d.amount),0))
    INTO v_balance
  FROM public.goal_deposits d WHERE d.goal_id=v_goal.id;
  v_balance := COALESCE(v_balance, GREATEST(0,v_goal.target-v_goal.initial_amount));

  SELECT COUNT(*) INTO v_open FROM public.goal_installments
  WHERE goal_id=v_goal.id AND paid_at IS NULL;
  IF v_open <= 0 THEN RETURN; END IF;
  v_base := floor((v_balance / v_open) * 100) / 100;
  v_last := v_balance - (v_base * (v_open-1));
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY month_idx) AS rn, count(*) OVER () AS total
    FROM public.goal_installments WHERE goal_id=v_goal.id AND paid_at IS NULL
  )
  UPDATE public.goal_installments gi
  SET planned_amount=CASE WHEN ordered.rn=ordered.total THEN v_last ELSE v_base END
  FROM ordered WHERE gi.id=ordered.id;
END $$;

-- Backfill schedules for goals that already existed before this feature.
DO $$ DECLARE g record; BEGIN
  FOR g IN SELECT id FROM public.goals LOOP
    -- This migration runs as the project owner; temporarily use the goal owner for the helper's auth check.
    INSERT INTO public.goal_installments(goal_id,user_id,month_idx)
    SELECT goals.id,goals.user_id,goals.start_month_idx+n
    FROM public.goals CROSS JOIN LATERAL generate_series(0,goals.months-1) n
    WHERE goals.id=g.id ON CONFLICT(goal_id,month_idx) DO NOTHING;
    -- Link only unambiguous historical months (exactly one deposit in that month).
    -- Months with multiple deposits remain unchecked to avoid deleting the wrong history later.
    UPDATE public.goal_installments gi
    SET paid_amount=x.amount, paid_at=now(), deposit_id=x.deposit_id
    FROM (
      SELECT goal_id,month_idx,MAX(amount) AS amount,MAX(id) AS deposit_id
      FROM public.goal_deposits WHERE goal_id=g.id AND month_idx IS NOT NULL
      GROUP BY goal_id,month_idx HAVING COUNT(*)=1
    ) x
    WHERE gi.goal_id=g.id AND gi.month_idx=x.month_idx;
    UPDATE public.goal_deposits d SET installment_id=gi.id
    FROM public.goal_installments gi
    WHERE gi.goal_id=g.id AND gi.goal_id=d.goal_id AND gi.month_idx=d.month_idx
      AND gi.deposit_id=d.id AND gi.paid_at IS NOT NULL;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.fn_pay_goal_installment(
  p_goal_id bigint, p_month_idx integer, p_amount numeric
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := (SELECT auth.uid()); v_goal public.goals%ROWTYPE; v_row public.goal_installments%ROWTYPE; v_deposit_id bigint; v_balance numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_amount IS NULL OR p_amount<=0 OR p_amount>999999999999.99 OR p_amount<>round(p_amount,2) THEN
    RAISE EXCEPTION 'Invalid deposit amount' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_goal FROM public.goals WHERE id=p_goal_id AND user_id=v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
  IF p_month_idx<v_goal.start_month_idx OR p_month_idx>=v_goal.start_month_idx+v_goal.months THEN
    RAISE EXCEPTION 'Month is outside the goal plan' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.goal_installments(goal_id,user_id,month_idx)
  VALUES(p_goal_id,v_uid,p_month_idx) ON CONFLICT(goal_id,month_idx) DO NOTHING;
  SELECT * INTO v_row FROM public.goal_installments WHERE goal_id=p_goal_id AND month_idx=p_month_idx FOR UPDATE;
  IF v_row.paid_at IS NOT NULL THEN RAISE EXCEPTION 'Installment already paid' USING ERRCODE='23505'; END IF;
  INSERT INTO public.goal_deposits(goal_id,user_id,amount,month_idx,installment_id)
  VALUES(p_goal_id,v_uid,p_amount,p_month_idx,v_row.id) RETURNING id INTO v_deposit_id;
  UPDATE public.goal_installments SET paid_amount=p_amount,paid_at=now(),deposit_id=v_deposit_id
  WHERE id=v_row.id;
  PERFORM public.fn_refresh_goal_installments(p_goal_id);
  SELECT v_goal.initial_amount + COALESCE(SUM(amount),0) INTO v_balance
  FROM public.goal_deposits WHERE goal_id=p_goal_id;
  RETURN COALESCE(v_balance,v_goal.initial_amount);
END $$;

CREATE OR REPLACE FUNCTION public.fn_unpay_goal_installment(p_goal_id bigint,p_month_idx integer)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := (SELECT auth.uid()); v_goal public.goals%ROWTYPE; v_row public.goal_installments%ROWTYPE; v_balance numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_goal FROM public.goals WHERE id=p_goal_id AND user_id=v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_row FROM public.goal_installments WHERE goal_id=p_goal_id AND month_idx=p_month_idx AND user_id=v_uid FOR UPDATE;
  IF NOT FOUND OR v_row.paid_at IS NULL OR v_row.deposit_id IS NULL THEN
    RAISE EXCEPTION 'Paid installment not found' USING ERRCODE='P0002';
  END IF;
  DELETE FROM public.goal_deposits WHERE id=v_row.deposit_id AND goal_id=p_goal_id AND user_id=v_uid;
  UPDATE public.goal_installments SET paid_amount=0,paid_at=NULL,deposit_id=NULL WHERE id=v_row.id;
  PERFORM public.fn_refresh_goal_installments(p_goal_id);
  SELECT v_goal.initial_amount + COALESCE(SUM(amount),0) INTO v_balance
  FROM public.goal_deposits WHERE goal_id=p_goal_id;
  RETURN COALESCE(v_balance,v_goal.initial_amount);
END $$;

-- Refresh the plan after ordinary deposits too, so the remaining monthly amount adjusts.
CREATE OR REPLACE FUNCTION public.fn_goal_deposit_refresh_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM public.fn_refresh_goal_installments(OLD.goal_id);
    RETURN OLD;
  ELSE
    PERFORM public.fn_refresh_goal_installments(NEW.goal_id);
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS goal_deposit_refresh ON public.goal_deposits;
CREATE TRIGGER goal_deposit_refresh AFTER INSERT OR DELETE ON public.goal_deposits
FOR EACH ROW EXECUTE FUNCTION public.fn_goal_deposit_refresh_trigger();

-- Refresh rows when the owner changes a goal's duration or start month.
CREATE OR REPLACE FUNCTION public.fn_goal_plan_update_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.months IS DISTINCT FROM OLD.months OR NEW.start_month_idx IS DISTINCT FROM OLD.start_month_idx OR NEW.target IS DISTINCT FROM OLD.target THEN
    PERFORM public.fn_refresh_goal_installments(NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS goal_plan_update ON public.goals;
CREATE TRIGGER goal_plan_update AFTER UPDATE OF months,start_month_idx,target ON public.goals
FOR EACH ROW EXECUTE FUNCTION public.fn_goal_plan_update_trigger();

CREATE OR REPLACE FUNCTION public.fn_goal_plan_insert_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- New goals start with all monthly rows available and an evenly split plan.
  PERFORM public.fn_refresh_goal_installments(NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS goal_plan_insert ON public.goals;
CREATE TRIGGER goal_plan_insert AFTER INSERT ON public.goals
FOR EACH ROW EXECUTE FUNCTION public.fn_goal_plan_insert_trigger();

REVOKE ALL ON FUNCTION public.fn_refresh_goal_installments(bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_pay_goal_installment(bigint,integer,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_unpay_goal_installment(bigint,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_pay_goal_installment(bigint,integer,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_unpay_goal_installment(bigint,integer) TO authenticated;
GRANT UPDATE (start_month_idx) ON public.goals TO authenticated;

COMMIT;
