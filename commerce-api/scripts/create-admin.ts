import { SINGLE_ADMIN_EMAIL } from "../src/auth-policy.js";

// Admin access is assigned only after Firebase verifies the allowlisted account.
console.log(`Sign in with Google as ${SINGLE_ADMIN_EMAIL} at /login. No separate administrator account or password is required.`);
