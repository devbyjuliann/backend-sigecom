import { HttpError } from "../../shared/http-error.js";

export const POLICY_VERSION = 1;

export const ROLE_CODES = ["administrator", "seller", "warehouse", "auditor"];

const protectedPermissions = new Set([
  "dashboard.read",
  "profile.read",
  "users.read",
  "users.manage",
  "roles.manage",
  "permissions.manage",
]);

const reservedPermissions = new Set([
  "inventory.adjust",
  "inventory.transfer",
  "inventory.initialize",
  "inventory.receive",
  "settings.manage",
  "reports.read",
  "audit.read",
]);
const reservedRoleAssignments = {
  "inventory.adjust": new Set(["administrator", "warehouse"]),
  "inventory.transfer": new Set(["administrator", "warehouse"]),
  "inventory.initialize": new Set(["administrator"]),
  "inventory.receive": new Set(["administrator", "warehouse"]),
  "settings.manage": new Set(["administrator"]),
  "reports.read": new Set(["administrator", "auditor"]),
  "audit.read": new Set(["administrator", "auditor"]),
};
const protectedRoleAssignments = {
  "dashboard.read": new Set(ROLE_CODES),
  "profile.read": new Set(ROLE_CODES),
  "users.read": new Set(["administrator"]),
  "users.manage": new Set(["administrator"]),
  "roles.manage": new Set(["administrator"]),
  "permissions.manage": new Set(["administrator"]),
  "warehouses.read": new Set(["administrator"]),
};

const roleCeilings = {
  administrator: new Set([
    "categories.manage",
    "categories.read",
    "customers.manage",
    "customers.read",
    "inventory.movements.read",
    "inventory.read",
    "products.manage",
    "products.read",
    "profile.update",
    "purchases.cancel",
    "purchases.close",
    "purchases.confirm",
    "purchases.create",
    "purchases.read",
    "purchases.receive",
    "purchases.return",
    "sales.cancel",
    "sales.confirm",
    "sales.create",
    "sales.read",
    "sales.return",
    "suppliers.manage",
    "suppliers.read",
    "warehouses.manage",
  ]),
  seller: new Set([
    "categories.read",
    "customers.manage",
    "customers.read",
    "inventory.read",
    "products.read",
    "profile.update",
    "sales.confirm",
    "sales.create",
    "sales.read",
    "warehouses.read",
  ]),
  warehouse: new Set([
    "categories.read",
    "inventory.movements.read",
    "inventory.read",
    "products.read",
    "profile.update",
    "purchases.read",
    "warehouses.read",
  ]),
  auditor: new Set([
    "categories.read",
    "customers.read",
    "inventory.movements.read",
    "inventory.read",
    "products.read",
    "purchases.read",
    "sales.read",
    "suppliers.read",
    "warehouses.read",
  ]),
};

const dependencies = {
  "categories.manage": ["categories.read"],
  "customers.manage": ["customers.read"],
  "products.manage": ["products.read", "categories.read"],
  "suppliers.manage": ["suppliers.read"],
  "warehouses.manage": ["warehouses.read"],
  "purchases.create": [
    "purchases.read",
    "products.read",
    "suppliers.read",
    "warehouses.read",
  ],
  "purchases.confirm": ["purchases.read", "purchases.create"],
  "purchases.receive": ["purchases.read", "purchases.confirm"],
  "purchases.cancel": ["purchases.read", "purchases.create"],
  "purchases.close": ["purchases.read", "purchases.confirm"],
  "purchases.return": ["purchases.read", "purchases.receive"],
  "sales.create": [
    "sales.read",
    "customers.read",
    "products.read",
    "warehouses.read",
    "inventory.read",
  ],
  "sales.confirm": [
    "sales.create",
    "sales.read",
    "customers.read",
    "products.read",
    "warehouses.read",
    "inventory.read",
  ],
  "sales.cancel": ["sales.read"],
  "sales.return": ["sales.read", "inventory.read"],
};

const knownPermissions = new Set([
  ...protectedPermissions,
  ...reservedPermissions,
  ...Object.values(roleCeilings).flatMap((permissions) => [...permissions]),
]);

const protectedReasons = {
  "dashboard.read": "Permite entrar al área privada común de SIGECOM.",
  "profile.read": "Conserva el acceso al perfil y a la seguridad de la cuenta.",
  "users.read": "Es indispensable para administrar y recuperar cuentas.",
  "users.manage": "Es indispensable para mantener las cuentas operativas.",
  "roles.manage":
    "Es indispensable para mantener la asignación administrativa de roles.",
  "permissions.manage":
    "Es indispensable para administrar la política de accesos.",
};

const reservedReasons = {
  "inventory.adjust":
    "Operación histórica no habilitada para escritura pública.",
  "inventory.transfer":
    "Operación histórica no habilitada para escritura pública.",
  "inventory.initialize":
    "La inicialización pública de existencias está retirada.",
  "inventory.receive": "Las recepciones aprobadas pertenecen a Compras.",
  "settings.manage":
    "No existe una función operativa de configuración en este incremento.",
  "reports.read": "El módulo de Reportes no está implementado.",
  "audit.read": "La consulta del módulo de Auditoría no está implementada.",
};

export function classifyPermission(roleCode, permissionCode) {
  if (!knownPermissions.has(permissionCode)) {
    return {
      category: "incompatible",
      compatible: false,
      reason: "El permiso no está registrado en la política de 6.1C.",
      dependencies: [],
    };
  }
  if (permissionCode === "warehouses.read" && roleCode === "administrator") {
    return {
      category: "protected",
      compatible: true,
      reason:
        "Es indispensable para consultar el alcance de las asignaciones administrativas.",
      dependencies: [],
    };
  }
  if (protectedPermissions.has(permissionCode)) {
    return {
      category: "protected",
      compatible:
        roleCode === "administrator" ||
        ["dashboard.read", "profile.read"].includes(permissionCode),
      reason: protectedReasons[permissionCode],
      dependencies: [],
    };
  }
  if (reservedPermissions.has(permissionCode)) {
    return {
      category: "reserved",
      compatible: reservedRoleAssignments[permissionCode].has(roleCode),
      reason: reservedReasons[permissionCode],
      dependencies: [],
    };
  }
  const compatible = Boolean(roleCeilings[roleCode]?.has(permissionCode));
  return {
    category: compatible ? "configurable" : "incompatible",
    compatible,
    reason: compatible
      ? null
      : "Este permiso excede las capacidades aprobadas para el rol.",
    dependencies: dependencies[permissionCode] || [],
  };
}

export function validatePermissionSet(roleCode, codes) {
  if (!ROLE_CODES.includes(roleCode)) {
    throw new HttpError(
      404,
      "ROLE_NOT_FOUND",
      "No se encontró el rol solicitado.",
    );
  }
  const selected = new Set(codes);
  for (const code of codes) {
    if (!knownPermissions.has(code)) {
      throw new HttpError(
        400,
        "ROLE_PERMISSION_UNKNOWN",
        "Uno o más permisos no existen en la política.",
      );
    }
    const classification = classifyPermission(roleCode, code);
    if (classification.category !== "configurable") {
      throw new HttpError(
        400,
        classification.category === "reserved"
          ? "ROLE_PERMISSION_RESERVED"
          : "ROLE_PERMISSION_INCOMPATIBLE",
        classification.reason ||
          "El permiso no puede configurarse para este rol.",
      );
    }
  }
  for (const [code, roles] of Object.entries(protectedRoleAssignments)) {
    if (roles.has(roleCode)) selected.add(code);
  }
  for (const [code, roles] of Object.entries(reservedRoleAssignments)) {
    if (roles.has(roleCode)) selected.add(code);
  }
  for (const code of codes) {
    const missing = (dependencies[code] || []).filter(
      (dependency) => !selected.has(dependency),
    );
    if (missing.length) {
      throw new HttpError(
        400,
        "ROLE_PERMISSION_DEPENDENCY_MISSING",
        `El permiso ${code} requiere: ${missing.join(", ")}.`,
      );
    }
  }
  return [];
}

export function configurablePermissions(roleCode) {
  return [...(roleCeilings[roleCode] || [])].sort();
}
