-- CloudBase SQL editor migration 042.
-- Customer-wide append-only messages with a 100-character limit.

BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL
    REFERENCES public.customers(id) ON DELETE RESTRICT,
  author_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON DELETE RESTRICT,
  author_role VARCHAR(16) NOT NULL
    CHECK (author_role IN ('hq', 'store', 'teacher')),
  author_name_snapshot VARCHAR(64) NOT NULL
    CHECK (BTRIM(author_name_snapshot) <> ''),
  message_content TEXT NOT NULL
    CHECK (CHAR_LENGTH(BTRIM(message_content)) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_customer_messages_customer_created
  ON public.customer_messages(customer_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.guard_customer_message_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'customer messages are append-only'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_messages_immutable
  ON public.customer_messages;
CREATE TRIGGER trg_customer_messages_immutable
BEFORE UPDATE OR DELETE ON public.customer_messages
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_message_immutable();

COMMENT ON TABLE public.customer_messages IS
  'Append-only customer timeline messages. Author identity and role are server-derived snapshots.';

REVOKE ALL ON TABLE public.customer_messages FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_customer_message_immutable() FROM PUBLIC;

COMMIT;
