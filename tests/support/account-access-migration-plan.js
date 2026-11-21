export async function applyLegacyCompatibleMigrations({
  migrations,
  applyMigration,
  seedLegacyFixtures,
  verifyLegacyState,
}) {
  for (const migration of migrations.slice(0, 17)) {
    await applyMigration(migration);
  }

  await seedLegacyFixtures();
  await applyMigration(migrations[17]);
  await verifyLegacyState();
  await applyMigration(migrations[18]);
}
