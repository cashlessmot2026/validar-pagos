/**
 * VALIDAR PAGOS · Conector Gmail -> Supabase
 *
 * 1. Abre https://script.google.com con la cuenta Gmail que recibe los correos de Nequi.
 * 2. Nuevo proyecto, pega este archivo y reemplaza INGEST_SECRET con el valor de:
 *      select value from public.app_config where key = 'ingest_secret';
 * 3. (Opcional) Editor > Servicios > + > "Gmail API" > Agregar.
 * 4. Ejecuta una vez `instalarActivador` (acepta los permisos de Gmail).
 *    Desde ese momento revisa el correo cada minuto.
 *
 * Solo procesa correos cuyo remitente sea exactamente uno de los autorizados y
 * marca como verificados los que tengan DKIM/DMARC válidos del dominio nequi.com.co.
 */
const SUPABASE_URL = 'https://wzeycwyumbsbeytypzal.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6ZXljd3l1bWJzYmV5dHlwemFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNDUyMjIsImV4cCI6MjEwNzkyMTIyMn0.0XtsUOx90wQrCI1t5el848fvRzx66LeP3yMtsEkiPPM';
const INGEST_SECRET = 'PEGA_AQUI_EL_SECRETO';

const SENDERS = ['notificaciones@nequi.com.co', 'somos@nequi.com.co'];
const LABEL = 'validador-procesado';

function procesarCorreosNequi() {
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const query = '(from:notificaciones@nequi.com.co OR from:somos@nequi.com.co) -label:' + LABEL + ' newer_than:3d';
  const threads = GmailApp.search(query, 0, 50);

  threads.forEach(function (thread) {
    let allOk = true;
    thread.getMessages().forEach(function (msg) {
      const from = msg.getFrom();
      const email = ((from.match(/<([^>]+)>/) || [])[1] || from).trim().toLowerCase();
      if (SENDERS.indexOf(email) === -1) return; // dominio/remitente no autorizado

      const auth = authResults(msg);
      const dkimNequi = /dkim=pass[^;]*header\.(?:d|i)=@?(?:[\w-]+\.)*nequi\.com\.co/i.test(auth);
      const dmarcNequi = /dmarc=pass[^;]*header\.from=(?:[\w-]+\.)*nequi\.com\.co/i.test(auth);

      const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/ingest_notification', {
        method: 'post',
        contentType: 'application/json',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
        payload: JSON.stringify({
          p_raw: msg.getPlainBody(),
          p_channel: 'email',
          p_sender: email,
          p_subject: msg.getSubject(),
          p_message_id: msg.getId(),
          p_dkim_pass: dkimNequi || dmarcNequi,
          p_secret: INGEST_SECRET,
        }),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() >= 300) allOk = false;
      Logger.log(email + ' -> ' + res.getResponseCode() + ' ' + res.getContentText());
    });
    if (allOk) thread.addLabel(label);
  });
}

/**
 * Resultado DKIM/SPF/DMARC que agregó Gmail al recibir el mensaje.
 * Solo vale el PRIMER encabezado Authentication-Results y debe ser de mx.google.com:
 * los que vengan más abajo pudo escribirlos el remitente para falsificar la firma.
 * Si el servicio avanzado "Gmail API" está activado (Editor > Servicios > Gmail API)
 * se usa ese, que garantiza el orden de los encabezados; si no, GmailApp.
 */
function authResults(msg) {
  let value = '';
  if (typeof Gmail !== 'undefined') {
    try {
      const full = Gmail.Users.Messages.get('me', msg.getId(), {
        format: 'metadata',
        metadataHeaders: ['Authentication-Results'],
      });
      const first = (full.payload.headers || []).filter(function (h) {
        return h.name.toLowerCase() === 'authentication-results';
      })[0];
      value = first ? first.value : '';
    } catch (err) {
      Logger.log('Gmail API no disponible, uso GmailApp: ' + err);
      value = msg.getHeader('Authentication-Results') || '';
    }
  } else {
    value = msg.getHeader('Authentication-Results') || '';
  }
  return /^\s*mx\.google\.com\s*;/i.test(value) ? value : '';
}

function instalarActivador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'procesarCorreosNequi') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('procesarCorreosNequi').timeBased().everyMinutes(1).create();
  procesarCorreosNequi();
}
