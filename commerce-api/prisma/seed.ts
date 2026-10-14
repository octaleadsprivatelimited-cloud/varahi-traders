import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPersistence } from "../src/persistence.js";
import { CommerceStore, seedStore } from "../src/store.js";

const db = new PrismaClient();
const persistence = new PrismaPersistence(db);
const store = new CommerceStore();
seedStore(store);

try {
  await persistence.connect();
  for (const product of store.products.values()) {
    if (!await db.product.findUnique({ where: { slug: product.slug } }))
      await persistence.saveProduct(product);
  }
  for (const coupon of store.coupons.values()) {
    if (!await db.coupon.findUnique({ where: { code: coupon.code } }))
      await persistence.saveCoupon(coupon);
  }

  const matrix: Record<string, string[]> = {
    ADMIN: ["*"],
    MANAGER: [
      "products:create",
      "products:update",
      "products:read",
      "orders:read",
      "orders:update",
      "inventory:read",
      "inventory:update",
      "settings:read",
      "support:read",
      "support:update",
      "customers:read",
      "customers:update",
      "returns:read",
      "returns:update",
    ],
    ORDER_MANAGER: ["orders:read", "orders:update", "shipping:create"],
    INVENTORY_MANAGER: ["products:read", "inventory:read", "inventory:update"],
    SUPPORT: [
      "orders:read",
      "customers:read",
      "returns:read",
      "returns:update",
      "support:read",
      "support:update",
    ],
    FINANCE: ["orders:read", "payments:read", "orders:refund", "audit:read"],
    MARKETING: ["products:read", "marketing:update", "analytics:read"],
  };
  for (const [name, keys] of Object.entries(matrix)) {
    const role = await db.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    for (const key of keys) {
      const permission = await db.permission.upsert({
        where: { key },
        update: {},
        create: { key },
      });
      await db.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
  console.log(
    JSON.stringify({
      products: store.products.size,
      coupons: store.coupons.size,
      roles: Object.keys(matrix).length,
      enumRoles: Object.keys(UserRole).length,
    }),
  );
} finally {
  await persistence.disconnect();
}
