# FastDelivery — Plataforma centralizada de atención a quejas

Aplicación web de servidor para registrar reclamaciones, generar folios, consultar expedientes, actualizar estados y mantener un historial de seguimiento. Los datos se guardan en una base de datos SQLite en el servidor, no en el navegador del usuario.

## Funciones

- Inicio de sesión para personal autorizado.
- Registro de quejas con folio automático `FD-AAAAMMDD-######`.
- Clasificación por motivo y canal de recepción.
- Asignación de un área responsable.
- Consulta, búsqueda y filtros de reclamaciones.
- Actualización de estado, solución y notas de seguimiento.
- Historial de actividad por folio.
- Exportación de registros a CSV compatible con Excel.
- Diseño adaptable a computadora, tableta y celular.
- Actualización automática de la lista cada 30 segundos.

## Requisitos

- Node.js 22.5 o posterior (incluye el módulo `node:sqlite`).
- Para despliegue en servidor: soporte para Node.js 22 o Docker y almacenamiento persistente.

## Ejecutar localmente

1. Copia `.env.example` como `.env`.
2. Cambia `ADMIN_PASSWORD` por una contraseña larga y `SESSION_SECRET` por una cadena aleatoria de al menos 32 caracteres.
3. En la carpeta del proyecto, ejecuta:

   ```bash
   npm start
   ```

4. Abre `http://localhost:3000` en el navegador e inicia sesión con el usuario y contraseña configurados en `.env`.

No hay una cuenta universal incluida. El usuario y la contraseña se definen en la configuración del servidor.

## Ejecutar con Docker

1. Crea un archivo `.env` con estas variables (utiliza valores propios):

   ```env
   ADMIN_USER=admin
   ADMIN_PASSWORD=una_contrasena_larga_y_unica
   SESSION_SECRET=una_clave_aleatoria_de_32_caracteres_o_mas
   ```

2. Ejecuta:

   ```bash
   docker compose up -d --build
   ```

3. Abre `http://localhost:3000`.

Docker Compose crea un volumen persistente llamado `fastdelivery_data`. No elimines ese volumen al actualizar el contenedor si necesitas conservar los expedientes.

## Publicarla en internet

Este proyecto está preparado para desplegarse en un servicio que ejecute Docker o Node.js 22. Configura las variables `ADMIN_USER`, `ADMIN_PASSWORD` y `SESSION_SECRET`; configura el almacenamiento persistente en `/data`; y expón el puerto indicado por `PORT` (por defecto 3000). Utiliza HTTPS y una sola instancia del servicio, a menos que configures una base de datos compartida adecuada para varias instancias.

La carpeta `/data` debe conservarse entre reinicios y nuevas versiones. Si el proveedor elimina el almacenamiento local al reiniciar, los datos podrían perderse. Configura también copias de seguridad del archivo `fastdelivery.sqlite`.

## Alcance y seguridad

Este es un sistema inicial para una demostración académica o una operación pequeña. Incluye un inicio de sesión administrativo común, cookies de sesión protegidas y límites básicos a intentos de acceso. Antes de usarlo con clientes reales, conviene añadir cuentas individuales y permisos por departamento, recuperación de contraseña, políticas de privacidad y conservación de datos, respaldos automatizados, monitoreo y revisión de seguridad. No publiques el archivo `.env` ni compartas credenciales en presentaciones.

El sistema no envía correos ni mensajes SMS automáticamente; registra la atención y el seguimiento dentro de la plataforma.
