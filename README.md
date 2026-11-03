# Marcajes Zoe Fragance

Aplicación PWA de asistencia y pagos por horas, adaptada del flujo de Marcajes Indira. Incluye entrada y salida individual o múltiple, contador en vivo, tarifas generales e individuales, trabajadores, resumen e historial de liquidaciones. Modo noche azul oscuro y modo día blanco. La interfaz del personal no contiene configuración técnica.

## Implementar el backend

1. Abre [el Sheet de Zoe Fragance](https://docs.google.com/spreadsheets/d/1DTTKbIhHpOysjDimQZ1FT8noTmbsrX1HWznochJf14w/edit) con la cuenta propietaria. En **Extensiones → Apps Script**, pega el contenido completo de `Code.gs` en un proyecto exclusivo para Zoe.
2. Guarda y ejecuta **`prepararSistema`**. Autoriza el acceso a las hojas y el envío de comprobantes por correo. Esta única función prepara todas las hojas y columnas necesarias; también existe el alias `setup`. Puedes repetirla sin borrar registros ni restablecer tarifas o el PIN.
3. Selecciona **Implementar → Nueva implementación → Aplicación web**. Ejecutar como: **Yo**. Acceso: **Cualquier persona**. Copia la URL terminada en `/exec`.
4. La URL de Zoe ya está conectada en `config.js`, propiedad `apiUrl`. Para futuras implementaciones, actualiza ese archivo. La interfaz no muestra ni solicita la URL.
5. Publica los archivos de la web en un alojamiento con **HTTPS**, conservando sus rutas relativas. No requiere compilación, base de datos adicional ni instalar Node para utilizarla.
6. En la aplicación, entra a **Trabajadores** o **Resumen** con el PIN **5678**, define el valor por hora y registra a los trabajadores.

`appsscript.json` se incluye por si quieres configurar explícitamente el manifiesto del proyecto de Apps Script: V8, horario de Bogotá y permisos de hojas y correo. El `Code.gs` funciona sin librerías ni activadores.

La implementación como aplicación web y el acceso se configuran en Google, según su [guía de aplicaciones web](https://developers.google.com/apps-script/guides/web). Para actualizar el backend, publica una **nueva versión de la misma implementación** y conserva la URL.

## Hojas que se crean

| Hoja | Columnas |
| --- | --- |
| `workers` | `id`, `name`, `phone`, `email`, `created_at`, `hourly_rate`, `archived_at` |
| `time_logs` | `id`, `worker_id`, `start`, `end`, `hours`, `shift_type`, `shift_label`, `hourly_rate`, `earned`, `created_at`, `request_id`, `in_request_id` |
| `liquidations` | `id`, `worker_id`, `hours_paid`, `amount_paid`, `liquidation_date`, `hourly_rate`, `included_logs`, `request_id`, `worker_name`, `worker_phone`, `worker_email`, `email_status` |
| `settings` | `key`, `value` |

La tarifa inicial queda en cero para que la empresa defina su valor real. La zona horaria es `America/Bogota`. Las tablas se continúan en hojas con sufijo `_2`, `_3`, etc., al alcanzar 50.000 filas por hoja; se conserva el límite total de celdas de Google Sheets.

## Funcionamiento

- **Entrada:** abre el turno con la hora del servidor y guarda su tarifa. El reloj continúa aunque se cierre la aplicación o se cruce medianoche.
- **Salida:** cierra la entrada abierta y calcula tiempo real × tarifa del turno. No utiliza turnos prefijados de ventas ni duraciones suministradas por el dispositivo.
- **Tarifas:** la individual tiene prioridad sobre la general. Cambiar una tarifa afecta las entradas nuevas; los turnos existentes conservan su tarifa.
- **Liquidación:** registra el pago de las jornadas cerradas pendientes y sus identificadores. Requiere cerrar el turno abierto. Las horas pagadas no vuelven a sumarse. No efectúa transferencias bancarias.
- **Correo:** si el trabajador tiene correo, el backend envía el comprobante desde la cuenta que implementa Apps Script. Usa [MailApp de Google](https://developers.google.com/apps-script/reference/mail/mail-app), sin credenciales de EmailJS de otra empresa. Un fallo o falta de cuota de correo no elimina el pago; el resultado queda en `email_status`.
- **Retirar trabajador:** conserva el historial y bloquea el retiro mientras haya un turno abierto o registros pendientes.
- **PIN:** se valida en el servidor para trabajadores, tarifas, resumen y liquidaciones. La sesión administrativa dura hasta seis horas, puede caducar antes por la caché de Google y se cierra al recargar o pulsar **Bloquear administración**. Marcajes permite operar sin PIN, como en Indira.
- **Conexión:** los marcajes requieren internet. Si una confirmación se pierde, repetir el mismo botón consulta/reintenta la misma operación sin duplicarla. El reloj mostrado es una estimación; la salida se calcula en el servidor.

## PWA

Incluye `manifest.json`, `sw.js`, iconos PNG de 192 y 512 px, icono maskable y apple-touch-icon. SweetAlert está incluido localmente en `vendor/`, para que la interfaz y los diálogos estén disponibles sin CDN.

En Chrome o Edge se puede instalar desde el navegador o desde **Instalar aplicación**, cuando el navegador ofrece la instalación. En iPhone/iPad: Safari → Compartir → Agregar a pantalla de inicio. Abre en una ventana independiente. La interfaz se guarda para poder abrirla sin red; los marcajes y pagos se confirman con el servidor. Se necesita HTTPS en producción; `localhost` sirve para pruebas. Abrir `index.html` con doble clic no instala la PWA.

Cuando publiques cambios, incrementa `CACHE` en `sw.js` para renovar el conjunto de archivos. Las actualizaciones se ofrecen con **Actualizar aplicación**; no se fuerza una recarga durante un marcaje o una liquidación.

## Velocidad y verificación

La primera carga usa una petición `getTimeBootstrap`. Cada marcaje múltiple envía una petición para el lote. El backend agrupa trabajadores, jornadas y pagos en un recorrido, usa lecturas por rangos y una caché breve invalidada por revisión al modificar datos. Los relojes avanzan en el dispositivo sin peticiones por segundo. Los listados se sincronizan cada 15 segundos mientras la aplicación está visible.

Pruebas de backend, sin dependencias: `node --test tests/backend.test.cjs`.

Pruebas de navegador: instala `playwright-core` y ejecuta `node tests/browser.cjs`. Puedes indicar `CHROME_PATH` y `PLAYWRIGHT_MODULE`. Estas pruebas usan el `Code.gs` real con servicios de Google simulados: no modifican el Sheet ni envían correos reales.

Validado en Chromium con entrada, salida, PIN, liquidación, historial, resumen, selección múltiple y apertura de la interfaz sin red. Revisado en anchos de 320, 390, 768, 1024 y 1440 px, en ambos temas. La conexión y latencia de Google, el envío de correos real y la instalación en dispositivos físicos deben verificarse después de implementar el Apps Script y publicar con HTTPS.
