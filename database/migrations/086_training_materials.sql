-- Migration 086: private PDF training materials for HQ-managed, teacher-read-only learning.

BEGIN;

CREATE TABLE IF NOT EXISTS public.training_materials (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title VARCHAR(160) NOT NULL CHECK (BTRIM(title) <> ''),
  category VARCHAR(80) NOT NULL DEFAULT '',
  file_reference VARCHAR(768) NOT NULL UNIQUE CHECK (file_reference LIKE 'pg://%'),
  original_file_name VARCHAR(255) NOT NULL CHECK (BTRIM(original_file_name) <> ''),
  file_bytes BIGINT NOT NULL CONSTRAINT training_materials_file_bytes_check
    CHECK (file_bytes BETWEEN 8 AND 104857600),
  client_request_id VARCHAR(64) NOT NULL UNIQUE,
  material_status VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED'
    CHECK (material_status IN ('PUBLISHED', 'ARCHIVED')),
  created_by_staff_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_materials_status_time
  ON public.training_materials (material_status, published_at DESC, id DESC);

COMMENT ON TABLE public.training_materials IS
  'Migration 086: HQ-managed private PDF learning library. Active teachers are read-only; stores have no access.';

ALTER TABLE public.training_materials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.training_materials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.training_materials FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.training_materials TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.training_materials_id_seq TO service_role;

ALTER TABLE public.training_materials
  DROP CONSTRAINT IF EXISTS training_materials_file_bytes_check;
ALTER TABLE public.training_materials
  ADD CONSTRAINT training_materials_file_bytes_check
  CHECK (file_bytes BETWEEN 8 AND 104857600);

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  created_at,
  updated_at
) VALUES (
  'training-materials',
  'training-materials',
  FALSE,
  104857600,
  ARRAY['application/pdf']::TEXT[],
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE
   SET public = FALSE,
       file_size_limit = 104857600,
       allowed_mime_types = ARRAY['application/pdf']::TEXT[],
       updated_at = NOW();

COMMIT;
