-- =====================================================================
--  VALIDAR PAGOS · Usuarios, roles (admin / trabajador) y sesiones
--  Ejecutar DESPUÉS de schema.sql  (Supabase > SQL Editor > Run)
--
--  Usuarios iniciales:   admin / 1234  (administrador)
--                        v     / 1234  (trabajador)
--  ¡Cambia estas contraseñas desde Ajustes > Usuarios!
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Usuarios y sesiones (sin políticas RLS => solo accesibles vía RPC)
-- ---------------------------------------------------------------------
create table if not exists public.app_users (
  id              uuid primary key default gen_random_uuid(),
  username        text not null unique,
  display_name    text,
  password_hash   text not null,
  role            text not null check (role in ('admin', 'trabajador')),
  active          boolean not null default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);
alter table public.app_users enable row level security;

insert into public.app_users (username, display_name, password_hash, role) values
  ('admin', 'Administrador', crypt('1234', gen_salt('bf')), 'admin'),
  ('v',     'Trabajador',    crypt('1234', gen_salt('bf')), 'trabajador')
on conflict (username) do nothing;

create table if not exists public.app_sessions (
  token      text primary key,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.app_sessions enable row level security;

-- ---------------------------------------------------------------------
-- Cambios a tablas existentes
-- ---------------------------------------------------------------------
-- trusted = llegó por un canal oficial con secreto (correo Gmail o reenviador de SMS)
alter table public.notifications add column if not exists trusted    boolean not null default false;
alter table public.notifications add column if not exists updated_at timestamptz not null default now();
update public.notifications set trusted = true where not trusted and channels && array['email', 'sms'];
create index if not exists notifications_updated_idx on public.notifications (updated_at);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists notifications_touch on public.notifications;
create trigger notifications_touch before update on public.notifications
  for each row execute function public.touch_updated_at();

alter table public.validations add column if not exists created_by_user uuid references public.app_users(id) on delete set null;
alter table public.validations add column if not exists created_by_name text;

-- ---------------------------------------------------------------------
-- Sesión
-- ---------------------------------------------------------------------
create or replace function public._session(p_token text) returns public.app_users
language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  select a.* into u from app_sessions s join app_users a on a.id = s.user_id
   where s.token = p_token and s.expires_at > now() and a.active;
  if not found then raise exception 'SESION_EXPIRADA' using errcode = '28000'; end if;
  return u;
end $$;
revoke all on function public._session(text) from public, anon, authenticated;

create or replace function public.app_login(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u       app_users;
  v_token text;
begin
  delete from app_sessions where expires_at < now();
  select * into u from app_users where username = lower(trim(p_username));
  if not found or not u.active then
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos');
  end if;
  if u.locked_until is not null and u.locked_until > now() then
    return jsonb_build_object('ok', false, 'error',
      'Usuario bloqueado por intentos fallidos. Intenta en ' || ceil(extract(epoch from u.locked_until - now()) / 60) || ' min');
  end if;
  if u.password_hash <> crypt(coalesce(p_password, ''), u.password_hash) then
    update app_users set
      failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' end
    where id = u.id;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos');
  end if;

  update app_users set failed_attempts = 0, locked_until = null where id = u.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into app_sessions (token, user_id, expires_at) values (v_token, u.id, now() + interval '24 hours');
  return jsonb_build_object('ok', true, 'token', v_token, 'username', u.username,
                            'display_name', coalesce(u.display_name, u.username), 'role', u.role);
end $$;

create or replace function public.app_logout(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from app_sessions where token = p_token;
$$;

-- ---------------------------------------------------------------------
-- Sincronización (la app consulta cada pocos segundos)
--  admin: todo (90 días) · trabajador: solo pagos recibidos (3 días)
-- ---------------------------------------------------------------------
create or replace function public.sync(p_token text, p_cursor timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u       app_users := _session(p_token);
  v_admin boolean := u.role = 'admin';
  v_from  timestamptz := now() - case when u.role = 'admin' then interval '90 days' else interval '3 days' end;
begin
  return jsonb_build_object(
    'server_time', now(),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) - 'raw' - 'message_id' order by n.occurred_at desc) from (
        select * from notifications
         where occurred_at >= v_from and (v_admin or direction = 'in')
           and (p_cursor is null or updated_at > p_cursor)
         order by occurred_at desc limit 3000) n), '[]'::jsonb),
    'validations', coalesce((
      select jsonb_agg(to_jsonb(v) - 'ocr_text' - 'parsed' - 'checks' order by v.created_at desc) from (
        select * from validations
         where created_at >= v_from and (p_cursor is null or created_at > p_cursor)
         order by created_at desc limit 2000) v), '[]'::jsonb)
  );
end $$;

-- Busca notificaciones candidatas y duplicados para un pantallazo
create or replace function public.validation_lookup(
  p_token text, p_amount numeric, p_occurred_at timestamptz, p_image_hash text, p_reference text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u app_users := _session(p_token);
begin
  return jsonb_build_object(
    'candidates', coalesce((
      select jsonb_agg(to_jsonb(n) - 'raw' - 'message_id' order by n.occurred_at)
        from notifications n
       where n.direction = 'in' and n.amount = p_amount
         and n.occurred_at between p_occurred_at - interval '15 minutes' and p_occurred_at + interval '15 minutes'), '[]'::jsonb),
    'dup_image', exists (select 1 from validations where status = 'aprobado' and image_hash = p_image_hash),
    'dup_reference', coalesce(nullif(trim(p_reference), ''), null) is not null and exists (
      select 1 from validations where status = 'aprobado' and upper(reference) = upper(trim(p_reference)))
  );
end $$;

-- ---------------------------------------------------------------------
-- Registrar validación (reemplaza la versión basada en Supabase Auth)
-- ---------------------------------------------------------------------
drop function if exists public.register_validation(uuid, text, int, text, text, numeric, text, timestamptz, text, jsonb, jsonb);
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
    if v_n.direction <> 'in' then raise exception 'Solo se validan pagos recibidos'; end if;
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

-- ---------------------------------------------------------------------
-- Ingesta de notificaciones (Gmail/SMS con secreto, o admin con sesión)
-- ---------------------------------------------------------------------
drop function if exists public.ingest_notification(text, text, text, text, text, boolean, text);
create or replace function public.ingest_notification(
  p_raw        text,
  p_channel    text    default 'email',
  p_sender     text    default null,
  p_subject    text    default null,
  p_message_id text    default null,
  p_dkim_pass  boolean default false,
  p_secret     text    default null,
  p_token      text    default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trusted  boolean := coalesce(p_secret, '') = (select value from app_config where key = 'ingest_secret');
  v_sender   text    := lower(trim(coalesce(p_sender, '')));
  v_channel  text    := coalesce(p_channel, 'manual');
  v_user     app_users;
  v_auth     authorized_senders%rowtype;
  v_p        record;
  v_verified boolean := false;
  v_key      text;
  v_id       uuid;
  v_new      boolean;
begin
  if not v_trusted then
    if p_token is null then raise exception 'no autorizado' using errcode = '42501'; end if;
    v_user := _session(p_token);
    if v_user.role <> 'admin' then
      raise exception 'Solo el administrador puede registrar movimientos manualmente';
    end if;
    if v_channel in ('email', 'sms') then v_channel := 'manual'; end if;
  end if;
  if v_channel not in ('email', 'sms', 'share', 'manual') then raise exception 'canal inválido'; end if;

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

  insert into notifications (direction, channel, channels, sender, verified, trusted, bank, counterparty,
                             amount, occurred_at, reference, subject, message_id, raw, dedupe_key)
  values (v_p.direction, v_channel, array[v_channel], nullif(v_sender, ''), v_verified, v_trusted, v_p.bank,
          v_p.counterparty, v_p.amount, v_p.occurred_at, v_p.reference, p_subject, p_message_id, p_raw, v_key)
  on conflict (dedupe_key) do update set
    verified  = notifications.verified or excluded.verified,
    trusted   = notifications.trusted or excluded.trusted,
    channels  = (select array_agg(distinct c) from unnest(notifications.channels || excluded.channels) c),
    reference = coalesce(notifications.reference, excluded.reference),
    sender    = case when excluded.verified then excluded.sender else notifications.sender end
  returning id, (xmax = 0) into v_id, v_new;

  return jsonb_build_object('ok', true, 'id', v_id, 'new', v_new, 'direction', v_p.direction,
                            'amount', v_p.amount, 'counterparty', v_p.counterparty, 'verified', v_verified);
end $$;

-- ---------------------------------------------------------------------
-- Administración de usuarios
-- ---------------------------------------------------------------------
create or replace function public.list_users(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u app_users := _session(p_token);
begin
  if u.role <> 'admin' then raise exception 'Solo el administrador'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'username', username, 'display_name', display_name, 'role', role,
      'active', active, 'locked', locked_until > now(), 'created_at', created_at) order by role, username)
    from app_users), '[]'::jsonb);
end $$;

create or replace function public.save_user(
  p_token text, p_username text, p_password text, p_role text, p_display_name text, p_active boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u      app_users := _session(p_token);
  v_name text := lower(trim(p_username));
  v_id   uuid;
begin
  if u.role <> 'admin' then raise exception 'Solo el administrador'; end if;
  if v_name !~ '^[a-z0-9._-]{1,32}$' then raise exception 'Usuario inválido (letras, números, . _ -)'; end if;
  if p_role not in ('admin', 'trabajador') then raise exception 'Rol inválido'; end if;
  if nullif(p_password, '') is not null and length(p_password) < 4 then raise exception 'La contraseña debe tener al menos 4 caracteres'; end if;
  if v_name = u.username and (not coalesce(p_active, true) or p_role <> 'admin') then
    raise exception 'No puedes quitarte el rol de administrador ni desactivarte';
  end if;

  select id into v_id from app_users where username = v_name;
  if v_id is null then
    if nullif(p_password, '') is null then raise exception 'La contraseña es obligatoria para usuarios nuevos'; end if;
    insert into app_users (username, display_name, password_hash, role, active)
    values (v_name, nullif(trim(p_display_name), ''), crypt(p_password, gen_salt('bf')), p_role, coalesce(p_active, true))
    returning id into v_id;
  else
    update app_users set
      display_name    = nullif(trim(p_display_name), ''),
      role            = p_role,
      active          = coalesce(p_active, true),
      password_hash   = case when nullif(p_password, '') is not null then crypt(p_password, gen_salt('bf')) else password_hash end,
      failed_attempts = 0,
      locked_until    = null
    where id = v_id;
    if nullif(p_password, '') is not null or not coalesce(p_active, true) then
      delete from app_sessions where user_id = v_id and token <> p_token;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.change_password(p_token text, p_old text, p_new text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u app_users := _session(p_token);
begin
  if u.password_hash <> crypt(coalesce(p_old, ''), u.password_hash) then raise exception 'La contraseña actual no es correcta'; end if;
  if length(coalesce(p_new, '')) < 4 then raise exception 'La contraseña debe tener al menos 4 caracteres'; end if;
  update app_users set password_hash = crypt(p_new, gen_salt('bf')) where id = u.id;
  delete from app_sessions where user_id = u.id and token <> p_token;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------
grant execute on function public.app_login(text, text)                    to anon, authenticated;
grant execute on function public.app_logout(text)                         to anon, authenticated;
grant execute on function public.sync(text, timestamptz)                  to anon, authenticated;
grant execute on function public.validation_lookup(text, numeric, timestamptz, text, text) to anon, authenticated;
grant execute on function public.register_validation(text, uuid, text, int, text, text, numeric, text, timestamptz, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.ingest_notification(text, text, text, text, text, boolean, text, text) to anon, authenticated;
grant execute on function public.list_users(text)                         to anon, authenticated;
grant execute on function public.save_user(text, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.change_password(text, text, text)        to anon, authenticated;
