# Validar Pagos

PWA en React para validar pagos recibidos por Nequi **sin usar APIs de bancos**. Compara el pantallazo enviado por el cliente con la notificación oficial de Nequi en cinco puntos: valor exacto, hora exacta, nombre, número de movimiento y remitente autorizado.

| Remitente autorizado | Uso |
|---|---|
| `notificaciones@nequi.com.co` | Pagos recibidos: «Recibiste 70.000 de … el 17 de octubre de 2026 a las 9:13 a.m, desde el banco Nubank.» |
| `somos@nequi.com.co` | Salida de dinero: «Hiciste un pago en … por $41.649 · Fecha … · Hora … · CUS …» |

## Funciones
- **Analítica animada:** totales recibidos y pagados, flujo diario, pagos recibidos por banco, horas pico, pagos por beneficiario y estado de las validaciones.
- **Validación de pantallazos:** lectura OCR (Tesseract) del comprobante y cruce con la notificación oficial. También detecta imágenes y números de movimiento ya usados, y bloquea que un mismo pago se valide dos veces (control en la base de datos).
- **Voz en tiempo real:**
  - Al recibir un pago: «Recibiste 70.000 pesos de Diccter Fernando Perea Rodriguez».
  - Al salir dinero: «Hiciste un pago por valor de 41.649 pesos a Comunicacion Celular Comcel».
- **Permisos del celular:** notificaciones, voz, cámara, portapapeles, almacenamiento persistente, pantalla encendida e instalación de la app.
- **Compartir (share target):** comparte un SMS o un pantallazo de WhatsApp directamente con la app.

## Usuarios y roles
| Usuario | Contraseña inicial | Rol | Ve |
|---|---|---|---|
| `admin` | `1234` | Administrador | Analítica, Caja, Validar, Movimientos (entradas y salidas), Usuarios e integraciones |
| `v` | `1234` | Trabajador | **Caja** (escucha en vivo los pagos recibidos), **Validar** pantallazos y Ajustes |

- El trabajador **no necesita acceso al correo ni al celular**: la app le muestra y le lee en voz alta cada pago recibido, desde cualquier dispositivo.
- El trabajador **no ve salidas de dinero**, solo los pagos recibidos de los últimos 3 días, y **no puede registrar movimientos manualmente**.
- El trabajador solo puede aprobar pagos confirmados por un canal oficial (el correo de Gmail o el SMS reenviado con el secreto).
- Las contraseñas se guardan cifradas (bcrypt). Tras 5 intentos fallidos el usuario se bloquea 5 minutos. **Cambia las contraseñas `1234`** desde Ajustes.

## Instalación
1. **Base de datos.** En Supabase abre SQL Editor y ejecuta, en este orden, `supabase/schema.sql` y `supabase/02_usuarios_roles.sql`.
2. **Usuarios.** Ya quedan creados `admin` y `v`. Puedes crear más trabajadores en Ajustes → Usuarios.
3. **Gmail.** Sigue las instrucciones del archivo `integraciones/gmail-apps-script.gs`. El secreto se obtiene con:
   ```sql
   select value from public.app_config where key = 'ingest_secret';
   ```
4. **SMS automático (opcional).** Configura MacroDroid o Tasker para que, al recibir un SMS que contenga «Nequi», haga un POST a `/rest/v1/rpc/ingest_notification` con `p_channel: "sms"` y el secreto. En la pestaña **Permisos** de la app están los pasos detallados.
5. **Ejecutar la app:**
   ```bash
   npm install
   npm run dev      # desarrollo
   npm run build    # producción (carpeta dist/)
   ```
   Publícala en Vercel o Netlify (HTTPS es obligatorio para PWA, cámara y share target).

## Limitaciones de la plataforma
- Android y los navegadores **no permiten que una web lea SMS ni la bandeja de correo**. Por eso los mensajes entran por cuatro vías: el script de Gmail, un reenviador de SMS, la opción Compartir o pegando el texto.
- La voz y las alertas funcionan con la app abierta. Usa el «Modo caja» para mantener la pantalla encendida.
- Un correo cuenta como **verificado** solo si viene de un remitente autorizado y tiene DKIM o DMARC válido de `nequi.com.co`. Los SMS y los textos pegados quedan como «no verificados» hasta que llegue el correo oficial.
