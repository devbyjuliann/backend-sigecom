# Convenciones del repositorio backend-sigecom

## Commits

- Usar Conventional Commits con descripciones claras y específicas en español.
- Mantener el formato `<tipo>(<ámbito>): <descripción en español>`; el ámbito es opcional.
- Usar tipos convencionales como `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` y `chore`.
- La descripción debe resumir el cambio concreto y evitar mensajes genéricos; por ejemplo: `fix(auth): limita intentos por cuenta`.
- No reescribir commits históricos para cambiarles el idioma o el formato.

## Estado de publicación

- El despliegue backend `c12dbba9-7222-4588-801e-8a7a64e9d22d` permanece en estado `SUCCESS`; su revisión fuente era `f6a47a212c11b70013999b3dd5a08c9eb60031cc`. Railway no incluye el SHA en los metadatos del despliegue CLI.
- El flujo productivo de CSRF, login, sesión y Dashboard se verificó correctamente. No se modificaron el backend ni MariaDB durante este cierre.
- La etiqueta anotada `v1.0.0` apunta a `99cfa42ec7ccc370ed04f86115eef8d8b27d28f4`. Release: https://github.com/devbyjuliann/backend-sigecom/releases/tag/v1.0.0
