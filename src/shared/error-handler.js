import { ZodError } from "zod";
import { HttpError } from "./http-error.js";

export function createErrorHandler(logger) {
  return (error, request, response, _next) => {
    if (response.headersSent) return;

    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Ocurrió un error interno.";

    if (error instanceof HttpError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (
      error instanceof ZodError ||
      error.type === "entity.parse.failed"
    ) {
      status = 400;
      code = "INVALID_REQUEST";
      message = "La solicitud no cumple el formato esperado.";
    } else if (error.type === "entity.too.large") {
      status = 413;
      code = "REQUEST_TOO_LARGE";
      message = "La solicitud supera el tamaño permitido.";
    }

    const fields = {
      requestId: request.requestId,
      status,
      code,
    };
    if (status >= 500) logger.error(fields, "request failed");
    else logger.warn(fields, "request rejected");

    response.status(status).json({
      error: {
        code,
        message,
        requestId: request.requestId,
      },
    });
  };
}

export function notFoundHandler() {
  return (_request, _response, next) => {
    next(
      new HttpError(404, "NOT_FOUND", "No se encontró el recurso solicitado."),
    );
  };
}
