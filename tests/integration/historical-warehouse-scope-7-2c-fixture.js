export function trackReaderRole(fixture, roleId) {
  const id = String(roleId);
  fixture.roleIds.push(id);
  fixture.readerRoleId = id;
  return id;
}
