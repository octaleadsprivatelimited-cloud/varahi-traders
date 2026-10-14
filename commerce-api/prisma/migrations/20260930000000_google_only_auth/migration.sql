-- Require fresh Google authentication for every existing account.
UPDATE `Session` SET `revokedAt` = CURRENT_TIMESTAMP(3) WHERE `revokedAt` IS NULL;
UPDATE `User` SET `authVersion` = `authVersion` + 1;
-- Historical migrations remain unchanged.
ALTER TABLE `User` DROP COLUMN `passwordHash`, DROP COLUMN `passwordEnabled`;
