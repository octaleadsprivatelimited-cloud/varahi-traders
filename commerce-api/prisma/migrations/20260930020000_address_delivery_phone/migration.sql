-- Keep existing addresses intact; delivery phone is optional on legacy records.
ALTER TABLE `Address` ADD COLUMN `phone` VARCHAR(16) NULL;
