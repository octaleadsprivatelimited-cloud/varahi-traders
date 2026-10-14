import { describe, expect, it } from "vitest";
import {
  renderEmailNotification,
  renderSmsNotification,
} from "../src/notification-content.js";

describe("authentication notification content", () => {
  it("renders a branded welcome email and escapes customer-controlled text", () => {
    const content = renderEmailNotification("account.registered", {
      name: '<Admin & "Owner">',
      storeName: "Example <Store>",
    });
    expect(content.subject).toBe("Welcome to Example <Store>");
    expect(content.text).toContain('Welcome <Admin & "Owner">');
    expect(content.html).toContain(
      "Welcome &lt;Admin &amp; &quot;Owner&quot;&gt;",
    );
    expect(content.html).toContain("Example &lt;Store&gt;");
    expect(content.html).not.toContain("<Admin");
  });

  it("renders a useful branded OTP SMS without accepting malformed codes", () => {
    expect(
      renderSmsNotification("auth.mobile_otp", {
        code: "123456",
        expiresInMinutes: 5,
        storeName: "Customer Store",
      }),
    ).toBe(
      "123456 is your Customer Store verification code. It expires in 5 minutes. Do not share it.",
    );
    expect(() =>
      renderSmsNotification("auth.mobile_otp", {
        code: "12<script>",
        expiresInMinutes: 5,
      }),
    ).toThrow("invalid code");
  });
});

describe("order confirmation email", () => {
  it("includes order, delivery, business, item and complete charges with escaped HTML", () => {
    const content = renderEmailNotification("order.confirmed", {
      storeName: "Sri Varahi Traders", orderId: "internal-order-id", orderNumber: "RU-2026-42", currency: "INR",
      customer: { name: '<Buyer & "Family">', email: "buyer@example.com", phone: "+919876543210" },
      address: "12 Main Road, Hyderabad, Telangana, 500081, IN", paymentLabel: "Cash on delivery — payable on delivery",
      business: { legalName: "Sri Varahi Traders Foods", address: "Business Road", gstin: "TEST-GST", email: "support@example.com", phone: "+919999999999" },
      items: [{ name: "Turmeric <Pure>", sku: "TUR-100", quantity: 2, unitPrice: 100 }],
      charges: { subtotal: 200, discount: 20, shipping: 40, tax: 10, total: 230 },
    });
    for (const value of ["RU-2026-42", "internal-order-id", "+919876543210", "500081", "Sri Varahi Traders Foods", "Business Road", "TEST-GST", "support@example.com", "TUR-100", "INR 200.00", "-INR 20.00", "INR 40.00", "INR 10.00", "INR 230.00", "payable on delivery"]) expect(content.text).toContain(value);
    expect(content.html).toContain("&lt;Buyer &amp; &quot;Family&quot;&gt;");
    expect(content.html).toContain("Turmeric &lt;Pure&gt;");
    expect(content.html).not.toContain("<Buyer");
  });
});
