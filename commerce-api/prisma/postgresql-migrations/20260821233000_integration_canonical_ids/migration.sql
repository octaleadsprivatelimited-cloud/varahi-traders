-- Integration records use their normalized kind/provider/environment identity
-- as the durable key. This prevents case variants such as Razorpay/razorpay
-- from producing duplicate administrator cards or ambiguous runtime selection.
ALTER TABLE "IntegrationConfig" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "IntegrationConfig" ALTER COLUMN "id" TYPE TEXT USING "id"::text;

WITH normalized AS (
  SELECT
    "id",
    CASE
      WHEN trim(both '-' from regexp_replace(lower(trim("provider")), '[^a-z0-9]+', '-', 'g')) IN ('whatsapp', 'whatsapp-cloud-api') THEN 'whatsapp-cloud'
      WHEN trim(both '-' from regexp_replace(lower(trim("provider")), '[^a-z0-9]+', '-', 'g')) IN ('ga4', 'google-analytics-4') THEN 'google-analytics'
      ELSE trim(both '-' from regexp_replace(lower(trim("provider")), '[^a-z0-9]+', '-', 'g'))
    END AS provider_slug
  FROM "IntegrationConfig"
), ranked AS (
  SELECT
    config."id",
    row_number() OVER (
      PARTITION BY config."kind", normalized.provider_slug, config."environment"
      ORDER BY
        CASE WHEN config."provider" = normalized.provider_slug THEN 0 ELSE 1 END,
        config."updatedAt" DESC,
        config."id" ASC
    ) AS duplicate_rank
  FROM "IntegrationConfig" AS config
  JOIN normalized ON normalized."id" = config."id"
)
DELETE FROM "IntegrationConfig"
WHERE "id" IN (
  SELECT "id" FROM ranked WHERE duplicate_rank > 1
);

WITH normalized AS (
  SELECT
    "id",
    CASE
      WHEN trim(both '-' from regexp_replace(lower(trim("provider")), '[^a-z0-9]+', '-', 'g')) IN ('whatsapp', 'whatsapp-cloud-api') THEN 'whatsapp-cloud'
      WHEN trim(both '-' from regexp_replace(lower(trim("provider")), '[^a-z0-9]+', '-', 'g')) IN ('ga4', 'google-analytics-4') THEN 'google-analytics'
      ELSE trim(both '-' from regexp_replace(lower(trim("provider")), '[^a-z0-9]+', '-', 'g'))
    END AS provider_slug
  FROM "IntegrationConfig"
)
UPDATE "IntegrationConfig" AS config
SET
  "provider" = normalized.provider_slug,
  "id" = config."kind"::text || ':' || normalized.provider_slug || ':' || config."environment"
FROM normalized
WHERE normalized."id" = config."id";
