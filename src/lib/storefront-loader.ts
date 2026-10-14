import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

export const loadStorefront = createServerFn({ method: "GET" }).handler(async () => {
  const { readPublicStorefront } = await import("./public-storefront-reader");
  return readPublicStorefront(getRequestUrl().hostname);
});
