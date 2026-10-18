-- =====================================================================
--  VALIDAR PAGOS · Validar también los pagos realizados (somos@nequi.com.co)
--  Ejecutar DESPUÉS de 02_usuarios_roles.sql
-- =====================================================================

-- Por si schema.sql se ejecutó de nuevo después del 02: quitar versiones viejas duplicadas
drop function if exists public.ingest_notification(text, text, text, text, text, boolean, text);
drop function if exists public.register_validation(uuid, text, int, text, text, numeric, text, timestamptz, text, jsonb, jsonb);

-- Búsqueda de candidatos con dirección: 'in' (recibido) u 'out' (realizado, solo admin)
drop function if exists public.validation_lookup(text, numeric, timestamptz, text, text);
create or replace function public.validation_lookup(
  p_token text, p_direction text, p_amount numeric, p_occurred_at timestamptz, p_image_hash text, p_reference text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u     app_users := _session(p_token);
  v_dir text := case when p_direction = 'out' then 'out' else 'in' end;
begin
  if v_dir = 'out' and u.role <> 'admin' then
    raise exception 'Solo el administrador puede validar pagos realizados';
  end if;
  return jsonb_build_object(
    'candidates', coalesce((
      select jsonb_agg(to_jsonb(n) - 'raw' - 'message_id' order by n.occurred_at)
        from notifications n
       where n.direction = v_dir and n.amount = p_amount
         and n.occurred_at between p_occurred_at - interval '15 minutes' and p_occurred_at + interval '15 minutes'), '[]'::jsonb),
    'dup_image', exists (select 1 from validations where status = 'aprobado' and image_hash = p_image_hash),
    'dup_reference', nullif(trim(p_reference), '') is not null and exists (
      select 1 from validations where status = 'aprobado' and upper(reference) = upper(trim(p_reference)))
  );
end $$;
grant execute on function public.validation_lookup(text, text, numeric, timestamptz, text, text) to anon, authenticated;

-- Registrar validación: pagos recibidos (todos) y pagos realizados (solo admin)
create or replace function public.register_validation(
  p_token           text,
  p_notification_id uuid,
  p_status          text,
  p_score           int,
  p_image_hash      text,
  p_reference       text,
  p_amount          numeric,
  p_payer_name      text,
  p_occurred_at     timestamptz,
  p_ocr_text        text,
  p_parsed          jsonb,
  p_checks          jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u    app_users := _session(p_token);
  v_n  notifications%rowtype;
  v_id uuid;
begin
  if p_status not in ('aprobado', 'rechazado', 'revisar') then raise exception 'Estado inválido'; end if;

  if p_status = 'aprobado' then
    select * into v_n from notifications where id = p_notification_id for update;
    if not found then raise exception 'La notificación no existe'; end if;
    if v_n.direction = 'out' and u.role <> 'admin' then raise exception 'Solo el administrador valida pagos realizados'; end if;
    if v_n.validated then raise exception 'Este pago ya fue validado con otro comprobante'; end if;
    if v_n.amount <> p_amount then raise exception 'El valor no coincide con la notificación'; end if;
    if date_trunc('minute', v_n.occurred_at) <> date_trunc('minute', p_occurred_at) then
      raise exception 'La hora no coincide con la notificación';
    end if;
    if u.role <> 'admin' and not v_n.trusted then
      raise exception 'Este pago aún no tiene confirmación oficial de Nequi (correo o SMS). Solo el administrador puede aprobarlo.';
    end if;
  end if;

  insert into validations (notification_id, status, score, image_hash, reference, amount, payer_name,
                           occurred_at, ocr_text, parsed, checks, created_by_user, created_by_name)
  values (case when p_status = 'aprobado' then p_notification_id end, p_status, coalesce(p_score, 0),
          p_image_hash, nullif(trim(p_reference), ''), p_amount, p_payer_name, p_occurred_at,
          p_ocr_text, p_parsed, p_checks, u.id, coalesce(u.display_name, u.username))
  returning id into v_id;

  if p_status = 'aprobado' then
    update notifications set validated = true where id = p_notification_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  raise exception 'Comprobante duplicado: esta imagen o número de movimiento ya fue usado';
end $$;
grant execute on function public.register_validation(text, uuid, text, int, text, text, numeric, text, timestamptz, text, jsonb, jsonb) to anon, authenticated;
