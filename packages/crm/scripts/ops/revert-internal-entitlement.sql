-- EPIC 2026-10-20 — audited reversal of ONE internal entitlement (lib/workspace/transfer-ownership.ts setInternalWorkspaceEntitlement).
-- Prepared and tested in advance so recovery never improvises a database edit (Port ev-laneA-epic-company-setup-package-2026-10-20).
-- Run ONLY under owner authorisation, AFTER every applied ownership transfer of the workspace has been rolled back:
--   psql -v ON_ERROR_STOP=1 --single-transaction -d uplink \
--     -v org=<workspace uuid> -v entitlement_action=<internal_entitlement actionId> \
--     -v actor_id=<platform admin user uuid> -v actor_email=<platform admin email> -f revert-internal-entitlement.sql
-- Inputs reach SQL only as psql-quoted literals (:'var') through set_config, never by text substitution (Codex r5); the uuid casts
-- refuse anything that is not a uuid.
-- One block, one transaction: every check passes and both writes happen, or nothing changes. It refuses (raises) when
--   the action is not an applied internal_entitlement of that workspace, or was already reverted;
--   ANY applied ownership transfer of the workspace lacks an applied rollback (no timestamp ordering is relied on: audit created_at is
--   transaction start time, Codex r5), so the entitlement is never removed under a transferred owner;
--   the workspace no longer matches the action's recorded after-state (drift), or it is Stripe-managed;
--   the actor is not a user with that email.
-- It restores organizations.plan and the subscription's tier/status to the recorded before-state (other subscription keys untouched),
-- and writes an internal_entitlement audit row with reason 'revert' and reverts_action_id = the entitlement action.
SELECT set_config('epic_revert.org', :'org', true), set_config('epic_revert.entitlement_action', :'entitlement_action', true),
       set_config('epic_revert.actor_id', :'actor_id', true), set_config('epic_revert.actor_email', :'actor_email', true);
DO $revert$
DECLARE
  v_org uuid := current_setting('epic_revert.org')::uuid;
  v_ent uuid := current_setting('epic_revert.entitlement_action')::uuid;
  v_actor uuid := current_setting('epic_revert.actor_id')::uuid;
  v_actor_email text := current_setting('epic_revert.actor_email');
  o record;
  a record;
  v_sub jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_actor AND lower(email) = lower(v_actor_email)) THEN
    RAISE EXCEPTION 'revert refused: actor_not_found';
  END IF;
  SELECT id, plan, coalesce(subscription, '{}'::jsonb) AS subscription INTO o FROM organizations WHERE id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'revert refused: workspace_not_found'; END IF;
  SELECT id, created_at, before, after INTO a FROM workspace_admin_actions
    WHERE id = v_ent AND org_id = v_org AND action = 'internal_entitlement' AND outcome = 'applied' AND reverts_action_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'revert refused: entitlement_action_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM workspace_admin_actions WHERE reverts_action_id = a.id AND action = 'internal_entitlement' AND outcome = 'applied') THEN
    RAISE EXCEPTION 'revert refused: already_reverted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workspace_admin_actions x
    WHERE x.org_id = v_org AND x.action = 'ownership_transfer' AND x.outcome = 'applied'
      AND NOT EXISTS (SELECT 1 FROM workspace_admin_actions r
                      WHERE r.reverts_action_id = x.id AND r.action = 'ownership_transfer_rollback' AND r.outcome = 'applied')
  ) THEN
    RAISE EXCEPTION 'revert refused: transfer_still_applied (roll the ownership back first)';
  END IF;
  IF o.subscription ?| array['stripeSubscriptionId', 'stripeCustomerId', 'stripePriceId'] THEN
    RAISE EXCEPTION 'revert refused: stripe_managed_subscription';
  END IF;
  IF o.plan IS DISTINCT FROM a.after->>'plan'
     OR o.subscription->>'tier' IS DISTINCT FROM a.after->>'tier'
     OR o.subscription->>'status' IS DISTINCT FROM a.after->>'status' THEN
    RAISE EXCEPTION 'revert refused: state_drifted (plan %, tier %, status %)', o.plan, o.subscription->>'tier', o.subscription->>'status';
  END IF;

  v_sub := o.subscription - 'tier' - 'status';
  IF a.before->>'tier' IS NOT NULL THEN v_sub := v_sub || jsonb_build_object('tier', a.before->>'tier'); END IF;
  IF a.before->>'status' IS NOT NULL THEN v_sub := v_sub || jsonb_build_object('status', a.before->>'status'); END IF;

  UPDATE organizations SET plan = a.before->>'plan', subscription = v_sub, updated_at = v_now WHERE id = v_org;
  INSERT INTO workspace_admin_actions (org_id, action, outcome, reason, actor_user_id, actor_email, before, after, reverts_action_id, created_at)
  VALUES (v_org, 'internal_entitlement', 'applied', 'revert', v_actor, v_actor_email,
          jsonb_build_object('plan', o.plan, 'tier', o.subscription->'tier', 'status', o.subscription->'status'),
          jsonb_build_object('plan', a.before->>'plan', 'tier', a.before->'tier', 'status', a.before->'status', 'paymentCollection', 'off'),
          a.id, v_now);
  RAISE NOTICE 'reverted internal entitlement % on workspace %: plan % -> %', a.id, v_org, o.plan, a.before->>'plan';
END
$revert$;
