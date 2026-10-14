-- Require a fresh Google assertion before assigning the sole store administrator.
UPDATE `Session` SET `revokedAt` = CURRENT_TIMESTAMP(3) WHERE `revokedAt` IS NULL;
DELETE FROM `UserRoleAssignment`;
UPDATE `User` SET `role` = 'CUSTOMER', `authVersion` = `authVersion` + 1,
  `totpEnabled` = false, `totpSecret` = NULL;
