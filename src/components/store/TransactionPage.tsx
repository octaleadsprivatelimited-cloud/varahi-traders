import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, Clock3, Download, Package, RefreshCw, RotateCcw } from "lucide-react";
import { commerceApi, commerceDownload, CommerceApiError } from "@/lib/commerce-api";
import { customerTransactionPath, confirmedOrLatestPayment, settledRefundAmount, transactionState, type CustomerPayment } from "@/lib/transactions";
import type { CustomerOrder } from "../portal/customer-service/types";
import { StorePage } from "./StoreHeader";

const currency = (amount: number, code = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency: code }).format(amount);
const date = (value: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export function TransactionPage({ orderNumber }: { orderNumber: string }) {
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [signin, setSignin] = useState(false), [downloading, setDownloading] = useState(false);
  const [checkedAt, setCheckedAt] = useState("");
  const sequence = useRef(0);
  const cancelRequests = useCallback(() => { ++sequence.current; }, []);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setBusy(true); setError(""); setSignin(false);
    try {
      const [orders, history] = await Promise.all([
        commerceApi<CustomerOrder[]>("/api/v1/account/orders"), commerceApi<CustomerPayment[]>("/api/v1/account/payments"),
      ]);
      if (request !== sequence.current) return;
      setOrder(orders.find(item => item.number === orderNumber) || null);
      setPayments(history.filter(item => item.orderNumber === orderNumber).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setCheckedAt(new Date().toISOString());
    } catch (reason) {
      if (request !== sequence.current) return;
      if (reason instanceof CommerceApiError && reason.status === 401) { setSignin(true); setOrder(null); setPayments([]); }
      setError(reason instanceof Error ? reason.message : "Transaction details could not be loaded");
    } finally { if (request === sequence.current) { setLoading(false); setBusy(false); } }
  }, [orderNumber]);
  useEffect(() => { setLoading(true); void load(); return cancelRequests; }, [load, cancelRequests]);
  const download = async () => {
    if (!order) return;
    setDownloading(true);
    try {
      const blob = await commerceDownload(`/api/v1/orders/${order.id}/invoice`);
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `invoice-${order.number}.pdf`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invoice could not be downloaded"); }
    finally { setDownloading(false); }
  };
  const payment = confirmedOrLatestPayment(payments);
  const state = transactionState(payment?.status || order?.payment?.status, order?.status || "");
  const Icon = state.kind === "success" ? CheckCircle2 : state.kind === "failed" ? AlertCircle : state.kind === "refunded" ? RotateCcw : state.kind === "cod" ? Package : Clock3;
  return <StorePage><main className="transaction-page" data-clarity-mask="true">
    {loading ? <section className="transaction-state" role="status"><RefreshCw className="spin" /><h1>Loading transaction…</h1><p>Checking your order and payment records.</p></section> : signin ? <section className="transaction-state"><Package /><h1>Sign in to view this transaction.</h1><p>Use the Google account you placed this order with.</p><a href={`/login?returnTo=${encodeURIComponent(customerTransactionPath(orderNumber))}`}>Continue with Google</a></section> : !order ? <section className="transaction-state"><AlertCircle /><h1>{error ? "Transaction could not be loaded." : "Transaction not found."}</h1><p>{error || "This order is not available in your account. Check the order number or open your order history."}</p>{error && <button type="button" onClick={() => void load()} disabled={busy}>Try again</button>}<Link to="/account" search={{ tab: "My orders" }}>My orders</Link></section> : <>
      <section className={`transaction-state transaction-${state.kind}`}><Icon /><p className="eyebrow">Order #{order.number}</p><h1>{state.title}</h1><p>{state.message}</p>
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={() => void load()} disabled={busy}><RefreshCw />{busy ? "Checking…" : "Refresh status"}</button><button type="button" onClick={() => void download()} disabled={downloading}><Download />{downloading ? "Downloading…" : "Invoice PDF"}</button><Link to="/account" search={{ tab: "My orders" }}>My orders</Link>
        <p><small>Last checked {date(checkedAt)}</small></p>
      </section>
      <div className="transaction-grid"><section><h2>Order summary</h2><dl>
        <dt>Order ID</dt><dd>#{order.number}</dd><dt>Placed</dt><dd>{date(order.createdAt)}</dd><dt>Order status</dt><dd>{order.status.replaceAll("_", " ")}</dd>
        <dt>Subtotal</dt><dd>{currency(order.subtotal || 0, order.currency)}</dd><dt>Discount</dt><dd>−{currency(order.discount || 0, order.currency)}</dd><dt>Tax</dt><dd>{currency(order.tax || 0, order.currency)}</dd><dt>Delivery</dt><dd>{currency(order.shipping || 0, order.currency)}</dd><dt>Total</dt><dd><strong>{currency(order.total, order.currency)}</strong></dd>
      </dl></section><section><h2>Payment details</h2><dl>
        <dt>Method</dt><dd>{payment?.provider || order.payment?.provider || "No online payment"}</dd><dt>Payment status</dt><dd>{(payment?.status || order.payment?.status || "Not recorded").replaceAll("_", " ")}</dd>
        <dt>Transaction ID</dt><dd>{payment?.transactionId || "Not issued"}</dd><dt>Gateway reference</dt><dd>{payment?.providerReference || "Not issued"}</dd>
        <dt>Refunded</dt><dd>{currency(payments.reduce((sum, item) => sum + settledRefundAmount(item), 0), order.currency)}</dd>
      </dl>{payment?.events.length ? <ul className="transaction-events">{payment.events.map(event => <li key={event.id}>{event.type.replaceAll("_", " ")}{event.errorDescription && <> · {event.errorDescription}</>}<small>{date(event.createdAt)}</small></li>)}</ul> : null}</section></div>
      {payments.length > 1 && <div className="transaction-attempts">{payments.map(item => <article className="transaction-attempt" key={item.id}><div><h3>{item.status.replaceAll("_", " ")} · {currency(item.amount, item.currency)}</h3><p>{date(item.createdAt)} · {item.providerReference || "Awaiting gateway reference"}</p></div></article>)}</div>}
      {payments.flatMap(item => item.refunds).length > 0 && <div className="transaction-grid"><section><h2>Refund records</h2>{payments.flatMap(item => item.refunds).map(refund => <p key={refund.id}>{currency(refund.amount, order.currency)} · {refund.status} · {refund.reference || "Awaiting reference"}</p>)}</section></div>}
      <div className="not-found-actions"><Link to="/shop">Continue shopping</Link><Link to="/contact">Contact support</Link></div>
    </>}
  </main></StorePage>;
}
