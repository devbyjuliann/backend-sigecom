import { z } from "zod";

const passwordSchema = z
  .string()
  .min(12, "La nueva contraseña debe tener al menos 12 caracteres.")
  .max(72)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72)
  .refine((value) => /[a-z]/.test(value), "Incluye al menos una minúscula.")
  .refine((value) => /[A-Z]/.test(value), "Incluye al menos una mayúscula.")
  .refine((value) => /\d/.test(value), "Incluye al menos un número.");

export const passwordChangeSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1).max(72),
  })
  .strict()
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "La confirmación no coincide con la nueva contraseña.",
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: "La nueva contraseña debe ser diferente de la actual.",
  });

export const passwordRecoveryCompletionSchema = z
  .object({
    token: z.string().min(1).max(256),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1).max(72),
  })
  .strict()
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "La confirmación no coincide con la nueva contraseña.",
  });

export function passwordValidationMessage(error) {
  return (
    error.issues[0]?.message ||
    "La contraseña nueva no cumple la política de seguridad."
  );
}
