-- Uplink production schema baseline (schema only, no data)
-- Source: Deepseek beta DB seldonframe (Postgres 16.15) via pg_dump --schema-only --no-owner --no-privileges --no-comments
-- Removed: neon_control_plane schema (created by the Neon local HTTP proxy, not by the app)
-- Not included: migration ledger (the migration chain is the open P2 defect)
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    user_id uuid NOT NULL,
    type text NOT NULL,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    refresh_token text,
    access_token text,
    expires_at integer,
    token_type text,
    scope text,
    id_token text,
    session_state text
);


--
-- Name: acp_checkout_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acp_checkout_sessions (
    id text NOT NULL,
    status text NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    items jsonb NOT NULL,
    buyer jsonb,
    totals jsonb NOT NULL,
    "order" jsonb,
    seller_org_id text,
    listing_slug text,
    fee_cents integer DEFAULT 0,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    deal_id uuid,
    user_id uuid NOT NULL,
    type text NOT NULL,
    subject text,
    body text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    scheduled_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agency_support_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agency_support_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agency_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    origin_user_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    ip_hash text,
    user_agent text,
    notes text
);


--
-- Name: agent_action_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_action_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    agent_id text NOT NULL,
    conversation_id text NOT NULL,
    step_action text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content jsonb NOT NULL,
    tier text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by_user_id uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    agent_version integer NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    anonymous_session_id text,
    channel_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    operator_quality text,
    operator_notes text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_turn_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    llm_cost_cents integer DEFAULT 0 NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    turn_count integer DEFAULT 0 NOT NULL
);


--
-- Name: agent_evals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_evals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    agent_version integer NOT NULL,
    scenario_id text NOT NULL,
    scenario jsonb NOT NULL,
    expected jsonb NOT NULL,
    actual jsonb,
    passed boolean,
    error text,
    ran_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_improve_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_improve_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    based_on_version integer NOT NULL,
    patch jsonb NOT NULL,
    rationale jsonb NOT NULL,
    baseline_run_id uuid,
    candidate_run_id uuid,
    status text DEFAULT 'proposed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: agent_reflection_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_reflection_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    surface text NOT NULL,
    instruction_summary text,
    trigger_tool text,
    pass boolean NOT NULL,
    skipped text,
    gaps jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_run_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    deployment_id uuid,
    trigger_kind text NOT NULL,
    source_ref text,
    status text NOT NULL,
    summary text NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_taste_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_taste_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    listing_id uuid NOT NULL,
    slug text NOT NULL,
    source_url text NOT NULL,
    grounding jsonb NOT NULL,
    ip_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: agent_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    builder_org_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    type text NOT NULL,
    blueprint jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    eval_score integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    turn_index integer NOT NULL,
    role text NOT NULL,
    content text,
    tool_calls jsonb,
    tool_results jsonb,
    validators_passed jsonb DEFAULT '[]'::jsonb NOT NULL,
    latency_ms integer,
    tokens_in integer,
    tokens_out integer,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    version integer NOT NULL,
    blueprint jsonb NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by_user_id uuid,
    publish_notes text
);


--
-- Name: agent_workflow_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_workflow_traces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    deployment_id uuid,
    trigger_kind text NOT NULL,
    kind text DEFAULT 'trace'::text NOT NULL,
    trigger_key text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    ok boolean NOT NULL,
    call_count integer DEFAULT 0 NOT NULL,
    records jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    channel text NOT NULL,
    archetype text NOT NULL,
    blueprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    daily_token_budget integer DEFAULT 50000 NOT NULL,
    tokens_used_today integer DEFAULT 0 NOT NULL,
    tokens_used_reset_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    kind text DEFAULT 'user'::text NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    block_name text NOT NULL,
    template_version text NOT NULL,
    generation_prompt text NOT NULL,
    customizations jsonb DEFAULT '[]'::jsonb NOT NULL,
    props jsonb NOT NULL,
    rendered_html text NOT NULL,
    rendered_html_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid,
    block_id text NOT NULL,
    stripe_payment_id text,
    purchased_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_ratings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    block_id text NOT NULL,
    user_id uuid,
    org_id uuid NOT NULL,
    rating integer NOT NULL,
    review text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_subscription_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_subscription_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,
    event_log_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    delivered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_subscription_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_subscription_registry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    block_slug text NOT NULL,
    event_type text NOT NULL,
    handler_name text NOT NULL,
    idempotency_key_template text DEFAULT '{{id}}'::text NOT NULL,
    filter_predicate jsonb,
    retry_policy jsonb DEFAULT '{"max": 3, "backoff": "exponential", "initial_delay_ms": 1000}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    user_id uuid,
    title text NOT NULL,
    booking_slug text DEFAULT 'default'::text NOT NULL,
    full_name text,
    email text,
    notes text,
    provider text DEFAULT 'manual'::text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    meeting_url text,
    external_event_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_html text,
    content_css text,
    cancelled_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brain_compilation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_compilation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    articles_updated text[] DEFAULT '{}'::text[] NOT NULL,
    events_processed integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brain_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_events (
    event_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    workspace_id text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    salience_score numeric(4,3) DEFAULT 0.5 NOT NULL,
    feedback_score integer,
    anonymized boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brain_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    scope text NOT NULL,
    path text NOT NULL,
    body text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3) DEFAULT 0.500 NOT NULL,
    uses integer DEFAULT 0 NOT NULL,
    wins integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brain_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    vertical character varying(50),
    event_type character varying(50) NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome character varying(50),
    outcome_value_cents integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: builder_llm_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.builder_llm_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    builder_org_id uuid NOT NULL,
    provider text NOT NULL,
    encrypted_key text NOT NULL,
    hint text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: change_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    submission_id uuid,
    plan jsonb NOT NULL,
    status text DEFAULT 'pending_review'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    first_name text NOT NULL,
    last_name text,
    email text,
    phone text,
    company text,
    title text,
    status text DEFAULT 'lead'::text NOT NULL,
    source text,
    score integer DEFAULT 0 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    assigned_to uuid,
    last_contacted_at timestamp with time zone,
    portal_access_enabled boolean DEFAULT false NOT NULL,
    portal_last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    author_email text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    direction text NOT NULL,
    channel text NOT NULL,
    content text NOT NULL,
    email_id uuid,
    sms_message_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    subject text,
    assistant_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_turn_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    title text NOT NULL,
    value numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    stage text NOT NULL,
    probability integer DEFAULT 0 NOT NULL,
    expected_close_date date,
    assigned_to uuid,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    builder_org_id uuid NOT NULL,
    agent_template_id uuid NOT NULL,
    client_name text NOT NULL,
    client_contact jsonb,
    surface text DEFAULT 'phone'::text NOT NULL,
    phone_number text,
    phone_number_sid text,
    number_origin text,
    calendar_ref jsonb,
    booking_mode text DEFAULT 'native'::text NOT NULL,
    external_booking_url text,
    booking_policy jsonb,
    customization jsonb,
    client_context jsonb,
    price_cents integer DEFAULT 0 NOT NULL,
    stripe_subscription_id text,
    stripe_customer_id text,
    client_org_id uuid,
    portal_invited_at timestamp with time zone,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_auth_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_auth_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    atok text NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    device_label text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_at timestamp with time zone,
    issued_token_id uuid,
    issued_token_raw text DEFAULT ''::text NOT NULL,
    claimed_at timestamp with time zone,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    email_id uuid NOT NULL,
    event_type text NOT NULL,
    provider text DEFAULT 'resend'::text NOT NULL,
    provider_event_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    user_id uuid,
    provider text DEFAULT 'resend'::text NOT NULL,
    from_email text NOT NULL,
    to_email text NOT NULL,
    subject text NOT NULL,
    body_text text,
    body_html text,
    status text DEFAULT 'queued'::text NOT NULL,
    external_message_id text,
    open_count integer DEFAULT 0 NOT NULL,
    click_count integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone,
    opened_at timestamp with time zone,
    last_clicked_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_run_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_run_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    result jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    kind text NOT NULL,
    pass_rate integer NOT NULL,
    scenario_count integer NOT NULL,
    passed_count integer NOT NULL,
    grader_model text,
    blueprint_version integer,
    results_summary jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_agent_scheduled_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_agent_scheduled_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    event_type text NOT NULL,
    contact_id uuid,
    payload jsonb NOT NULL,
    agent_skill text NOT NULL,
    channel text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    last_error text
);


--
-- Name: form_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    form_name text NOT NULL,
    data jsonb NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    scored_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: generated_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    block_id text NOT NULL,
    seller_org_id uuid,
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'generated'::text NOT NULL,
    review_notes text,
    approved_at timestamp with time zone,
    merged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: intake_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intake_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    fields jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_html text,
    content_css text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: intake_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intake_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    form_id uuid NOT NULL,
    contact_id uuid,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    description text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    provider text DEFAULT 'stripe'::text NOT NULL,
    stripe_invoice_id text,
    stripe_account_id text,
    stripe_customer_id text,
    number text,
    status text DEFAULT 'draft'::text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    subtotal numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    tax numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    amount_paid numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    amount_due numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    due_at timestamp with time zone,
    sent_at timestamp with time zone,
    paid_at timestamp with time zone,
    voided_at timestamp with time zone,
    hosted_invoice_url text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: landing_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    page_type text DEFAULT 'page'::text NOT NULL,
    source text DEFAULT 'template'::text NOT NULL,
    puck_data jsonb DEFAULT 'null'::jsonb,
    sections jsonb DEFAULT '[]'::jsonb NOT NULL,
    content_html text,
    content_css text,
    blueprint_json jsonb DEFAULT 'null'::jsonb,
    editor_data jsonb DEFAULT 'null'::jsonb,
    seo jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: landing_payload_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_payload_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    payload jsonb NOT NULL,
    instruction text,
    summary text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    block_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    long_description text,
    icon text NOT NULL,
    category text NOT NULL,
    preview_images jsonb DEFAULT '[]'::jsonb NOT NULL,
    seller_id uuid,
    seller_name text NOT NULL,
    seller_stripe_account_id text,
    price numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    block_md text NOT NULL,
    generation_status text DEFAULT 'pending'::text NOT NULL,
    install_count integer DEFAULT 0 NOT NULL,
    rating_average numeric(2,1),
    rating_count integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_listings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_listings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    creator_org_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    long_description text,
    niche text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    price integer DEFAULT 0 NOT NULL,
    price_model text DEFAULT 'onetime'::text NOT NULL,
    monthly_price_cents integer,
    per_call_price_cents integer,
    per_outcome_price_cents integer,
    outcome_type text,
    soul_package jsonb NOT NULL,
    kind text DEFAULT 'soul'::text NOT NULL,
    agent_blueprint jsonb,
    agent_type text,
    preview_image_url text,
    preview_images jsonb DEFAULT '[]'::jsonb NOT NULL,
    install_count integer DEFAULT 0 NOT NULL,
    rating real DEFAULT 0 NOT NULL,
    review_count integer DEFAULT 0 NOT NULL,
    stripe_connect_account_id text,
    is_published boolean DEFAULT false NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    trust_stats jsonb,
    seller_preferences jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    listing_id uuid NOT NULL,
    slug text NOT NULL,
    buyer_org_id uuid NOT NULL,
    seller_org_id uuid NOT NULL,
    price_model text NOT NULL,
    amount_cents integer DEFAULT 0 NOT NULL,
    fee_cents integer DEFAULT 0 NOT NULL,
    stripe_mode text DEFAULT 'test'::text NOT NULL,
    stripe_customer_id text,
    stripe_checkout_id text,
    stripe_subscription_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    listing_id uuid NOT NULL,
    buyer_org_id uuid NOT NULL,
    rating integer NOT NULL,
    review text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    plan text,
    stripe_subscription_id text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_trigger_fires; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_trigger_fires (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trigger_id uuid NOT NULL,
    message_id text NOT NULL,
    run_id uuid,
    skipped_reason text,
    fired_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    archetype_id text NOT NULL,
    channel text NOT NULL,
    channel_binding jsonb NOT NULL,
    pattern jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: metrics_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrics_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    date date NOT NULL,
    contacts_total integer DEFAULT 0 NOT NULL,
    contacts_new integer DEFAULT 0 NOT NULL,
    pipeline_value numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    deals_won integer DEFAULT 0 NOT NULL,
    deals_lost integer DEFAULT 0 NOT NULL,
    win_rate numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    avg_deal_cycle_days numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    bookings_total integer DEFAULT 0 NOT NULL,
    booking_no_show_rate numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    emails_sent integer DEFAULT 0 NOT NULL,
    email_open_rate numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    email_click_rate numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    portal_active_clients integer DEFAULT 0 NOT NULL,
    revenue_total numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    revenue_new numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    custom_metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_authorization_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_authorization_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code_hash text NOT NULL,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    code_challenge text NOT NULL,
    resource text,
    scope text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id text NOT NULL,
    client_name text,
    redirect_uris jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    family_id uuid NOT NULL,
    client_id text NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    api_key_id uuid,
    resource text,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: onboarding_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    token text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone
);


--
-- Name: org_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    owner_id uuid,
    parent_user_id uuid,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    soul jsonb DEFAULT 'null'::jsonb,
    soul_id text,
    soul_content_generated integer DEFAULT 0 NOT NULL,
    soul_learning jsonb DEFAULT '{}'::jsonb NOT NULL,
    theme jsonb DEFAULT '{"mode": "light", "logoUrl": null, "fontFamily": "Geist", "accentColor": "#3d6e4f", "borderRadius": "rounded", "motionPreset": "balanced", "primaryColor": "#1f2421"}'::jsonb NOT NULL,
    soul_completed_at timestamp with time zone,
    enabled_blocks text[] DEFAULT '{}'::text[] NOT NULL,
    integrations jsonb DEFAULT '{}'::jsonb NOT NULL,
    subscription jsonb DEFAULT '{}'::jsonb NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    email_sends_this_month integer DEFAULT 0 NOT NULL,
    ai_calls_today integer DEFAULT 0 NOT NULL,
    usage_reset_at timestamp with time zone,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    test_mode boolean DEFAULT false NOT NULL,
    preview_mode boolean DEFAULT false NOT NULL,
    parent_agency_id uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_internal boolean DEFAULT false NOT NULL
);


--
-- Name: outbound_message_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_message_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    trigger_id uuid,
    channel text NOT NULL,
    event_type text NOT NULL,
    contact_id uuid,
    to_address text NOT NULL,
    subject text,
    body text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    external_message_id text,
    error text,
    sent_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbound_message_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_message_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    event_type text NOT NULL,
    channel text NOT NULL,
    skill_id text NOT NULL,
    delay_minutes integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    custom_skill_md text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbound_scheduled_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_scheduled_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    channel text NOT NULL,
    event_type text NOT NULL,
    fire_at timestamp with time zone NOT NULL,
    contact_id uuid,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    send_id uuid,
    note text,
    fired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_agencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_agencies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo_url text,
    primary_color text,
    accent_color text,
    support_email text,
    support_url text,
    sender_email_address text,
    resend_domain_id text,
    verified_sender_at timestamp with time zone,
    agency_domain text,
    agency_domain_verified_at timestamp with time zone,
    owner_user_id uuid,
    owner_workspace_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    hide_powered_by_badge boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    provider_account_id text,
    provider_event_id text,
    event_type text NOT NULL,
    target_type text DEFAULT 'payment'::text NOT NULL,
    target_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    booking_id uuid,
    stripe_payment_intent_id text,
    stripe_account_id text,
    stripe_charge_id text,
    refunded_amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    refunded_at timestamp with time zone,
    disputed_at timestamp with time zone,
    stripe_dispute_id text,
    amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    source_block text NOT NULL,
    source_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: personality_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personality_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_type_key text NOT NULL,
    schema jsonb NOT NULL,
    source text DEFAULT 'llm'::text NOT NULL,
    validated boolean DEFAULT true NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    generated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    stages jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_access_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_access_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    email text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    file_name text NOT NULL,
    file_size bigint NOT NULL,
    mime_type text NOT NULL,
    blob_url text NOT NULL,
    blob_path text NOT NULL,
    uploaded_by_user_id uuid,
    viewed_at timestamp with time zone,
    download_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    sender_type text DEFAULT 'client'::text NOT NULL,
    sender_name text,
    subject text,
    body text NOT NULL,
    attachment_url text,
    attachment_name text,
    is_pinned text DEFAULT 'false'::text NOT NULL,
    pinned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: portal_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    url text,
    resource_type text DEFAULT 'link'::text NOT NULL,
    viewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: preview_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preview_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    url text NOT NULL,
    business_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    detected_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    theme_color text,
    raw_markdown text,
    claimed_by_org_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: proposal_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposal_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proposal_id uuid NOT NULL,
    event_type text NOT NULL,
    metadata jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agency_org_id uuid NOT NULL,
    prospect_url text NOT NULL,
    prospect_name text NOT NULL,
    prospect_email text NOT NULL,
    prospect_first_name text,
    prospect_phone text,
    preview_workspace_id uuid,
    pricing_tier text NOT NULL,
    monthly_price_cents integer NOT NULL,
    setup_fee_cents integer DEFAULT 0 NOT NULL,
    generated_html text NOT NULL,
    scope_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    internal_notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    email_subject text,
    email_body text,
    intro_text text,
    timeline_text text,
    terms_text text,
    signed_token text NOT NULL,
    sent_at timestamp with time zone,
    first_viewed_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    declined_reason text,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    stripe_checkout_session_id text,
    stripe_subscription_id text,
    stripe_customer_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid
);


--
-- Name: recording_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    status text DEFAULT 'recording'::text NOT NULL,
    token_hash text NOT NULL,
    ip_hash text NOT NULL,
    flow_model jsonb,
    open_questions jsonb,
    interview_log jsonb,
    derived_scenarios jsonb,
    answered_questions jsonb,
    agent_template_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referrer_org_id uuid NOT NULL,
    referee_org_id uuid NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    credited_at timestamp with time zone
);


--
-- Name: replay_send_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replay_send_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    step_n integer NOT NULL,
    idempotency_key text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome text DEFAULT 'unknown'::text NOT NULL
);


--
-- Name: replay_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replay_skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    name text,
    skill_md text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    source_trace_id uuid,
    heal_count integer DEFAULT 0 NOT NULL,
    last_replay_at timestamp with time zone,
    trigger_filter jsonb,
    idempotency jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduled_trigger_fires; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_trigger_fires (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scheduled_trigger_id uuid NOT NULL,
    fire_time_utc timestamp with time zone NOT NULL,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduled_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    archetype_id text NOT NULL,
    cron_expression text NOT NULL,
    timezone text NOT NULL,
    catchup text DEFAULT 'skip'::text NOT NULL,
    concurrency text DEFAULT 'skip'::text NOT NULL,
    next_fire_at timestamp with time zone NOT NULL,
    last_fired_at timestamp with time zone,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seldon_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seldon_patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    framework_type text NOT NULL,
    block_type text NOT NULL,
    block_subtype text,
    structure jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome jsonb DEFAULT '{}'::jsonb NOT NULL,
    sample_size integer DEFAULT 0 NOT NULL,
    confidence real DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seldon_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seldon_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    title text NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seldon_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seldon_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    block_id text,
    mode text DEFAULT 'included'::text NOT NULL,
    model text,
    input_tokens integer,
    output_tokens integer,
    estimated_cost numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    billed_amount numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seldonframe_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seldonframe_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event character varying(100) NOT NULL,
    org_id uuid,
    contact_id uuid,
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    session_token text NOT NULL,
    user_id uuid NOT NULL,
    expires timestamp with time zone NOT NULL
);


--
-- Name: share_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    slug text NOT NULL,
    sanitized_steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    sms_message_id uuid NOT NULL,
    event_type text NOT NULL,
    provider text DEFAULT 'twilio'::text NOT NULL,
    provider_event_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    user_id uuid,
    provider text DEFAULT 'twilio'::text NOT NULL,
    direction text DEFAULT 'outbound'::text NOT NULL,
    from_number text NOT NULL,
    to_number text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    external_message_id text,
    error_code text,
    error_message text,
    segments integer DEFAULT 1 NOT NULL,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: soul_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.soul_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    type text NOT NULL,
    title text,
    source_url text,
    raw_content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: soul_wiki; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.soul_wiki (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    content text NOT NULL,
    source_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_compiled_at timestamp with time zone,
    compilation_version text DEFAULT '1'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    stripe_account_id text NOT NULL,
    access_token text,
    stripe_publishable_key text,
    is_active boolean DEFAULT true NOT NULL,
    connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    contact_id uuid,
    provider text DEFAULT 'stripe'::text NOT NULL,
    stripe_subscription_id text,
    stripe_account_id text,
    stripe_customer_id text,
    stripe_price_id text,
    product_name text,
    status text DEFAULT 'active'::text NOT NULL,
    amount numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    "interval" text DEFAULT 'month'::text NOT NULL,
    interval_count text DEFAULT '1'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at timestamp with time zone,
    canceled_at timestamp with time zone,
    trial_end timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supervised_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervised_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    action_log jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: suppression_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppression_list (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    email text,
    phone text,
    reason text DEFAULT 'manual'::text NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: url_extraction_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.url_extraction_cache (
    url_hash text NOT NULL,
    kind text NOT NULL,
    url text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    avatar_url text,
    email_verified timestamp with time zone,
    password_hash text,
    plan_id text,
    stripe_customer_id text,
    stripe_payment_method_id text,
    stripe_subscription_id text,
    billing_period text DEFAULT 'monthly'::text NOT NULL,
    subscription_status text DEFAULT 'trialing'::text NOT NULL,
    trial_ends_at timestamp with time zone,
    onboarding_completed_at timestamp with time zone,
    agency_profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_tokens (
    identifier text NOT NULL,
    token text NOT NULL,
    expires timestamp with time zone NOT NULL
);


--
-- Name: wallet_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    balance_micros bigint DEFAULT 0 NOT NULL,
    stripe_mode text DEFAULT 'test'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wallet_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    amount_micros bigint NOT NULL,
    run_id text,
    stripe_ref text,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_endpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    url text NOT NULL,
    events text[] NOT NULL,
    secret text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    step_id text NOT NULL,
    org_id uuid NOT NULL,
    approver_type text NOT NULL,
    approver_user_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    context_title text NOT NULL,
    context_summary text NOT NULL,
    context_preview text,
    context_metadata jsonb,
    timeout_action text NOT NULL,
    timeout_at timestamp with time zone,
    resolved_at timestamp with time zone,
    resolved_by_user_id uuid,
    resolution_comment text,
    resolution_reason text,
    override_flag boolean DEFAULT false NOT NULL,
    magic_link_token_hash text,
    magic_link_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    emitted_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_by_waits uuid[]
);


--
-- Name: workflow_recordings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    slot_index integer NOT NULL,
    label text,
    transcript jsonb,
    frame_blob_urls jsonb,
    video_blob_url text,
    trace jsonb,
    status text DEFAULT 'uploaded'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    archetype_id text NOT NULL,
    spec_snapshot jsonb NOT NULL,
    trigger_event_id uuid,
    trigger_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    current_step_id text,
    capture_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    variable_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    context jsonb,
    failure_count jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_tokens_input integer DEFAULT 0 NOT NULL,
    total_tokens_output integer DEFAULT 0 NOT NULL,
    total_cost_usd_estimate numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_step_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_step_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    step_id text NOT NULL,
    step_type text NOT NULL,
    outcome text NOT NULL,
    capture_value jsonb,
    error_message text,
    duration_ms integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_waits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_waits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    step_id text NOT NULL,
    event_type text NOT NULL,
    match_predicate jsonb,
    timeout_at timestamp with time zone NOT NULL,
    resumed_at timestamp with time zone,
    resumed_by uuid,
    resumed_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    icon character varying(50) DEFAULT 'bot'::character varying NOT NULL,
    trigger jsonb NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    slug character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    icon character varying(50) DEFAULT 'file-text'::character varying NOT NULL,
    schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    hostname text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    verification_record jsonb DEFAULT '{}'::jsonb NOT NULL,
    verified_at timestamp with time zone,
    failed_reason text,
    is_primary boolean DEFAULT false NOT NULL,
    vercel_domain_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    slug character varying(100) NOT NULL,
    title character varying(255) NOT NULL,
    page_type character varying(50) NOT NULL,
    visibility character varying(20) DEFAULT 'admin'::character varying NOT NULL,
    collection_id uuid,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    style_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    rendered_html text,
    rendered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    contact_id uuid,
    status character varying(100),
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    scope text DEFAULT 'workspace'::text NOT NULL,
    service_name text NOT NULL,
    encrypted_value text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    fingerprint text NOT NULL
);


--
-- Name: workspace_sidebar_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_sidebar_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    label character varying(100) NOT NULL,
    icon character varying(50) DEFAULT 'file-text'::character varying NOT NULL,
    href character varying(255) NOT NULL,
    group_name character varying(50) DEFAULT 'YOUR BLOCKS'::character varying NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts accounts_provider_provider_account_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_provider_provider_account_id_pk PRIMARY KEY (provider, provider_account_id);


--
-- Name: acp_checkout_sessions acp_checkout_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acp_checkout_sessions
    ADD CONSTRAINT acp_checkout_sessions_pkey PRIMARY KEY (id);


--
-- Name: activities activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);


--
-- Name: agency_support_sessions agency_support_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_support_sessions
    ADD CONSTRAINT agency_support_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_action_drafts agent_action_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_action_drafts
    ADD CONSTRAINT agent_action_drafts_pkey PRIMARY KEY (id);


--
-- Name: agent_conversations agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (id);


--
-- Name: agent_evals agent_evals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_evals
    ADD CONSTRAINT agent_evals_pkey PRIMARY KEY (id);


--
-- Name: agent_improve_proposals agent_improve_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_improve_proposals
    ADD CONSTRAINT agent_improve_proposals_pkey PRIMARY KEY (id);


--
-- Name: agent_reflection_events agent_reflection_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_reflection_events
    ADD CONSTRAINT agent_reflection_events_pkey PRIMARY KEY (id);


--
-- Name: agent_run_receipts agent_run_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_receipts
    ADD CONSTRAINT agent_run_receipts_pkey PRIMARY KEY (id);


--
-- Name: agent_taste_sessions agent_taste_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_taste_sessions
    ADD CONSTRAINT agent_taste_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_templates agent_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_pkey PRIMARY KEY (id);


--
-- Name: agent_turns agent_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_turns
    ADD CONSTRAINT agent_turns_pkey PRIMARY KEY (id);


--
-- Name: agent_versions agent_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);


--
-- Name: agent_workflow_traces agent_workflow_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_workflow_traces
    ADD CONSTRAINT agent_workflow_traces_pkey PRIMARY KEY (id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: block_instances block_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_instances
    ADD CONSTRAINT block_instances_pkey PRIMARY KEY (id);


--
-- Name: block_purchases block_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_purchases
    ADD CONSTRAINT block_purchases_pkey PRIMARY KEY (id);


--
-- Name: block_ratings block_ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_ratings
    ADD CONSTRAINT block_ratings_pkey PRIMARY KEY (id);


--
-- Name: block_subscription_deliveries block_subscription_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_subscription_deliveries
    ADD CONSTRAINT block_subscription_deliveries_pkey PRIMARY KEY (id);


--
-- Name: block_subscription_registry block_subscription_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_subscription_registry
    ADD CONSTRAINT block_subscription_registry_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: brain_compilation_runs brain_compilation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_compilation_runs
    ADD CONSTRAINT brain_compilation_runs_pkey PRIMARY KEY (id);


--
-- Name: brain_events brain_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_events
    ADD CONSTRAINT brain_events_pkey PRIMARY KEY (event_id);


--
-- Name: brain_notes brain_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_notes
    ADD CONSTRAINT brain_notes_pkey PRIMARY KEY (id);


--
-- Name: brain_outcomes brain_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_outcomes
    ADD CONSTRAINT brain_outcomes_pkey PRIMARY KEY (id);


--
-- Name: builder_llm_keys builder_llm_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_llm_keys
    ADD CONSTRAINT builder_llm_keys_pkey PRIMARY KEY (id);


--
-- Name: change_plans change_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_plans
    ADD CONSTRAINT change_plans_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: conversation_notes conversation_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_notes
    ADD CONSTRAINT conversation_notes_pkey PRIMARY KEY (id);


--
-- Name: conversation_turns conversation_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_turns
    ADD CONSTRAINT conversation_turns_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: device_auth_requests device_auth_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_auth_requests
    ADD CONSTRAINT device_auth_requests_pkey PRIMARY KEY (id);


--
-- Name: email_events email_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_pkey PRIMARY KEY (id);


--
-- Name: emails emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_pkey PRIMARY KEY (id);


--
-- Name: eval_run_jobs eval_run_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_run_jobs
    ADD CONSTRAINT eval_run_jobs_pkey PRIMARY KEY (id);


--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);


--
-- Name: event_agent_scheduled_sends event_agent_scheduled_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_agent_scheduled_sends
    ADD CONSTRAINT event_agent_scheduled_sends_pkey PRIMARY KEY (id);


--
-- Name: form_submissions form_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_pkey PRIMARY KEY (id);


--
-- Name: generated_blocks generated_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_blocks
    ADD CONSTRAINT generated_blocks_pkey PRIMARY KEY (id);


--
-- Name: intake_forms intake_forms_org_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_forms
    ADD CONSTRAINT intake_forms_org_slug_unique UNIQUE (org_id, slug);


--
-- Name: intake_forms intake_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_forms
    ADD CONSTRAINT intake_forms_pkey PRIMARY KEY (id);


--
-- Name: intake_submissions intake_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_submissions
    ADD CONSTRAINT intake_submissions_pkey PRIMARY KEY (id);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: landing_pages landing_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_pages
    ADD CONSTRAINT landing_pages_pkey PRIMARY KEY (id);


--
-- Name: landing_payload_versions landing_payload_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_payload_versions
    ADD CONSTRAINT landing_payload_versions_pkey PRIMARY KEY (id);


--
-- Name: marketplace_blocks marketplace_blocks_block_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_blocks
    ADD CONSTRAINT marketplace_blocks_block_id_unique UNIQUE (block_id);


--
-- Name: marketplace_blocks marketplace_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_blocks
    ADD CONSTRAINT marketplace_blocks_pkey PRIMARY KEY (id);


--
-- Name: marketplace_listings marketplace_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_listings
    ADD CONSTRAINT marketplace_listings_pkey PRIMARY KEY (id);


--
-- Name: marketplace_listings marketplace_listings_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_listings
    ADD CONSTRAINT marketplace_listings_slug_unique UNIQUE (slug);


--
-- Name: marketplace_purchases marketplace_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_purchases
    ADD CONSTRAINT marketplace_purchases_pkey PRIMARY KEY (id);


--
-- Name: marketplace_reviews marketplace_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reviews
    ADD CONSTRAINT marketplace_reviews_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);


--
-- Name: message_trigger_fires message_trigger_fires_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_trigger_fires
    ADD CONSTRAINT message_trigger_fires_pkey PRIMARY KEY (id);


--
-- Name: message_triggers message_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_triggers
    ADD CONSTRAINT message_triggers_pkey PRIMARY KEY (id);


--
-- Name: metrics_snapshots metrics_snapshots_org_date_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_snapshots
    ADD CONSTRAINT metrics_snapshots_org_date_unique UNIQUE (org_id, date);


--
-- Name: metrics_snapshots metrics_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_snapshots
    ADD CONSTRAINT metrics_snapshots_pkey PRIMARY KEY (id);


--
-- Name: oauth_authorization_codes oauth_authorization_codes_code_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_code_hash_unique UNIQUE (code_hash);


--
-- Name: oauth_authorization_codes oauth_authorization_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_client_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_client_id_unique UNIQUE (client_id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: onboarding_links onboarding_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_links
    ADD CONSTRAINT onboarding_links_pkey PRIMARY KEY (id);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_unique UNIQUE (slug);


--
-- Name: outbound_message_sends outbound_message_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_message_sends
    ADD CONSTRAINT outbound_message_sends_pkey PRIMARY KEY (id);


--
-- Name: outbound_message_triggers outbound_message_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_message_triggers
    ADD CONSTRAINT outbound_message_triggers_pkey PRIMARY KEY (id);


--
-- Name: outbound_scheduled_sends outbound_scheduled_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_scheduled_sends
    ADD CONSTRAINT outbound_scheduled_sends_pkey PRIMARY KEY (id);


--
-- Name: partner_agencies partner_agencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_agencies
    ADD CONSTRAINT partner_agencies_pkey PRIMARY KEY (id);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);


--
-- Name: payment_records payment_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_records
    ADD CONSTRAINT payment_records_pkey PRIMARY KEY (id);


--
-- Name: personality_cache personality_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personality_cache
    ADD CONSTRAINT personality_cache_pkey PRIMARY KEY (id);


--
-- Name: pipelines pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipelines
    ADD CONSTRAINT pipelines_pkey PRIMARY KEY (id);


--
-- Name: portal_access_codes portal_access_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_codes
    ADD CONSTRAINT portal_access_codes_pkey PRIMARY KEY (id);


--
-- Name: portal_documents portal_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_documents
    ADD CONSTRAINT portal_documents_pkey PRIMARY KEY (id);


--
-- Name: portal_messages portal_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_messages
    ADD CONSTRAINT portal_messages_pkey PRIMARY KEY (id);


--
-- Name: portal_resources portal_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_resources
    ADD CONSTRAINT portal_resources_pkey PRIMARY KEY (id);


--
-- Name: preview_sessions preview_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preview_sessions
    ADD CONSTRAINT preview_sessions_pkey PRIMARY KEY (id);


--
-- Name: proposal_events proposal_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposal_events
    ADD CONSTRAINT proposal_events_pkey PRIMARY KEY (id);


--
-- Name: proposals proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_pkey PRIMARY KEY (id);


--
-- Name: proposals proposals_signed_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_signed_token_unique UNIQUE (signed_token);


--
-- Name: recording_sessions recording_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_sessions
    ADD CONSTRAINT recording_sessions_pkey PRIMARY KEY (id);


--
-- Name: recording_sessions recording_sessions_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_sessions
    ADD CONSTRAINT recording_sessions_token_hash_unique UNIQUE (token_hash);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: replay_send_claims replay_send_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_send_claims
    ADD CONSTRAINT replay_send_claims_pkey PRIMARY KEY (id);


--
-- Name: replay_skills replay_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_skills
    ADD CONSTRAINT replay_skills_pkey PRIMARY KEY (id);


--
-- Name: scheduled_trigger_fires scheduled_trigger_fires_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_trigger_fires
    ADD CONSTRAINT scheduled_trigger_fires_pkey PRIMARY KEY (id);


--
-- Name: scheduled_triggers scheduled_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_triggers
    ADD CONSTRAINT scheduled_triggers_pkey PRIMARY KEY (id);


--
-- Name: seldon_patterns seldon_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldon_patterns
    ADD CONSTRAINT seldon_patterns_pkey PRIMARY KEY (id);


--
-- Name: seldon_sessions seldon_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldon_sessions
    ADD CONSTRAINT seldon_sessions_pkey PRIMARY KEY (id);


--
-- Name: seldon_usage seldon_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldon_usage
    ADD CONSTRAINT seldon_usage_pkey PRIMARY KEY (id);


--
-- Name: seldonframe_events seldonframe_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldonframe_events
    ADD CONSTRAINT seldonframe_events_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (session_token);


--
-- Name: share_cards share_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_cards
    ADD CONSTRAINT share_cards_pkey PRIMARY KEY (id);


--
-- Name: sms_events sms_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_events
    ADD CONSTRAINT sms_events_pkey PRIMARY KEY (id);


--
-- Name: sms_messages sms_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_pkey PRIMARY KEY (id);


--
-- Name: soul_sources soul_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soul_sources
    ADD CONSTRAINT soul_sources_pkey PRIMARY KEY (id);


--
-- Name: soul_wiki soul_wiki_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soul_wiki
    ADD CONSTRAINT soul_wiki_pkey PRIMARY KEY (id);


--
-- Name: stripe_connections stripe_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_connections
    ADD CONSTRAINT stripe_connections_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: supervised_runs supervised_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervised_runs
    ADD CONSTRAINT supervised_runs_pkey PRIMARY KEY (id);


--
-- Name: suppression_list suppression_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_pkey PRIMARY KEY (id);


--
-- Name: url_extraction_cache url_extraction_cache_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.url_extraction_cache
    ADD CONSTRAINT url_extraction_cache_pk PRIMARY KEY (url_hash, kind);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verification_tokens verification_tokens_identifier_token_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_identifier_token_pk PRIMARY KEY (identifier, token);


--
-- Name: wallet_accounts wallet_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_accounts
    ADD CONSTRAINT wallet_accounts_pkey PRIMARY KEY (id);


--
-- Name: wallet_transactions wallet_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);


--
-- Name: webhook_endpoints webhook_endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);


--
-- Name: workflow_approvals workflow_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_approvals
    ADD CONSTRAINT workflow_approvals_pkey PRIMARY KEY (id);


--
-- Name: workflow_event_log workflow_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_event_log
    ADD CONSTRAINT workflow_event_log_pkey PRIMARY KEY (id);


--
-- Name: workflow_recordings workflow_recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_recordings
    ADD CONSTRAINT workflow_recordings_pkey PRIMARY KEY (id);


--
-- Name: workflow_runs workflow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);


--
-- Name: workflow_step_results workflow_step_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_step_results
    ADD CONSTRAINT workflow_step_results_pkey PRIMARY KEY (id);


--
-- Name: workflow_waits workflow_waits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_waits
    ADD CONSTRAINT workflow_waits_pkey PRIMARY KEY (id);


--
-- Name: workspace_agents workspace_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_agents
    ADD CONSTRAINT workspace_agents_pkey PRIMARY KEY (id);


--
-- Name: workspace_collections workspace_collections_org_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_collections
    ADD CONSTRAINT workspace_collections_org_slug_unique UNIQUE (organization_id, slug);


--
-- Name: workspace_collections workspace_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_collections
    ADD CONSTRAINT workspace_collections_pkey PRIMARY KEY (id);


--
-- Name: workspace_domains workspace_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_domains
    ADD CONSTRAINT workspace_domains_pkey PRIMARY KEY (id);


--
-- Name: workspace_pages workspace_pages_org_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_pages
    ADD CONSTRAINT workspace_pages_org_slug_unique UNIQUE (organization_id, slug);


--
-- Name: workspace_pages workspace_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_pages
    ADD CONSTRAINT workspace_pages_pkey PRIMARY KEY (id);


--
-- Name: workspace_records workspace_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_records
    ADD CONSTRAINT workspace_records_pkey PRIMARY KEY (id);


--
-- Name: workspace_secrets workspace_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_pkey PRIMARY KEY (id);


--
-- Name: workspace_sidebar_items workspace_sidebar_items_org_href_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sidebar_items
    ADD CONSTRAINT workspace_sidebar_items_org_href_unique UNIQUE (organization_id, href);


--
-- Name: workspace_sidebar_items workspace_sidebar_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sidebar_items
    ADD CONSTRAINT workspace_sidebar_items_pkey PRIMARY KEY (id);


--
-- Name: acp_sessions_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acp_sessions_idempotency_idx ON public.acp_checkout_sessions USING btree (idempotency_key);


--
-- Name: acp_sessions_seller_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX acp_sessions_seller_idx ON public.acp_checkout_sessions USING btree (seller_org_id);


--
-- Name: activities_org_contact_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_org_contact_created_idx ON public.activities USING btree (org_id, contact_id, created_at DESC);


--
-- Name: activities_org_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_org_type_idx ON public.activities USING btree (org_id, type);


--
-- Name: agency_support_sessions_agency_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agency_support_sessions_agency_started_idx ON public.agency_support_sessions USING btree (agency_id, started_at);


--
-- Name: agency_support_sessions_origin_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agency_support_sessions_origin_user_idx ON public.agency_support_sessions USING btree (origin_user_id, started_at);


--
-- Name: agency_support_sessions_workspace_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agency_support_sessions_workspace_started_idx ON public.agency_support_sessions USING btree (workspace_id, started_at);


--
-- Name: agent_action_drafts_org_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_action_drafts_org_agent_idx ON public.agent_action_drafts USING btree (org_id, agent_id);


--
-- Name: agent_action_drafts_org_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_action_drafts_org_status_created_idx ON public.agent_action_drafts USING btree (org_id, status, created_at);


--
-- Name: agent_action_drafts_pending_step_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_action_drafts_pending_step_uniq ON public.agent_action_drafts USING btree (org_id, conversation_id, step_action) WHERE (status = 'pending'::text);


--
-- Name: agent_conversations_agent_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversations_agent_started_idx ON public.agent_conversations USING btree (agent_id, started_at);


--
-- Name: agent_conversations_anon_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversations_anon_session_idx ON public.agent_conversations USING btree (anonymous_session_id) WHERE (anonymous_session_id IS NOT NULL);


--
-- Name: agent_conversations_org_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversations_org_started_idx ON public.agent_conversations USING btree (org_id, started_at);


--
-- Name: agent_evals_agent_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_evals_agent_version_idx ON public.agent_evals USING btree (agent_id, agent_version, ran_at);


--
-- Name: agent_run_receipts_deployment_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_run_receipts_deployment_created_idx ON public.agent_run_receipts USING btree (deployment_id, created_at);


--
-- Name: agent_run_receipts_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_run_receipts_org_created_idx ON public.agent_run_receipts USING btree (org_id, created_at);


--
-- Name: agent_templates_builder_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_templates_builder_org_idx ON public.agent_templates USING btree (builder_org_id);


--
-- Name: agent_templates_builder_slug_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_templates_builder_slug_uniq ON public.agent_templates USING btree (builder_org_id, lower(slug));


--
-- Name: agent_turns_conv_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_turns_conv_created_idx ON public.agent_turns USING btree (conversation_id, created_at);


--
-- Name: agent_turns_conv_index_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_turns_conv_index_uniq ON public.agent_turns USING btree (conversation_id, turn_index);


--
-- Name: agent_versions_agent_version_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_versions_agent_version_uniq ON public.agent_versions USING btree (agent_id, version);


--
-- Name: agent_workflow_traces_org_deployment_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_workflow_traces_org_deployment_created_idx ON public.agent_workflow_traces USING btree (org_id, deployment_id, created_at);


--
-- Name: agents_org_slug_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agents_org_slug_uniq ON public.agents USING btree (org_id, lower(slug));


--
-- Name: agents_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_org_status_idx ON public.agents USING btree (org_id, status);


--
-- Name: api_keys_kind_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_kind_prefix_idx ON public.api_keys USING btree (kind, key_prefix);


--
-- Name: api_keys_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_org_idx ON public.api_keys USING btree (org_id);


--
-- Name: block_instances_org_block_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX block_instances_org_block_uniq ON public.block_instances USING btree (org_id, block_name);


--
-- Name: block_instances_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_instances_org_idx ON public.block_instances USING btree (org_id);


--
-- Name: block_purchases_org_block_payment_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX block_purchases_org_block_payment_uidx ON public.block_purchases USING btree (org_id, block_id, stripe_payment_id);


--
-- Name: block_purchases_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_purchases_org_idx ON public.block_purchases USING btree (org_id);


--
-- Name: block_ratings_block_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_ratings_block_idx ON public.block_ratings USING btree (block_id);


--
-- Name: block_ratings_block_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX block_ratings_block_user_uidx ON public.block_ratings USING btree (block_id, user_id);


--
-- Name: block_subscription_deliveries_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_subscription_deliveries_event_idx ON public.block_subscription_deliveries USING btree (event_log_id);


--
-- Name: block_subscription_deliveries_status_next_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_subscription_deliveries_status_next_idx ON public.block_subscription_deliveries USING btree (status, next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: block_subscription_deliveries_sub_idem_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX block_subscription_deliveries_sub_idem_uidx ON public.block_subscription_deliveries USING btree (subscription_id, idempotency_key);


--
-- Name: block_subscription_deliveries_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_subscription_deliveries_sub_idx ON public.block_subscription_deliveries USING btree (subscription_id);


--
-- Name: block_subscription_registry_org_block_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_subscription_registry_org_block_idx ON public.block_subscription_registry USING btree (org_id, block_slug);


--
-- Name: block_subscription_registry_org_event_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_subscription_registry_org_event_active_idx ON public.block_subscription_registry USING btree (org_id, event_type) WHERE (active = true);


--
-- Name: bookings_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_org_contact_idx ON public.bookings USING btree (org_id, contact_id);


--
-- Name: bookings_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_org_created_idx ON public.bookings USING btree (org_id, created_at DESC);


--
-- Name: bookings_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_org_slug_idx ON public.bookings USING btree (org_id, booking_slug);


--
-- Name: bookings_org_starts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_org_starts_idx ON public.bookings USING btree (org_id, starts_at);


--
-- Name: brain_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_events_type_idx ON public.brain_events USING btree (event_type);


--
-- Name: brain_events_workspace_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_events_workspace_timestamp_idx ON public.brain_events USING btree (workspace_id, "timestamp");


--
-- Name: brain_notes_global_path_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX brain_notes_global_path_uniq ON public.brain_notes USING btree (path) WHERE (org_id IS NULL);


--
-- Name: brain_notes_org_path_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX brain_notes_org_path_uniq ON public.brain_notes USING btree (org_id, path) WHERE (org_id IS NOT NULL);


--
-- Name: brain_notes_org_scope_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_notes_org_scope_path_idx ON public.brain_notes USING btree (org_id, scope, path);


--
-- Name: builder_llm_keys_org_provider_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX builder_llm_keys_org_provider_uniq ON public.builder_llm_keys USING btree (builder_org_id, provider);


--
-- Name: change_plans_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_plans_org_idx ON public.change_plans USING btree (org_id);


--
-- Name: contacts_org_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_org_assigned_to_idx ON public.contacts USING btree (org_id, assigned_to);


--
-- Name: contacts_org_lower_email_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_org_lower_email_uniq ON public.contacts USING btree (org_id, lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text));


--
-- Name: contacts_org_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_org_score_idx ON public.contacts USING btree (org_id, score DESC);


--
-- Name: contacts_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_org_status_idx ON public.contacts USING btree (org_id, status);


--
-- Name: conversation_notes_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_notes_org_contact_idx ON public.conversation_notes USING btree (org_id, contact_id);


--
-- Name: conversation_notes_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_notes_org_created_idx ON public.conversation_notes USING btree (org_id, created_at);


--
-- Name: conversation_turns_org_conv_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_turns_org_conv_created_idx ON public.conversation_turns USING btree (org_id, conversation_id, created_at);


--
-- Name: conversation_turns_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_turns_org_created_idx ON public.conversation_turns USING btree (org_id, created_at DESC);


--
-- Name: conversations_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_org_contact_idx ON public.conversations USING btree (org_id, contact_id);


--
-- Name: conversations_org_status_last_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_org_status_last_turn_idx ON public.conversations USING btree (org_id, status, last_turn_at DESC);


--
-- Name: deals_org_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_org_assigned_to_idx ON public.deals USING btree (org_id, assigned_to);


--
-- Name: deals_org_pipeline_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_org_pipeline_stage_idx ON public.deals USING btree (org_id, pipeline_id, stage);


--
-- Name: deployments_builder_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployments_builder_status_idx ON public.deployments USING btree (builder_org_id, status);


--
-- Name: deployments_phone_number_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deployments_phone_number_uniq ON public.deployments USING btree (phone_number) WHERE (phone_number IS NOT NULL);


--
-- Name: device_auth_requests_atok_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_auth_requests_atok_uniq ON public.device_auth_requests USING btree (atok);


--
-- Name: device_auth_requests_status_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_auth_requests_status_expires_idx ON public.device_auth_requests USING btree (status, expires_at);


--
-- Name: device_auth_requests_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_auth_requests_workspace_idx ON public.device_auth_requests USING btree (workspace_id, created_at);


--
-- Name: email_events_org_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_events_org_email_idx ON public.email_events USING btree (org_id, email_id, created_at DESC);


--
-- Name: email_events_org_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_events_org_type_idx ON public.email_events USING btree (org_id, event_type, created_at DESC);


--
-- Name: email_events_provider_event_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_events_provider_event_uidx ON public.email_events USING btree (provider, provider_event_id);


--
-- Name: emails_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emails_org_contact_idx ON public.emails USING btree (org_id, contact_id);


--
-- Name: emails_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emails_org_created_idx ON public.emails USING btree (org_id, created_at DESC);


--
-- Name: emails_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emails_org_status_idx ON public.emails USING btree (org_id, status);


--
-- Name: eval_run_jobs_org_template_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eval_run_jobs_org_template_started_idx ON public.eval_run_jobs USING btree (org_id, template_id, started_at);


--
-- Name: event_agent_scheduled_sends_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_agent_scheduled_sends_due_idx ON public.event_agent_scheduled_sends USING btree (due_at) WHERE (status = 'pending'::text);


--
-- Name: event_agent_scheduled_sends_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_agent_scheduled_sends_org_idx ON public.event_agent_scheduled_sends USING btree (org_id, status);


--
-- Name: generated_blocks_block_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX generated_blocks_block_uidx ON public.generated_blocks USING btree (block_id);


--
-- Name: generated_blocks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generated_blocks_status_idx ON public.generated_blocks USING btree (status);


--
-- Name: idx_agent_reflection_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_reflection_events_created ON public.agent_reflection_events USING btree (created_at);


--
-- Name: idx_agent_reflection_events_pass_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_reflection_events_pass_created ON public.agent_reflection_events USING btree (pass, created_at);


--
-- Name: idx_agent_taste_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_taste_sessions_expires_at ON public.agent_taste_sessions USING btree (expires_at);


--
-- Name: idx_brain_outcomes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_outcomes_org ON public.brain_outcomes USING btree (org_id, created_at DESC);


--
-- Name: idx_brain_outcomes_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_outcomes_outcome ON public.brain_outcomes USING btree (outcome, created_at DESC);


--
-- Name: idx_brain_outcomes_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_outcomes_vertical ON public.brain_outcomes USING btree (vertical, event_type, created_at DESC);


--
-- Name: idx_eval_runs_subject_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eval_runs_subject_created ON public.eval_runs USING btree (subject_kind, subject_id, created_at);


--
-- Name: idx_improve_proposals_agent_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_improve_proposals_agent_status ON public.agent_improve_proposals USING btree (agent_id, status);


--
-- Name: idx_marketplace_featured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_featured ON public.marketplace_listings USING btree (is_featured, install_count) WHERE (is_published = true);


--
-- Name: idx_marketplace_niche; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_niche ON public.marketplace_listings USING btree (niche) WHERE (is_published = true);


--
-- Name: idx_marketplace_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_slug ON public.marketplace_listings USING btree (slug);


--
-- Name: idx_preview_sessions_claimed_by_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preview_sessions_claimed_by_org ON public.preview_sessions USING btree (claimed_by_org_id);


--
-- Name: idx_preview_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preview_sessions_expires_at ON public.preview_sessions USING btree (expires_at);


--
-- Name: idx_preview_sessions_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_preview_sessions_token_unique ON public.preview_sessions USING btree (token);


--
-- Name: idx_reviews_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_listing ON public.marketplace_reviews USING btree (listing_id);


--
-- Name: idx_seldon_patterns_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seldon_patterns_confidence ON public.seldon_patterns USING btree (confidence);


--
-- Name: idx_seldon_patterns_framework_block; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seldon_patterns_framework_block ON public.seldon_patterns USING btree (framework_type, block_type);


--
-- Name: idx_sf_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_events_created ON public.seldonframe_events USING btree (created_at DESC);


--
-- Name: idx_sf_events_event_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_events_event_time ON public.seldonframe_events USING btree (event, created_at DESC);


--
-- Name: idx_sf_events_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_events_org ON public.seldonframe_events USING btree (org_id, created_at DESC);


--
-- Name: idx_soul_sources_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_soul_sources_org ON public.soul_sources USING btree (org_id);


--
-- Name: idx_soul_wiki_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_soul_wiki_org ON public.soul_wiki USING btree (org_id);


--
-- Name: idx_soul_wiki_org_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_soul_wiki_org_category ON public.soul_wiki USING btree (org_id, category);


--
-- Name: idx_soul_wiki_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_soul_wiki_org_slug ON public.soul_wiki USING btree (org_id, slug);


--
-- Name: idx_soul_wiki_org_slug_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_soul_wiki_org_slug_unique ON public.soul_wiki USING btree (org_id, slug);


--
-- Name: idx_workspace_agents_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_agents_org_status ON public.workspace_agents USING btree (organization_id, status);


--
-- Name: idx_workspace_collections_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_collections_org ON public.workspace_collections USING btree (organization_id);


--
-- Name: idx_workspace_pages_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_pages_org ON public.workspace_pages USING btree (organization_id);


--
-- Name: idx_workspace_pages_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_pages_visibility ON public.workspace_pages USING btree (organization_id, visibility);


--
-- Name: idx_workspace_records_collection_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_records_collection_created ON public.workspace_records USING btree (collection_id, created_at DESC);


--
-- Name: idx_workspace_records_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_records_contact ON public.workspace_records USING btree (contact_id);


--
-- Name: idx_workspace_records_org_collection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_records_org_collection ON public.workspace_records USING btree (organization_id, collection_id);


--
-- Name: idx_workspace_records_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_records_status ON public.workspace_records USING btree (collection_id, status);


--
-- Name: idx_workspace_sidebar_items_org_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_sidebar_items_org_order ON public.workspace_sidebar_items USING btree (organization_id, sort_order);


--
-- Name: intake_submissions_org_form_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intake_submissions_org_form_idx ON public.intake_submissions USING btree (org_id, form_id);


--
-- Name: invoice_items_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoice_items_invoice_idx ON public.invoice_items USING btree (invoice_id);


--
-- Name: invoices_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_org_contact_idx ON public.invoices USING btree (org_id, contact_id);


--
-- Name: invoices_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_org_created_idx ON public.invoices USING btree (org_id, created_at DESC);


--
-- Name: invoices_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_org_status_idx ON public.invoices USING btree (org_id, status);


--
-- Name: invoices_stripe_invoice_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoices_stripe_invoice_uidx ON public.invoices USING btree (stripe_invoice_id);


--
-- Name: landing_pages_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX landing_pages_org_created_idx ON public.landing_pages USING btree (org_id, created_at DESC);


--
-- Name: landing_pages_org_slug_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX landing_pages_org_slug_uniq ON public.landing_pages USING btree (org_id, slug);


--
-- Name: landing_payload_versions_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX landing_payload_versions_workspace_idx ON public.landing_payload_versions USING btree (workspace_id, created_at);


--
-- Name: marketplace_blocks_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_blocks_category_idx ON public.marketplace_blocks USING btree (category);


--
-- Name: marketplace_blocks_seller_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_blocks_seller_idx ON public.marketplace_blocks USING btree (seller_id);


--
-- Name: marketplace_blocks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_blocks_status_idx ON public.marketplace_blocks USING btree (generation_status);


--
-- Name: marketplace_purchases_buyer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_purchases_buyer_idx ON public.marketplace_purchases USING btree (buyer_org_id, created_at DESC);


--
-- Name: marketplace_purchases_checkout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_purchases_checkout_idx ON public.marketplace_purchases USING btree (stripe_checkout_id);


--
-- Name: marketplace_purchases_seller_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_purchases_seller_idx ON public.marketplace_purchases USING btree (seller_org_id, created_at DESC);


--
-- Name: memberships_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_org_id_idx ON public.memberships USING btree (org_id);


--
-- Name: memberships_org_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_org_user_status_idx ON public.memberships USING btree (org_id, user_id, status);


--
-- Name: memberships_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_user_id_idx ON public.memberships USING btree (user_id);


--
-- Name: message_trigger_fires_trigger_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_trigger_fires_trigger_idx ON public.message_trigger_fires USING btree (trigger_id, fired_at);


--
-- Name: message_trigger_fires_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_trigger_fires_unique_idx ON public.message_trigger_fires USING btree (trigger_id, message_id);


--
-- Name: message_triggers_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_triggers_lookup_idx ON public.message_triggers USING btree (org_id, channel, enabled);


--
-- Name: message_triggers_org_archetype_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_triggers_org_archetype_idx ON public.message_triggers USING btree (org_id, archetype_id);


--
-- Name: metrics_snapshots_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrics_snapshots_org_created_idx ON public.metrics_snapshots USING btree (org_id, created_at);


--
-- Name: metrics_snapshots_org_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrics_snapshots_org_date_idx ON public.metrics_snapshots USING btree (org_id, date);


--
-- Name: oauth_auth_codes_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_auth_codes_client_id_idx ON public.oauth_authorization_codes USING btree (client_id);


--
-- Name: oauth_auth_codes_code_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_auth_codes_code_hash_idx ON public.oauth_authorization_codes USING btree (code_hash);


--
-- Name: oauth_clients_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_clients_client_id_idx ON public.oauth_clients USING btree (client_id);


--
-- Name: oauth_refresh_tokens_family_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_refresh_tokens_family_id_idx ON public.oauth_refresh_tokens USING btree (family_id);


--
-- Name: oauth_refresh_tokens_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_refresh_tokens_token_hash_idx ON public.oauth_refresh_tokens USING btree (token_hash);


--
-- Name: onboarding_links_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX onboarding_links_token_idx ON public.onboarding_links USING btree (token);


--
-- Name: org_members_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_members_org_id_idx ON public.org_members USING btree (org_id);


--
-- Name: org_members_org_user_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_members_org_user_unique_idx ON public.org_members USING btree (org_id, user_id);


--
-- Name: org_members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_members_user_id_idx ON public.org_members USING btree (user_id);


--
-- Name: outbound_msg_sends_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_msg_sends_contact_idx ON public.outbound_message_sends USING btree (contact_id);


--
-- Name: outbound_msg_sends_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_msg_sends_org_created_idx ON public.outbound_message_sends USING btree (org_id, created_at);


--
-- Name: outbound_msg_sends_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_msg_sends_status_idx ON public.outbound_message_sends USING btree (org_id, status);


--
-- Name: outbound_msg_sends_trigger_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_msg_sends_trigger_idx ON public.outbound_message_sends USING btree (trigger_id);


--
-- Name: outbound_msg_triggers_org_event_channel_skill_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outbound_msg_triggers_org_event_channel_skill_uniq ON public.outbound_message_triggers USING btree (org_id, event_type, channel, skill_id);


--
-- Name: outbound_msg_triggers_org_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_msg_triggers_org_event_idx ON public.outbound_message_triggers USING btree (org_id, event_type);


--
-- Name: outbound_scheduled_sends_cancel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_scheduled_sends_cancel_idx ON public.outbound_scheduled_sends USING btree (org_id, event_type, status);


--
-- Name: outbound_scheduled_sends_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_scheduled_sends_due_idx ON public.outbound_scheduled_sends USING btree (fire_at) WHERE (status = 'pending'::text);


--
-- Name: outbound_scheduled_sends_trigger_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_scheduled_sends_trigger_idx ON public.outbound_scheduled_sends USING btree (trigger_id);


--
-- Name: partner_agencies_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_agencies_owner_idx ON public.partner_agencies USING btree (owner_user_id, status);


--
-- Name: partner_agencies_slug_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX partner_agencies_slug_uniq ON public.partner_agencies USING btree (slug);


--
-- Name: payment_events_org_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_events_org_target_idx ON public.payment_events USING btree (org_id, target_type, target_id, created_at DESC);


--
-- Name: payment_events_org_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_events_org_type_idx ON public.payment_events USING btree (org_id, event_type, created_at DESC);


--
-- Name: payment_events_provider_event_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_events_provider_event_uidx ON public.payment_events USING btree (provider, provider_event_id);


--
-- Name: payment_records_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_records_org_contact_idx ON public.payment_records USING btree (org_id, contact_id);


--
-- Name: payment_records_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_records_org_status_idx ON public.payment_records USING btree (org_id, status);


--
-- Name: personality_cache_business_type_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personality_cache_business_type_key_uidx ON public.personality_cache USING btree (business_type_key);


--
-- Name: pipelines_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipelines_org_idx ON public.pipelines USING btree (org_id);


--
-- Name: portal_access_codes_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_access_codes_org_contact_idx ON public.portal_access_codes USING btree (org_id, contact_id);


--
-- Name: portal_documents_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_documents_org_contact_idx ON public.portal_documents USING btree (org_id, contact_id);


--
-- Name: portal_documents_uploader_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_documents_uploader_idx ON public.portal_documents USING btree (uploaded_by_user_id);


--
-- Name: portal_messages_org_contact_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_messages_org_contact_created_idx ON public.portal_messages USING btree (org_id, contact_id, created_at DESC);


--
-- Name: portal_messages_org_contact_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_messages_org_contact_read_idx ON public.portal_messages USING btree (org_id, contact_id, read_at);


--
-- Name: portal_resources_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_resources_org_contact_idx ON public.portal_resources USING btree (org_id, contact_id);


--
-- Name: proposal_events_proposal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposal_events_proposal_idx ON public.proposal_events USING btree (proposal_id, created_at);


--
-- Name: proposals_agency_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposals_agency_status_idx ON public.proposals USING btree (agency_org_id, status, created_at);


--
-- Name: proposals_checkout_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposals_checkout_session_idx ON public.proposals USING btree (stripe_checkout_session_id) WHERE (stripe_checkout_session_id IS NOT NULL);


--
-- Name: proposals_signed_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposals_signed_token_idx ON public.proposals USING btree (signed_token);


--
-- Name: recording_sessions_ip_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recording_sessions_ip_created_idx ON public.recording_sessions USING btree (ip_hash, created_at);


--
-- Name: referrals_referee_org_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX referrals_referee_org_uniq ON public.referrals USING btree (referee_org_id);


--
-- Name: referrals_referrer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referrals_referrer_idx ON public.referrals USING btree (referrer_org_id);


--
-- Name: replay_send_claims_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replay_send_claims_org_idx ON public.replay_send_claims USING btree (org_id);


--
-- Name: replay_send_claims_skill_step_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX replay_send_claims_skill_step_key_idx ON public.replay_send_claims USING btree (skill_id, step_n, idempotency_key);


--
-- Name: replay_skills_one_enabled_per_deployment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX replay_skills_one_enabled_per_deployment_idx ON public.replay_skills USING btree (deployment_id) WHERE (status = 'enabled'::text);


--
-- Name: replay_skills_org_deployment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replay_skills_org_deployment_idx ON public.replay_skills USING btree (org_id, deployment_id);


--
-- Name: scheduled_trigger_fires_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scheduled_trigger_fires_unique_idx ON public.scheduled_trigger_fires USING btree (scheduled_trigger_id, fire_time_utc);


--
-- Name: scheduled_triggers_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_triggers_due_idx ON public.scheduled_triggers USING btree (next_fire_at);


--
-- Name: scheduled_triggers_org_archetype_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scheduled_triggers_org_archetype_idx ON public.scheduled_triggers USING btree (org_id, archetype_id);


--
-- Name: seldon_sessions_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seldon_sessions_org_created_idx ON public.seldon_sessions USING btree (org_id, created_at);


--
-- Name: seldon_usage_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seldon_usage_org_created_idx ON public.seldon_usage USING btree (org_id, created_at);


--
-- Name: seldon_usage_org_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seldon_usage_org_mode_idx ON public.seldon_usage USING btree (org_id, mode);


--
-- Name: seldon_usage_org_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seldon_usage_org_user_idx ON public.seldon_usage USING btree (org_id, user_id);


--
-- Name: share_cards_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX share_cards_slug_idx ON public.share_cards USING btree (slug);


--
-- Name: sms_events_org_msg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_events_org_msg_idx ON public.sms_events USING btree (org_id, sms_message_id, created_at DESC);


--
-- Name: sms_events_org_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_events_org_type_idx ON public.sms_events USING btree (org_id, event_type, created_at DESC);


--
-- Name: sms_events_provider_event_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sms_events_provider_event_uidx ON public.sms_events USING btree (provider, provider_event_id);


--
-- Name: sms_messages_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_messages_org_contact_idx ON public.sms_messages USING btree (org_id, contact_id);


--
-- Name: sms_messages_org_contact_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_messages_org_contact_read_idx ON public.sms_messages USING btree (org_id, contact_id, read_at);


--
-- Name: sms_messages_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_messages_org_created_idx ON public.sms_messages USING btree (org_id, created_at DESC);


--
-- Name: sms_messages_org_direction_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_messages_org_direction_idx ON public.sms_messages USING btree (org_id, direction);


--
-- Name: sms_messages_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_messages_org_status_idx ON public.sms_messages USING btree (org_id, status);


--
-- Name: stripe_connections_org_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stripe_connections_org_active_idx ON public.stripe_connections USING btree (org_id, is_active);


--
-- Name: subscriptions_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_org_contact_idx ON public.subscriptions USING btree (org_id, contact_id);


--
-- Name: subscriptions_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_org_created_idx ON public.subscriptions USING btree (org_id, created_at DESC);


--
-- Name: subscriptions_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_org_status_idx ON public.subscriptions USING btree (org_id, status);


--
-- Name: subscriptions_stripe_sub_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_stripe_sub_uidx ON public.subscriptions USING btree (stripe_subscription_id);


--
-- Name: supervised_runs_org_template_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supervised_runs_org_template_started_idx ON public.supervised_runs USING btree (org_id, template_id, started_at);


--
-- Name: suppression_list_org_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX suppression_list_org_channel_idx ON public.suppression_list USING btree (org_id, channel);


--
-- Name: suppression_list_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX suppression_list_org_created_idx ON public.suppression_list USING btree (org_id, created_at DESC);


--
-- Name: suppression_list_org_email_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX suppression_list_org_email_uidx ON public.suppression_list USING btree (org_id, email);


--
-- Name: suppression_list_org_phone_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX suppression_list_org_phone_uidx ON public.suppression_list USING btree (org_id, phone);


--
-- Name: users_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_org_id_idx ON public.users USING btree (org_id);


--
-- Name: wallet_accounts_org_mode_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_accounts_org_mode_uniq ON public.wallet_accounts USING btree (org_id, stripe_mode);


--
-- Name: wallet_transactions_idempotency_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_transactions_idempotency_uniq ON public.wallet_transactions USING btree (idempotency_key);


--
-- Name: wallet_transactions_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_transactions_org_idx ON public.wallet_transactions USING btree (org_id, created_at DESC);


--
-- Name: webhook_endpoints_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_endpoints_org_idx ON public.webhook_endpoints USING btree (org_id);


--
-- Name: workflow_approvals_magic_link_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_approvals_magic_link_idx ON public.workflow_approvals USING btree (magic_link_token_hash) WHERE (magic_link_token_hash IS NOT NULL);


--
-- Name: workflow_approvals_org_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_approvals_org_pending_idx ON public.workflow_approvals USING btree (org_id) WHERE (status = 'pending'::text);


--
-- Name: workflow_approvals_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_approvals_run_idx ON public.workflow_approvals USING btree (run_id);


--
-- Name: workflow_approvals_timeout_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_approvals_timeout_pending_idx ON public.workflow_approvals USING btree (timeout_at) WHERE ((status = 'pending'::text) AND (timeout_at IS NOT NULL));


--
-- Name: workflow_approvals_user_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_approvals_user_pending_idx ON public.workflow_approvals USING btree (approver_user_id) WHERE ((status = 'pending'::text) AND (approver_user_id IS NOT NULL));


--
-- Name: workflow_event_log_emitted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_event_log_emitted_idx ON public.workflow_event_log USING btree (emitted_at DESC);


--
-- Name: workflow_event_log_org_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_event_log_org_type_idx ON public.workflow_event_log USING btree (org_id, event_type, emitted_at DESC);


--
-- Name: workflow_recordings_session_slot_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_recordings_session_slot_uniq ON public.workflow_recordings USING btree (session_id, slot_index);


--
-- Name: workflow_runs_archetype_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_runs_archetype_idx ON public.workflow_runs USING btree (org_id, archetype_id);


--
-- Name: workflow_runs_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_runs_org_created_idx ON public.workflow_runs USING btree (org_id, created_at DESC);


--
-- Name: workflow_runs_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_runs_org_status_idx ON public.workflow_runs USING btree (org_id, status);


--
-- Name: workflow_step_results_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_step_results_run_idx ON public.workflow_step_results USING btree (run_id, created_at DESC);


--
-- Name: workflow_waits_event_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_waits_event_unresolved_idx ON public.workflow_waits USING btree (event_type) WHERE (resumed_at IS NULL);


--
-- Name: workflow_waits_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_waits_run_idx ON public.workflow_waits USING btree (run_id);


--
-- Name: workflow_waits_timeout_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_waits_timeout_unresolved_idx ON public.workflow_waits USING btree (timeout_at) WHERE (resumed_at IS NULL);


--
-- Name: workspace_domains_active_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_domains_active_lookup_idx ON public.workspace_domains USING btree (hostname) WHERE (status = 'verified'::text);


--
-- Name: workspace_domains_hostname_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_domains_hostname_uniq ON public.workspace_domains USING btree (hostname) WHERE (status <> 'removed'::text);


--
-- Name: workspace_domains_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_domains_workspace_idx ON public.workspace_domains USING btree (workspace_id, created_at);


--
-- Name: workspace_secrets_service_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_secrets_service_idx ON public.workspace_secrets USING btree (service_name);


--
-- Name: workspace_secrets_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_secrets_workspace_idx ON public.workspace_secrets USING btree (workspace_id);


--
-- Name: workspace_secrets_workspace_scope_service_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_secrets_workspace_scope_service_uidx ON public.workspace_secrets USING btree (workspace_id, scope, service_name);


--
-- Name: accounts accounts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: activities activities_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: activities activities_deal_id_deals_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_deal_id_deals_id_fk FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE SET NULL;


--
-- Name: activities activities_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: activities activities_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agency_support_sessions agency_support_sessions_agency_id_partner_agencies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_support_sessions
    ADD CONSTRAINT agency_support_sessions_agency_id_partner_agencies_id_fk FOREIGN KEY (agency_id) REFERENCES public.partner_agencies(id) ON DELETE CASCADE;


--
-- Name: agency_support_sessions agency_support_sessions_origin_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_support_sessions
    ADD CONSTRAINT agency_support_sessions_origin_user_id_users_id_fk FOREIGN KEY (origin_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agency_support_sessions agency_support_sessions_workspace_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_support_sessions
    ADD CONSTRAINT agency_support_sessions_workspace_id_organizations_id_fk FOREIGN KEY (workspace_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_action_drafts agent_action_drafts_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_action_drafts
    ADD CONSTRAINT agent_action_drafts_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_conversations agent_conversations_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_conversations agent_conversations_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: agent_conversations agent_conversations_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_evals agent_evals_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_evals
    ADD CONSTRAINT agent_evals_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_improve_proposals agent_improve_proposals_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_improve_proposals
    ADD CONSTRAINT agent_improve_proposals_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_improve_proposals agent_improve_proposals_baseline_run_id_eval_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_improve_proposals
    ADD CONSTRAINT agent_improve_proposals_baseline_run_id_eval_runs_id_fk FOREIGN KEY (baseline_run_id) REFERENCES public.eval_runs(id);


--
-- Name: agent_improve_proposals agent_improve_proposals_candidate_run_id_eval_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_improve_proposals
    ADD CONSTRAINT agent_improve_proposals_candidate_run_id_eval_runs_id_fk FOREIGN KEY (candidate_run_id) REFERENCES public.eval_runs(id);


--
-- Name: agent_improve_proposals agent_improve_proposals_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_improve_proposals
    ADD CONSTRAINT agent_improve_proposals_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_reflection_events agent_reflection_events_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_reflection_events
    ADD CONSTRAINT agent_reflection_events_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_run_receipts agent_run_receipts_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_receipts
    ADD CONSTRAINT agent_run_receipts_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: agent_run_receipts agent_run_receipts_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_receipts
    ADD CONSTRAINT agent_run_receipts_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_taste_sessions agent_taste_sessions_listing_id_marketplace_listings_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_taste_sessions
    ADD CONSTRAINT agent_taste_sessions_listing_id_marketplace_listings_id_fk FOREIGN KEY (listing_id) REFERENCES public.marketplace_listings(id) ON DELETE CASCADE;


--
-- Name: agent_templates agent_templates_builder_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_builder_org_id_organizations_id_fk FOREIGN KEY (builder_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agent_turns agent_turns_conversation_id_agent_conversations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_turns
    ADD CONSTRAINT agent_turns_conversation_id_agent_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(id) ON DELETE CASCADE;


--
-- Name: agent_versions agent_versions_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_versions agent_versions_published_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_published_by_user_id_users_id_fk FOREIGN KEY (published_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_workflow_traces agent_workflow_traces_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_workflow_traces
    ADD CONSTRAINT agent_workflow_traces_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: agent_workflow_traces agent_workflow_traces_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_workflow_traces
    ADD CONSTRAINT agent_workflow_traces_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: agents agents_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: block_instances block_instances_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_instances
    ADD CONSTRAINT block_instances_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: block_purchases block_purchases_block_id_marketplace_blocks_block_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_purchases
    ADD CONSTRAINT block_purchases_block_id_marketplace_blocks_block_id_fk FOREIGN KEY (block_id) REFERENCES public.marketplace_blocks(block_id) ON DELETE CASCADE;


--
-- Name: block_purchases block_purchases_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_purchases
    ADD CONSTRAINT block_purchases_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: block_purchases block_purchases_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_purchases
    ADD CONSTRAINT block_purchases_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: block_ratings block_ratings_block_id_marketplace_blocks_block_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_ratings
    ADD CONSTRAINT block_ratings_block_id_marketplace_blocks_block_id_fk FOREIGN KEY (block_id) REFERENCES public.marketplace_blocks(block_id) ON DELETE CASCADE;


--
-- Name: block_ratings block_ratings_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_ratings
    ADD CONSTRAINT block_ratings_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: block_ratings block_ratings_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_ratings
    ADD CONSTRAINT block_ratings_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: block_subscription_deliveries block_subscription_deliveries_event_log_id_workflow_event_log_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_subscription_deliveries
    ADD CONSTRAINT block_subscription_deliveries_event_log_id_workflow_event_log_i FOREIGN KEY (event_log_id) REFERENCES public.workflow_event_log(id) ON DELETE CASCADE;


--
-- Name: block_subscription_deliveries block_subscription_deliveries_subscription_id_block_subscriptio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_subscription_deliveries
    ADD CONSTRAINT block_subscription_deliveries_subscription_id_block_subscriptio FOREIGN KEY (subscription_id) REFERENCES public.block_subscription_registry(id) ON DELETE CASCADE;


--
-- Name: block_subscription_registry block_subscription_registry_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_subscription_registry
    ADD CONSTRAINT block_subscription_registry_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: brain_notes brain_notes_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_notes
    ADD CONSTRAINT brain_notes_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: brain_outcomes brain_outcomes_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_outcomes
    ADD CONSTRAINT brain_outcomes_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: builder_llm_keys builder_llm_keys_builder_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_llm_keys
    ADD CONSTRAINT builder_llm_keys_builder_org_id_organizations_id_fk FOREIGN KEY (builder_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: change_plans change_plans_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_plans
    ADD CONSTRAINT change_plans_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_assigned_to_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_assigned_to_users_id_fk FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: conversation_notes conversation_notes_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_notes
    ADD CONSTRAINT conversation_notes_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: conversation_notes conversation_notes_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_notes
    ADD CONSTRAINT conversation_notes_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: conversation_turns conversation_turns_conversation_id_conversations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_turns
    ADD CONSTRAINT conversation_turns_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_turns conversation_turns_email_id_emails_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_turns
    ADD CONSTRAINT conversation_turns_email_id_emails_id_fk FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE SET NULL;


--
-- Name: conversation_turns conversation_turns_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_turns
    ADD CONSTRAINT conversation_turns_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deals deals_assigned_to_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_assigned_to_users_id_fk FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deals deals_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: deals deals_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deals deals_pipeline_id_pipelines_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pipeline_id_pipelines_id_fk FOREIGN KEY (pipeline_id) REFERENCES public.pipelines(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_agent_template_id_agent_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_agent_template_id_agent_templates_id_fk FOREIGN KEY (agent_template_id) REFERENCES public.agent_templates(id) ON DELETE RESTRICT;


--
-- Name: deployments deployments_builder_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_builder_org_id_organizations_id_fk FOREIGN KEY (builder_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_client_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_client_org_id_organizations_id_fk FOREIGN KEY (client_org_id) REFERENCES public.organizations(id);


--
-- Name: device_auth_requests device_auth_requests_workspace_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_auth_requests
    ADD CONSTRAINT device_auth_requests_workspace_id_organizations_id_fk FOREIGN KEY (workspace_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: email_events email_events_email_id_emails_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_email_id_emails_id_fk FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE;


--
-- Name: email_events email_events_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_events
    ADD CONSTRAINT email_events_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: emails emails_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: emails emails_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: emails emails_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: eval_run_jobs eval_run_jobs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_run_jobs
    ADD CONSTRAINT eval_run_jobs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: eval_run_jobs eval_run_jobs_template_id_agent_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_run_jobs
    ADD CONSTRAINT eval_run_jobs_template_id_agent_templates_id_fk FOREIGN KEY (template_id) REFERENCES public.agent_templates(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: event_agent_scheduled_sends event_agent_scheduled_sends_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_agent_scheduled_sends
    ADD CONSTRAINT event_agent_scheduled_sends_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: event_agent_scheduled_sends event_agent_scheduled_sends_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_agent_scheduled_sends
    ADD CONSTRAINT event_agent_scheduled_sends_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: form_submissions form_submissions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: generated_blocks generated_blocks_block_id_marketplace_blocks_block_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_blocks
    ADD CONSTRAINT generated_blocks_block_id_marketplace_blocks_block_id_fk FOREIGN KEY (block_id) REFERENCES public.marketplace_blocks(block_id) ON DELETE CASCADE;


--
-- Name: generated_blocks generated_blocks_seller_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_blocks
    ADD CONSTRAINT generated_blocks_seller_org_id_organizations_id_fk FOREIGN KEY (seller_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: intake_forms intake_forms_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_forms
    ADD CONSTRAINT intake_forms_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: intake_submissions intake_submissions_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_submissions
    ADD CONSTRAINT intake_submissions_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: intake_submissions intake_submissions_form_id_intake_forms_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_submissions
    ADD CONSTRAINT intake_submissions_form_id_intake_forms_id_fk FOREIGN KEY (form_id) REFERENCES public.intake_forms(id) ON DELETE CASCADE;


--
-- Name: intake_submissions intake_submissions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_submissions
    ADD CONSTRAINT intake_submissions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: landing_pages landing_pages_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_pages
    ADD CONSTRAINT landing_pages_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: landing_payload_versions landing_payload_versions_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_payload_versions
    ADD CONSTRAINT landing_payload_versions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: landing_payload_versions landing_payload_versions_workspace_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_payload_versions
    ADD CONSTRAINT landing_payload_versions_workspace_id_organizations_id_fk FOREIGN KEY (workspace_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: marketplace_blocks marketplace_blocks_seller_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_blocks
    ADD CONSTRAINT marketplace_blocks_seller_id_users_id_fk FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: marketplace_listings marketplace_listings_creator_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_listings
    ADD CONSTRAINT marketplace_listings_creator_org_id_organizations_id_fk FOREIGN KEY (creator_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: marketplace_reviews marketplace_reviews_buyer_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reviews
    ADD CONSTRAINT marketplace_reviews_buyer_org_id_organizations_id_fk FOREIGN KEY (buyer_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: marketplace_reviews marketplace_reviews_listing_id_marketplace_listings_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reviews
    ADD CONSTRAINT marketplace_reviews_listing_id_marketplace_listings_id_fk FOREIGN KEY (listing_id) REFERENCES public.marketplace_listings(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: message_trigger_fires message_trigger_fires_trigger_id_message_triggers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_trigger_fires
    ADD CONSTRAINT message_trigger_fires_trigger_id_message_triggers_id_fk FOREIGN KEY (trigger_id) REFERENCES public.message_triggers(id) ON DELETE CASCADE;


--
-- Name: message_triggers message_triggers_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_triggers
    ADD CONSTRAINT message_triggers_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: metrics_snapshots metrics_snapshots_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_snapshots
    ADD CONSTRAINT metrics_snapshots_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: oauth_authorization_codes oauth_authorization_codes_client_id_oauth_clients_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: oauth_authorization_codes oauth_authorization_codes_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: oauth_authorization_codes oauth_authorization_codes_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_api_key_id_api_keys_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_api_key_id_api_keys_id_fk FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_client_id_oauth_clients_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: onboarding_links onboarding_links_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_links
    ADD CONSTRAINT onboarding_links_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: outbound_message_sends outbound_message_sends_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_message_sends
    ADD CONSTRAINT outbound_message_sends_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: outbound_message_sends outbound_message_sends_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_message_sends
    ADD CONSTRAINT outbound_message_sends_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: outbound_message_sends outbound_message_sends_trigger_id_outbound_message_triggers_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_message_sends
    ADD CONSTRAINT outbound_message_sends_trigger_id_outbound_message_triggers_id_ FOREIGN KEY (trigger_id) REFERENCES public.outbound_message_triggers(id) ON DELETE SET NULL;


--
-- Name: outbound_message_triggers outbound_message_triggers_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_message_triggers
    ADD CONSTRAINT outbound_message_triggers_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: outbound_scheduled_sends outbound_scheduled_sends_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_scheduled_sends
    ADD CONSTRAINT outbound_scheduled_sends_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: outbound_scheduled_sends outbound_scheduled_sends_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_scheduled_sends
    ADD CONSTRAINT outbound_scheduled_sends_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: outbound_scheduled_sends outbound_scheduled_sends_trigger_id_outbound_message_triggers_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_scheduled_sends
    ADD CONSTRAINT outbound_scheduled_sends_trigger_id_outbound_message_triggers_i FOREIGN KEY (trigger_id) REFERENCES public.outbound_message_triggers(id) ON DELETE CASCADE;


--
-- Name: partner_agencies partner_agencies_owner_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_agencies
    ADD CONSTRAINT partner_agencies_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payment_events payment_events_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: payment_records payment_records_booking_id_bookings_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_records
    ADD CONSTRAINT payment_records_booking_id_bookings_id_fk FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: payment_records payment_records_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_records
    ADD CONSTRAINT payment_records_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: payment_records payment_records_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_records
    ADD CONSTRAINT payment_records_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: pipelines pipelines_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipelines
    ADD CONSTRAINT pipelines_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: portal_access_codes portal_access_codes_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_codes
    ADD CONSTRAINT portal_access_codes_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: portal_access_codes portal_access_codes_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_codes
    ADD CONSTRAINT portal_access_codes_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: portal_documents portal_documents_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_documents
    ADD CONSTRAINT portal_documents_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: portal_documents portal_documents_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_documents
    ADD CONSTRAINT portal_documents_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: portal_documents portal_documents_uploaded_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_documents
    ADD CONSTRAINT portal_documents_uploaded_by_user_id_users_id_fk FOREIGN KEY (uploaded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_messages portal_messages_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_messages
    ADD CONSTRAINT portal_messages_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: portal_messages portal_messages_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_messages
    ADD CONSTRAINT portal_messages_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: portal_resources portal_resources_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_resources
    ADD CONSTRAINT portal_resources_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: portal_resources portal_resources_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_resources
    ADD CONSTRAINT portal_resources_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: preview_sessions preview_sessions_claimed_by_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preview_sessions
    ADD CONSTRAINT preview_sessions_claimed_by_org_id_organizations_id_fk FOREIGN KEY (claimed_by_org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: proposal_events proposal_events_proposal_id_proposals_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposal_events
    ADD CONSTRAINT proposal_events_proposal_id_proposals_id_fk FOREIGN KEY (proposal_id) REFERENCES public.proposals(id) ON DELETE CASCADE;


--
-- Name: proposals proposals_agency_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_agency_org_id_organizations_id_fk FOREIGN KEY (agency_org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: proposals proposals_created_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: proposals proposals_preview_workspace_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_preview_workspace_id_organizations_id_fk FOREIGN KEY (preview_workspace_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: recording_sessions recording_sessions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_sessions
    ADD CONSTRAINT recording_sessions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: replay_send_claims replay_send_claims_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_send_claims
    ADD CONSTRAINT replay_send_claims_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: replay_send_claims replay_send_claims_skill_id_replay_skills_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_send_claims
    ADD CONSTRAINT replay_send_claims_skill_id_replay_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.replay_skills(id) ON DELETE CASCADE;


--
-- Name: replay_skills replay_skills_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_skills
    ADD CONSTRAINT replay_skills_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;


--
-- Name: replay_skills replay_skills_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_skills
    ADD CONSTRAINT replay_skills_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: replay_skills replay_skills_source_trace_id_agent_workflow_traces_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_skills
    ADD CONSTRAINT replay_skills_source_trace_id_agent_workflow_traces_id_fk FOREIGN KEY (source_trace_id) REFERENCES public.agent_workflow_traces(id) ON DELETE SET NULL;


--
-- Name: scheduled_trigger_fires scheduled_trigger_fires_scheduled_trigger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_trigger_fires
    ADD CONSTRAINT scheduled_trigger_fires_scheduled_trigger_id_fkey FOREIGN KEY (scheduled_trigger_id) REFERENCES public.scheduled_triggers(id) ON DELETE CASCADE;


--
-- Name: scheduled_triggers scheduled_triggers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_triggers
    ADD CONSTRAINT scheduled_triggers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: seldon_sessions seldon_sessions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldon_sessions
    ADD CONSTRAINT seldon_sessions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: seldon_usage seldon_usage_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldon_usage
    ADD CONSTRAINT seldon_usage_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: seldon_usage seldon_usage_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldon_usage
    ADD CONSTRAINT seldon_usage_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: seldonframe_events seldonframe_events_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seldonframe_events
    ADD CONSTRAINT seldonframe_events_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_cards share_cards_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_cards
    ADD CONSTRAINT share_cards_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: share_cards share_cards_template_id_agent_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_cards
    ADD CONSTRAINT share_cards_template_id_agent_templates_id_fk FOREIGN KEY (template_id) REFERENCES public.agent_templates(id) ON DELETE CASCADE;


--
-- Name: sms_events sms_events_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_events
    ADD CONSTRAINT sms_events_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sms_events sms_events_sms_message_id_sms_messages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_events
    ADD CONSTRAINT sms_events_sms_message_id_sms_messages_id_fk FOREIGN KEY (sms_message_id) REFERENCES public.sms_messages(id) ON DELETE CASCADE;


--
-- Name: sms_messages sms_messages_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: sms_messages sms_messages_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sms_messages sms_messages_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: soul_sources soul_sources_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soul_sources
    ADD CONSTRAINT soul_sources_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: soul_wiki soul_wiki_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soul_wiki
    ADD CONSTRAINT soul_wiki_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: stripe_connections stripe_connections_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_connections
    ADD CONSTRAINT stripe_connections_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: subscriptions subscriptions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: supervised_runs supervised_runs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervised_runs
    ADD CONSTRAINT supervised_runs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: supervised_runs supervised_runs_template_id_agent_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervised_runs
    ADD CONSTRAINT supervised_runs_template_id_agent_templates_id_fk FOREIGN KEY (template_id) REFERENCES public.agent_templates(id) ON DELETE CASCADE;


--
-- Name: suppression_list suppression_list_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppression_list
    ADD CONSTRAINT suppression_list_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: users users_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: webhook_endpoints webhook_endpoints_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workflow_approvals workflow_approvals_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_approvals
    ADD CONSTRAINT workflow_approvals_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: workflow_approvals workflow_approvals_run_id_workflow_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_approvals
    ADD CONSTRAINT workflow_approvals_run_id_workflow_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workflow_event_log workflow_event_log_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_event_log
    ADD CONSTRAINT workflow_event_log_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workflow_recordings workflow_recordings_session_id_recording_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_recordings
    ADD CONSTRAINT workflow_recordings_session_id_recording_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.recording_sessions(id) ON DELETE CASCADE;


--
-- Name: workflow_runs workflow_runs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_runs
    ADD CONSTRAINT workflow_runs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workflow_step_results workflow_step_results_run_id_workflow_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_step_results
    ADD CONSTRAINT workflow_step_results_run_id_workflow_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workflow_waits workflow_waits_run_id_workflow_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_waits
    ADD CONSTRAINT workflow_waits_run_id_workflow_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workspace_agents workspace_agents_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_agents
    ADD CONSTRAINT workspace_agents_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_collections workspace_collections_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_collections
    ADD CONSTRAINT workspace_collections_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_domains workspace_domains_workspace_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_domains
    ADD CONSTRAINT workspace_domains_workspace_id_organizations_id_fk FOREIGN KEY (workspace_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_pages workspace_pages_collection_id_workspace_collections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_pages
    ADD CONSTRAINT workspace_pages_collection_id_workspace_collections_id_fk FOREIGN KEY (collection_id) REFERENCES public.workspace_collections(id) ON DELETE SET NULL;


--
-- Name: workspace_pages workspace_pages_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_pages
    ADD CONSTRAINT workspace_pages_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_records workspace_records_collection_id_workspace_collections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_records
    ADD CONSTRAINT workspace_records_collection_id_workspace_collections_id_fk FOREIGN KEY (collection_id) REFERENCES public.workspace_collections(id) ON DELETE CASCADE;


--
-- Name: workspace_records workspace_records_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_records
    ADD CONSTRAINT workspace_records_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: workspace_records workspace_records_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_records
    ADD CONSTRAINT workspace_records_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_secrets workspace_secrets_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_secrets workspace_secrets_updated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_updated_by_users_id_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_secrets workspace_secrets_workspace_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_workspace_id_organizations_id_fk FOREIGN KEY (workspace_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_sidebar_items workspace_sidebar_items_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sidebar_items
    ADD CONSTRAINT workspace_sidebar_items_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


