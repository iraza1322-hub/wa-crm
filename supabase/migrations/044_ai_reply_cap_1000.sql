-- Raise the per-conversation AI auto-reply cap from 20 to 1000.
-- Drops whatever CHECK constraint currently guards the column (its
-- auto-generated name can vary), then adds the wider one.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.ai_configs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%auto_reply_max_per_conversation%'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_configs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 1000);
