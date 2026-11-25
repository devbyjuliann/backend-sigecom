# Convenciones del repositorio backend-sigecom

## Commits

- Usar Conventional Commits con descripciones claras y específicas en español.
- Mantener el formato `<tipo>(<ámbito>): <descripción en español>`; el ámbito es opcional.
- Usar tipos convencionales como `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` y `chore`.
- La descripción debe resumir el cambio concreto y evitar mensajes genéricos; por ejemplo: `fix(auth): limita intentos por cuenta`.
- No reescribir commits históricos para cambiarles el idioma o el formato.

## Estado de publicación

- El servicio backend y MariaDB existentes se conservaron sin cambios ni despliegues.
- La versión `v1.0.0` no se ha publicado; su etiqueta y Release quedan pendientes de verificar el inicio de sesión exitoso del frontend con una cuenta de prueba autorizada.
