-- =====================================================================
--  VALIDAR PAGOS · Esquema Supabase
--  Ejecutar completo en: Supabase > SQL Editor > New query > Run
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Configuración privada (sin políticas RLS => no accesible desde la API)
-- ---------------------------------------------------------------------
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;

-- Secreto que usan el script de Gmail y el reenviador de SMS.
-- Para verlo:  select value from public.app_config where key = 'ingest_secret';
insert into public.app_config (key, value)
values ('ingest_secret', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Remitentes autorizados
-- ---------------------------------------------------------------------
create table if not exists public.authorized_senders (
  email       text primary key,
  direction   text not null check (direction in ('in', 'out')),
  bank        text not null default 'Nequi',
  description text
);
alter table public.authorized_senders enable row level security;

insert into public.authorized_senders (email, direction, bank, description) values
  ('notificaciones@nequi.com.co', 'in',  'Nequi', 'Confirmación de pagos recibidos'),
  ('somos@nequi.com.co',          'out', 'Nequi', 'Pagos realizados / salida de dinero')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------
-- Notificaciones (correo / sms / compartido / manual)
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  direction    text not null check (direction in ('in', 'out')),
  channel      text not null check (channel in ('email', 'sms', 'share', 'manual')),
  channels     text[] not null default '{}',
  sender       text,
  verified     boolean not null default false,   -- correo de remitente autorizado + DKIM/DMARC pass
  bank         text,                             -- banco de origen (entrante) o 'Nequi' (saliente)
  counterparty text,                             -- pagador (in) / beneficiario (out)
  amount       numeric(14,2) not null check (amount > 0),
  occurred_at  timestamptz not null,
  reference    text,                             -- CUS / número de movimiento
  subject      text,
  message_id   text,
  raw          text not null,
  dedupe_key   text not null unique,
  validated    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists notifications_match_idx on public.notifications (direction, amount, occurred_at);
create index if not exists notifications_time_idx  on public.notifications (occurred_at desc);
alter table public.notifications enable row level security;

-- ---------------------------------------------------------------------
-- Validaciones de pantallazos
-- ---------------------------------------------------------------------
create table if not exists public.validations (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications(id) on delete set null,
  status          text not null check (status in ('aprobado', 'rechazado', 'revisar')),
  score           int  not null default 0,
  image_hash      text,
  reference       text,
  amount          numeric(14,2),
  payer_name      text,
  occurred_at     timestamptz,
  ocr_text        text,
  parsed          jsonb,
  checks          jsonb,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now()
);
-- Un pago, una imagen y un número de movimiento solo pueden aprobarse una vez
create unique index if not exists validations_notification_uq on public.validations (notification_id) where status = 'aprobado';
create unique index if not exists validations_image_uq        on public.validations (image_hash)      where status = 'aprobado' and image_hash is not null;
create unique index if not exists validations_reference_uq    on public.validations (upper(reference)) where status = 'aprobado' and reference is not null;
alter table public.validations enable row level security;

-- ---------------------------------------------------------------------
-- Políticas RLS: solo usuarios autenticados leen; escritura vía RPC
-- ---------------------------------------------------------------------
drop policy if exists "auth lee notificaciones" on public.notifications;
create policy "auth lee notificaciones" on public.notifications for select to authenticated using (true);

drop policy if exists "auth lee validaciones" on public.validations;
create policy "auth lee validaciones" on public.validations for select to authenticated using (true);

drop policy if exists "auth lee remitentes" on public.authorized_senders;
create policy "auth lee remitentes" on public.authorized_senders for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- Utilidades de parseo
-- ---------------------------------------------------------------------
create or replace function public.parse_month(m text) returns int
language sql immutable as $$
  select case left(lower(translate(coalesce(m, ''), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')), 3)
    when 'ene' then 1 when 'feb' then 2 when 'mar' then 3 when 'abr' then 4
    when 'may' then 5 when 'jun' then 6 when 'jul' then 7 when 'ago' then 8
    when 'sep' then 9 when 'set' then 9 when 'oct' then 10 when 'nov' then 11
    when 'dic' then 12 end
$$;

create or replace function public.parse_amount(t text) returns numeric
language sql immutable as $$
  -- '70.000' -> 70000 ; '41.649' -> 41649 ; '70.000,50' -> 70000.50
  select nullif(replace(replace(regexp_replace(coalesce(t, ''), '[^0-9.,]', '', 'g'), '.', ''), ',', '.'), '')::numeric
$$;

-- Interpreta las plantillas de Nequi:
--  Entrante (notificaciones@nequi.com.co):
--   "Recibiste 70.000 de NOMBRE el 17 de octubre de 2026 a las 9:13 a.m, desde el banco Nubank."
--  Saliente (somos@nequi.com.co):
--   "Hiciste un pago en COMERCIO por $41.649 Fecha: El 16 de octubre de 2026 Hora: 6:48 p. m. CUS: 747202901"
create or replace function public.parse_nequi(p_text text)
returns table (direction text, counterparty text, amount numeric, occurred_at timestamptz, bank text, reference text)
language plpgsql immutable as $$
declare
  t  text := regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g');
  m  text[];
  d  text[];
  h  text[];
  hh int;
  mo int;
begin
  direction := null; counterparty := null; amount := null; occurred_at := null; bank := null; reference := null;

  if t ~* 'recibiste' then
    direction := 'in';
    m := regexp_match(t, 'Recibiste\s+\$?\s*([0-9][0-9.,]*)\s+de\s+([^0-9]+)\s+el\s+\d', 'i');
    if m is not null then amount := parse_amount(m[1]); counterparty := trim(m[2]); end if;
    m := regexp_match(t, 'desde el banco\s+([^.,]+)', 'i');
    bank := coalesce(trim(m[1]), 'Nequi');
  elsif t ~* '(hiciste un pago|enviaste|pagaste|transferiste|compraste)' then
    direction := 'out';
    bank := 'Nequi';
    m := regexp_match(t, 'pago en\s+(.+)\s+por\s+\$\s*([0-9][0-9.,]*)', 'i');
    if m is not null then
      counterparty := trim(m[1]); amount := parse_amount(m[2]);
    else
      m := regexp_match(t, '(?:Enviaste|Pagaste|Transferiste)\s+\$?\s*([0-9][0-9.,]*)\s+a\s+([^0-9]+)\s+el\s+\d', 'i');
      if m is not null then amount := parse_amount(m[1]); counterparty := trim(m[2]); end if;
    end if;
  else
    return next; return;
  end if;

  d := regexp_match(t, '(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+de\s+(\d{4})', 'i');
  h := regexp_match(t, '(\d{1,2}):(\d{2})(?:\s*([aApP])\.?\s*[mM])?');
  if d is not null and h is not null then
    mo := parse_month(d[2]);
    hh := h[1]::int;
    if lower(h[3]) = 'p' and hh < 12 then hh := hh + 12; end if;
    if lower(h[3]) = 'a' and hh = 12 then hh := 0; end if;
    if mo is not null then
      occurred_at := make_timestamptz(d[3]::int, mo, d[1]::int, hh, h[2]::int, 0, 'America/Bogota');
    end if;
  end if;

  m := regexp_match(t, '(?:CUS|Referencia|Movimiento|Comprobante)\s*[:#]?\s*([A-Za-z0-9]{5,})', 'i');
  reference := m[1];
  return next;
end $$;

-- ---------------------------------------------------------------------
-- RPC: ingresar notificación (Apps Script de Gmail, reenviador SMS o la app)
-- ---------------------------------------------------------------------
create or replace function public.ingest_notification(
  p_raw        text,
  p_channel    text    default 'email',
  p_sender     text    default null,
  p_subject    text    default null,
  p_message_id text    default null,
  p_dkim_pass  boolean default false,
  p_secret     text    default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trusted  boolean := coalesce(p_secret, '') = (select value from app_config where key = 'ingest_secret');
  v_sender   text    := lower(trim(coalesce(p_sender, '')));
  v_channel  text    := coalesce(p_channel, 'manual');
  v_auth     authorized_senders%rowtype;
  v_p        record;
  v_verified boolean := false;
  v_key      text;
  v_id       uuid;
  v_new      boolean;
begin
  if not v_trusted and auth.uid() is null then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  if v_channel not in ('email', 'sms', 'share', 'manual') then
    raise exception 'canal inválido';
  end if;
  -- Solo el script de Gmail (con secreto) puede declarar canal email verificado
  if v_channel = 'email' and not v_trusted then v_channel := 'manual'; end if;

  v_sender := coalesce(substring(v_sender from '<([^>]+)>'), v_sender);

  if v_channel = 'email' then
    select * into v_auth from authorized_senders where email = v_sender;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'remitente no autorizado: ' || v_sender);
    end if;
    v_verified := coalesce(p_dkim_pass, false);
  end if;

  select * into v_p from parse_nequi(p_raw);
  if v_p.direction is null or v_p.amount is null or v_p.occurred_at is null then
    return jsonb_build_object('ok', false, 'error', 'no se pudo interpretar el mensaje');
  end if;
  if v_channel = 'email' and v_auth.direction <> v_p.direction then
    return jsonb_build_object('ok', false, 'error', 'la plantilla no corresponde al remitente ' || v_sender);
  end if;

  v_key := md5(v_p.direction || '|' || v_p.amount::text || '|' ||
               to_char(v_p.occurred_at at time zone 'UTC', 'YYYYMMDDHH24MI') || '|' ||
               upper(regexp_replace(coalesce(v_p.counterparty, ''), '\s+', ' ', 'g')));

  insert into notifications (direction, channel, channels, sender, verified, bank, counterparty,
                             amount, occurred_at, reference, subject, message_id, raw, dedupe_key)
  values (v_p.direction, v_channel, array[v_channel], nullif(v_sender, ''), v_verified, v_p.bank,
          v_p.counterparty, v_p.amount, v_p.occurred_at, v_p.reference, p_subject, p_message_id, p_raw, v_key)
  on conflict (dedupe_key) do update set
    verified  = notifications.verified or excluded.verified,
    channels  = (select array_agg(distinct c) from unnest(notifications.channels || excluded.channels) c),
    reference = coalesce(notifications.reference, excluded.reference),
    sender    = case when excluded.verified then excluded.sender else notifications.sender end
  returning id, (xmax = 0) into v_id, v_new;

  return jsonb_build_object('ok', true, 'id', v_id, 'new', v_new, 'direction', v_p.direction,
                            'amount', v_p.amount, 'counterparty', v_p.counterparty, 'verified', v_verified);
end $$;

revoke all on function public.ingest_notification(text, text, text, text, text, boolean, text) from public;
grant execute on function public.ingest_notification(text, text, text, text, text, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- RPC: registrar validación de pantallazo (re-verifica valor y hora en servidor)
-- ---------------------------------------------------------------------
create or replace function public.register_validation(
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
  v_n  notifications%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'no autorizado' using errcode = '42501'; end if;
  if p_status not in ('aprobado', 'rechazado', 'revisar') then raise exception 'estado inválido'; end if;

  if p_status = 'aprobado' then
    select * into v_n from notifications where id = p_notification_id for update;
    if not found then raise exception 'La notificación no existe'; end if;
    if v_n.direction <> 'in' then raise exception 'Solo se validan pagos recibidos'; end if;
    if v_n.validated then raise exception 'Este pago ya fue validado con otro comprobante'; end if;
    if v_n.amount <> p_amount then raise exception 'El valor no coincide con la notificación'; end if;
    if date_trunc('minute', v_n.occurred_at) <> date_trunc('minute', p_occurred_at) then
      raise exception 'La hora no coincide con la notificación';
    end if;
  end if;

  insert into validations (notification_id, status, score, image_hash, reference, amount, payer_name,
                           occurred_at, ocr_text, parsed, checks)
  values (case when p_status = 'aprobado' then p_notification_id end, p_status, coalesce(p_score, 0),
          p_image_hash, nullif(trim(p_reference), ''), p_amount, p_payer_name, p_occurred_at,
          p_ocr_text, p_parsed, p_checks)
  returning id into v_id;

  if p_status = 'aprobado' then
    update notifications set validated = true where id = p_notification_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  raise exception 'Comprobante duplicado: esta imagen o número de movimiento ya fue usado';
end $$;

revoke all on function public.register_validation(uuid, text, int, text, text, numeric, text, timestamptz, text, jsonb, jsonb) from public;
grant execute on function public.register_validation(uuid, text, int, text, text, numeric, text, timestamptz, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime (voz y alertas en vivo)
-- ---------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.validations;   exception when duplicate_object then null; end;
end $$;
