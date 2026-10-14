import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaPersistence } from "../src/persistence.js";
import type { StoredUser } from "../src/store.js";

const customer: StoredUser = {
  id: "f6aa50e2-5e73-47c6-9c0d-15c68c095e1b",
  name: "Persisted Google Customer",
  email: "persisted@example.com",
  role: "CUSTOMER",
  permissions: [],
};

function persistedUser(user: StoredUser = customer) {
  const now = new Date();
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    mobile: null,
    role: user.role,
    totpEnabled: false,
    totpSecret: null,
    tags: [],
    note: null,
    marketingConsent: false,
    marketingConsentUpdatedAt: null,
    disabledAt: null,
    authVersion: 0,
    createdAt: now,
    updatedAt: now,
    roleAssignments: [],
  };
}

describe("Google identity persistence", () => {
  it("creates the user and stable subject in one transaction", async () => {
    const tx = {
      user: { create: vi.fn(async () => persistedUser()) },
      authIdentity: { create: vi.fn(async () => ({})) },
    };
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const persistence = new PrismaPersistence(db as never);

    await expect(
      persistence.saveGoogleUser(
        customer,
        "stable-google-subject",
        customer.email,
        "persisted-client.apps.googleusercontent.com",
      ),
    ).resolves.toEqual(customer);
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: customer.id,
        email: customer.email,
        verifiedAt: expect.any(Date),
      }),
    });
    expect(tx.authIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: customer.id,
        provider: "google",
        subject: "stable-google-subject",
        audience: "persisted-client.apps.googleusercontent.com",
      }),
    });
  });

  it("loads by provider subject and verifies destructive reauthentication ownership", async () => {
    const db = {
      authIdentity: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "identity-1", userId: customer.id })
          .mockResolvedValueOnce({ userId: customer.id })
          .mockResolvedValueOnce({ userId: "another-user" })
          .mockResolvedValueOnce({
            userId: customer.id,
            provider: "google",
            subject: "stable-google-subject",
            audience: "stored-client.apps.googleusercontent.com",
            email: customer.email,
          }),
        update: vi.fn(async () => ({})),
      },
      user: { findFirst: vi.fn(async () => persistedUser()) },
    };
    const persistence = new PrismaPersistence(db as never);

    await expect(
      persistence.findAuthUserByIdentity(
        "google",
        "stable-google-subject",
        "changed@example.com",
      ),
    ).resolves.toMatchObject({
      id: customer.id,
      role: "CUSTOMER",
    });
    expect(db.authIdentity.update).toHaveBeenCalledWith({
      where: { id: "identity-1" },
      data: {
        lastAuthenticatedAt: expect.any(Date),
        email: "changed@example.com",
      },
    });
    await expect(
      persistence.userHasAuthIdentity(
        customer.id,
        "google",
        "stable-google-subject",
      ),
    ).resolves.toBe(true);
    await expect(
      persistence.userHasAuthIdentity(
        customer.id,
        "google",
        "attacker-subject",
      ),
    ).resolves.toBe(false);
    await expect(
      persistence.getUserAuthIdentity(customer.id, "google"),
    ).resolves.toMatchObject({
      subject: "stable-google-subject",
      audience: "stored-client.apps.googleusercontent.com",
    });
  });

  it("turns a concurrent duplicate-email insert into an explicit linking requirement", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
    });
    const db = {
      $transaction: vi.fn(async () => {
        throw duplicate;
      }),
      authIdentity: { findUnique: vi.fn(async () => null) },
    };
    const persistence = new PrismaPersistence(db as never);

    await expect(
      persistence.saveGoogleUser(
        customer,
        "unlinked-google-subject",
        customer.email,
        "persisted-client.apps.googleusercontent.com",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "GOOGLE_ACCOUNT_LINK_REQUIRED",
    });
  });

  it("links idempotently and rejects provider-subject ownership conflicts", async () => {
    const linked = {
      userId: customer.id,
      provider: "google",
      subject: "linked-subject",
      audience: "linked-client.apps.googleusercontent.com",
      email: customer.email,
    };
    const createDb = {
      authIdentity: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => data),
        update: vi.fn(),
      },
    };
    const createPersistence = new PrismaPersistence(createDb as never);
    await expect(createPersistence.linkAuthIdentity(linked)).resolves.toMatchObject(
      linked,
    );
    expect(createDb.authIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining(linked),
      }),
    );

    const idempotentDb = {
      authIdentity: {
        findUnique: vi.fn(async () => ({
          id: "identity-1",
          userId: customer.id,
        })),
        update: vi.fn(async () => linked),
      },
    };
    const idempotentPersistence = new PrismaPersistence(
      idempotentDb as never,
    );
    await expect(
      idempotentPersistence.linkAuthIdentity(linked),
    ).resolves.toMatchObject(linked);
    expect(idempotentDb.authIdentity.update).toHaveBeenCalledTimes(1);

    const conflictDb = {
      authIdentity: {
        findUnique: vi.fn(async () => ({
          id: "identity-2",
          userId: "another-user",
        })),
        update: vi.fn(),
      },
    };
    const conflictPersistence = new PrismaPersistence(conflictDb as never);
    await expect(
      conflictPersistence.linkAuthIdentity(linked),
    ).rejects.toMatchObject({
      status: 409,
      code: "GOOGLE_IDENTITY_IN_USE",
    });
    expect(conflictDb.authIdentity.update).not.toHaveBeenCalled();
  });
});
