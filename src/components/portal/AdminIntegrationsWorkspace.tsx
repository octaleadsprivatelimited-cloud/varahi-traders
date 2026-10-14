import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Code2,
  CreditCard,
  KeyRound,
  Mail,
  MessageSquare,
  Package,
  RefreshCw,
  Save,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommerceApiError, commerceApi } from "@/lib/commerce-api";

type IntegrationEnvironment = "TEST" | "LIVE";
type IntegrationKind =
  | "PAYMENT"
  | "SHIPPING"
  | "EMAIL"
  | "SMS"
  | "WHATSAPP"
  | "STORAGE"
  | "ANALYTICS"
  | "AUTH";
type TestOutcome =
  | "CONNECTED"
  | "FAILED"
  | "UNSUPPORTED"
  | "UNCONFIGURED"
  | "DISCONNECTED"
  | "UNTESTED";

type IntegrationTest = {
  outcome: TestOutcome;
  testedAt?: string;
  message?: string;
};

type CredentialField = {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
  masked?: string;
};

type PublicConfigField = {
  key: string;
  label: string;
  required: boolean;
};

type IntegrationDto = {
  id: string;
  kind: IntegrationKind;
  provider: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  environment: IntegrationEnvironment;
  publicConfig: Record<string, unknown>;
  updatedAt?: string;
  configured: boolean;
  connected: boolean;
  status: string;
  maskedCredentials: Record<string, string>;
  credentialFields: CredentialField[];
  requiredPublicConfig: PublicConfigField[];
  capabilities: {
    liveOperations: boolean;
    testConnection: boolean;
    webhooks: boolean;
    disconnect: boolean;
  };
  lastTest?: IntegrationTest;
};

type IntegrationListResponse = {
  items: IntegrationDto[];
  environment: IntegrationEnvironment;
};

type FirebaseStatus = {
  enabled: boolean;
  projectId: string;
  authDomain: string;
};

type IntegrationTestResponse = IntegrationDto & {
  test: IntegrationTest;
};

type IntegrationFilter =
  | "ALL"
  | "PAYMENT"
  | "SHIPPING"
  | "COMMUNICATION"
  | "AUTH"
  | "ANALYTICS"
  | "STORAGE";

type Notice = {
  tone: "success" | "warning" | "error";
  message: string;
};

const filters: Array<{ value: IntegrationFilter; label: string }> = [
  { value: "ALL", label: "All integrations" },
  { value: "PAYMENT", label: "Payments" },
  { value: "SHIPPING", label: "Shipping" },
  { value: "COMMUNICATION", label: "Communication" },
  { value: "AUTH", label: "Authentication" },
  { value: "ANALYTICS", label: "Analytics" },
  { value: "STORAGE", label: "Storage" },
];

const kindLabels: Record<IntegrationKind, string> = {
  PAYMENT: "Payment",
  SHIPPING: "Shipping",
  EMAIL: "Email",
  SMS: "SMS",
  WHATSAPP: "Messaging",
  STORAGE: "Storage",
  ANALYTICS: "Analytics",
  AUTH: "Authentication",
};

const kindColors: Record<IntegrationKind, string> = {
  PAYMENT: "#4865d5",
  SHIPPING: "#7153c5",
  EMAIL: "#222826",
  SMS: "#2e8299",
  WHATSAPP: "#31a45d",
  STORAGE: "#6b7280",
  ANALYTICS: "#d38b22",
  AUTH: "#4285f4",
};

function ProviderIcon({ kind }: { kind: IntegrationKind }) {
  if (kind === "PAYMENT") return <CreditCard />;
  if (kind === "SHIPPING") return <Truck />;
  if (kind === "EMAIL") return <Mail />;
  if (kind === "SMS" || kind === "WHATSAPP") return <MessageSquare />;
  if (kind === "STORAGE") return <Package />;
  if (kind === "ANALYTICS") return <Activity />;
  if (kind === "AUTH") return <KeyRound />;
  return <Code2 />;
}

function matchesFilter(item: IntegrationDto, filter: IntegrationFilter) {
  if (filter === "ALL") return true;
  if (filter === "COMMUNICATION")
    return ["EMAIL", "SMS", "WHATSAPP"].includes(item.kind);
  return item.kind === filter;
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatDate(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function publicConfigValues(item: IntegrationDto) {
  return Object.fromEntries(
    Object.entries(item.publicConfig).map(([key, value]) => [
      key,
      value === null || value === undefined
        ? ""
        : typeof value === "string"
          ? value
          : String(value),
    ]),
  );
}

function credentialPlaceholder(field: CredentialField) {
  if (!field.configured) return field.required ? "Required" : "Optional";
  return `${field.masked || "Stored securely"} — leave blank to keep`;
}

function isPublicOnlyActive(item: IntegrationDto) {
  return (
    item.enabled &&
    item.configured &&
    item.credentialFields.length === 0 &&
    item.capabilities.liveOperations &&
    !item.capabilities.testConnection
  );
}

function isBrowserAnalytics(item: IntegrationDto) {
  return item.kind === "ANALYTICS" &&
    ["google-analytics", "meta-pixel", "microsoft-clarity"].includes(item.provider) &&
    item.credentialFields.length === 0 && !item.capabilities.testConnection;
}

export function AdminIntegrationsWorkspace() {
  const [environment, setEnvironment] =
    useState<IntegrationEnvironment>(() =>
      import.meta.env.PROD ? "LIVE" : "TEST",
    );
  const [filter, setFilter] = useState<IntegrationFilter>("ALL");
  const [items, setItems] = useState<IntegrationDto[]>([]);
  const [firebaseStatus, setFirebaseStatus] = useState<FirebaseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [priority, setPriority] = useState(1);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [publicConfig, setPublicConfig] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<"save" | "test" | "disconnect" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const requestIdRef = useRef(0);
  const busyActionRef = useRef<"save" | "test" | "disconnect" | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const selected = items.find((item) => item.id === selectedId) || null;

  const load = useCallback(
    async (silent = false) => {
      const requestId = ++requestIdRef.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setLoadError("");
      setAuthRequired(false);
      setForbidden(false);
      try {
        const [result, providers] = await Promise.all([
          commerceApi<IntegrationListResponse>(
            `/api/v1/admin/integrations?environment=${environment}`,
          ),
          commerceApi<{ firebase: FirebaseStatus }>("/api/v1/auth/providers")
            .catch(() => null),
        ]);
        if (requestId !== requestIdRef.current) return;
        setItems(result.items);
        setFirebaseStatus(providers?.firebase || null);
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        if (error instanceof CommerceApiError && error.status === 401)
          setAuthRequired(true);
        if (error instanceof CommerceApiError && error.status === 403)
          setForbidden(true);
        setLoadError(
          error instanceof Error
            ? error.message
            : "Integrations could not be loaded",
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [environment],
  );

  useEffect(() => {
    setSelectedId(null);
    void load();
  }, [load]);

  const closeDialog = useCallback(() => {
    if (busyActionRef.current) return;
    setSelectedId(null);
    setNotice(null);
    setConfirmDisconnect(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [
        ...modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!modalRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeDialog, selectedId]);

  const visible = useMemo(
    () =>
      items
        .filter((item) => matchesFilter(item, filter))
        .sort(
          (left, right) =>
            Number(right.connected) - Number(left.connected) ||
            Number(right.configured) - Number(left.configured) ||
            left.priority - right.priority ||
            left.name.localeCompare(right.name),
        ),
    [filter, items],
  );

  const summary = useMemo(
    () => ({
      configured: items.filter((item) => item.configured).length,
      connected: items.filter((item) => item.connected && !isBrowserAnalytics(item)).length,
      enabled: items.filter((item) => item.enabled).length,
    }),
    [items],
  );

  const publicFields = useMemo(() => {
    if (!selected) return [];
    const definitions = new Map(
      selected.requiredPublicConfig.map((field) => [field.key, field]),
    );
    for (const key of Object.keys(selected.publicConfig))
      if (!definitions.has(key))
        definitions.set(key, { key, label: humanize(key), required: false });
    return [...definitions.values()];
  }, [selected]);

  const missingCredential = enabled
    ? selected?.credentialFields.find(
        (field) =>
          field.required && !field.configured && !credentials[field.key]?.trim(),
      )
    : undefined;
  const missingPublicConfig = enabled
    ? publicFields.find(
        (field) => field.required && !publicConfig[field.key]?.trim(),
      )
    : undefined;
  const invalidPriority = !Number.isInteger(priority) || priority < 1 || priority > 1000;
  const validationMessage = missingCredential
    ? `${missingCredential.label} is required.`
    : missingPublicConfig
      ? `${missingPublicConfig.label} is required.`
      : invalidPriority
        ? "Priority must be a whole number between 1 and 1000."
        : "";

  const hasCredentialChanges = Object.values(credentials).some((value) =>
    value.trim(),
  );
  const publicConfigDirty = selected
    ? [...new Set([...Object.keys(selected.publicConfig), ...Object.keys(publicConfig)])].some(
        (key) =>
          (publicConfig[key] || "") !==
          (publicConfigValues(selected)[key] || ""),
      )
    : false;
  const formDirty = Boolean(
    selected &&
      (enabled !== selected.enabled ||
        priority !== selected.priority ||
        hasCredentialChanges ||
        publicConfigDirty),
  );

  const openItem = (item: IntegrationDto, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setSelectedId(item.id);
    setEnabled(item.capabilities.liveOperations && item.enabled);
    setPriority(item.priority);
    setCredentials({});
    setPublicConfig(publicConfigValues(item));
    setNotice(null);
    setConfirmDisconnect(false);
  };

  const upsertItem = (item: IntegrationDto) => {
    setItems((current) => {
      const found = current.some((candidate) => candidate.id === item.id);
      return found
        ? current.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [...current, item];
    });
    setSelectedId((current) => (current ? item.id : current));
  };

  const save = async () => {
    if (!selected || validationMessage) return;
    busyActionRef.current = "save";
    setBusyAction("save");
    setNotice(null);
    try {
      const enteredCredentials = Object.fromEntries(
        Object.entries(credentials)
          .map(([key, value]) => [key, value.trim()])
          .filter(([, value]) => value.length > 0),
      );
      const saved = await commerceApi<IntegrationDto>(
        "/api/v1/admin/integrations",
        {
          method: "PUT",
          body: JSON.stringify({
            kind: selected.kind,
            provider: selected.provider,
            enabled,
            priority,
            environment: selected.environment,
            ...(Object.keys(enteredCredentials).length
              ? { credentials: enteredCredentials }
              : {}),
            ...(Object.keys(publicConfig).length ? { publicConfig } : {}),
          }),
        },
      );
      upsertItem(saved);
      setEnabled(saved.enabled);
      setPriority(saved.priority);
      setPublicConfig(publicConfigValues(saved));
      setCredentials({});
      setNotice({
        tone: "success",
        message: `${saved.name} was saved. Stored secrets were preserved unless you supplied replacements.`,
      });
      toast.success(`${saved.name} configuration saved`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Integration could not be saved";
      setNotice({ tone: "error", message });
      toast.error(message);
    } finally {
      busyActionRef.current = null;
      setBusyAction(null);
    }
  };

  const testConnection = async () => {
    if (!selected || !selected.capabilities.testConnection) return;
    busyActionRef.current = "test";
    setBusyAction("test");
    setNotice(null);
    try {
      const result = await commerceApi<IntegrationTestResponse>(
        `/api/v1/admin/integrations/${encodeURIComponent(selected.id)}/test`,
        { method: "POST" },
      );
      upsertItem(result);
      const connected = result.test.outcome === "CONNECTED";
      const message =
        result.test.message ||
        (connected
          ? "The provider accepted the live connection test."
          : `Connection test returned ${humanize(result.test.outcome).toLowerCase()}.`);
      setNotice({
        tone: connected
          ? "success"
          : result.test.outcome === "UNSUPPORTED"
            ? "warning"
            : "error",
        message,
      });
      if (connected) toast.success(`${selected.name} connection verified`);
      else toast.warning(message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection test failed";
      setNotice({ tone: "error", message });
      toast.error(message);
    } finally {
      busyActionRef.current = null;
      setBusyAction(null);
    }
  };

  const disconnect = async () => {
    if (!selected || !selected.capabilities.disconnect) return;
    busyActionRef.current = "disconnect";
    setBusyAction("disconnect");
    setNotice(null);
    try {
      const disconnected = await commerceApi<IntegrationDto>(
        `/api/v1/admin/integrations/${encodeURIComponent(selected.id)}/disconnect`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation: "DISCONNECT" }),
        },
      );
      upsertItem(disconnected);
      setEnabled(disconnected.enabled);
      setPriority(disconnected.priority);
      setPublicConfig(publicConfigValues(disconnected));
      setCredentials({});
      setConfirmDisconnect(false);
      setNotice({
        tone: "success",
        message: `${disconnected.name} is disconnected, disabled, and its stored credentials have been cleared.`,
      });
      toast.success(`${disconnected.name} disconnected`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Disconnect failed";
      setNotice({ tone: "error", message });
      toast.error(message);
    } finally {
      busyActionRef.current = null;
      setBusyAction(null);
    }
  };

  if (loading && !items.length)
    return (
      <section className="panel integration-page-state" aria-live="polite">
        <RefreshCw className="spin" />
        <h2>Loading integrations</h2>
        <p>Reading safe provider status and masked credential metadata.</p>
      </section>
    );

  if (authRequired && !items.length)
    return (
      <section className="panel integration-page-state">
        <ShieldCheck />
        <h2>Administrator sign-in required</h2>
        <p>{loadError}</p>
        <a className="primary" href="/login">
          Sign in
        </a>
      </section>
    );

  if (forbidden && !items.length)
    return (
      <section className="panel integration-page-state">
        <ShieldCheck />
        <h2>Settings access required</h2>
        <p>Your staff role does not have permission to view integrations.</p>
      </section>
    );

  return (
    <div className="integration-workspace">
      <div className="editor-top integration-heading">
        <div>
          <p className="portal-eyebrow">Settings</p>
          <h2>Integrations</h2>
          <span>
            Manage provider credentials without exposing stored secrets to the
            browser.
          </span>
        </div>
        <div className="integration-heading-actions">
          <div
            className={`integration-environment ${environment.toLowerCase()}`}
            aria-label="Environment"
          >
            {(["TEST", "LIVE"] as const).map((value) => (
              <button
                type="button"
                className={environment === value ? "active" : ""}
                aria-pressed={environment === value}
                onClick={() => setEnvironment(value)}
                key={value}
              >
                {value === "TEST" ? "Test" : "Live"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <section className="integration-summary" aria-label="Integration summary">
        <article className="panel">
          <ShieldCheck />
          <span>
            <small>Configured</small>
            <b>{summary.configured}</b>
          </span>
        </article>
        <article className="panel">
          <CheckCircle2 />
          <span>
            <small>Connected</small>
            <b>{summary.connected}</b>
          </span>
        </article>
        <article className="panel">
          <Activity />
          <span>
            <small>Enabled</small>
            <b>{summary.enabled}</b>
          </span>
        </article>
        <article className="panel integration-summary-environment">
          <span>
            <small>Workspace</small>
            <b>{environment === "TEST" ? "Test mode" : "Live mode"}</b>
          </span>
        </article>
      </section>

      <div
        className={`integration-mode-banner ${environment.toLowerCase()}`}
        role="status"
      >
        {environment === "LIVE" ? <AlertTriangle /> : <ShieldCheck />}
        <span>
          <b>{environment === "LIVE" ? "Live mode" : "Test mode"}</b>
          {environment === "LIVE"
            ? "Changes here affect providers used by production operations."
            : "This workspace is isolated from providers selected by production."}
        </span>
      </div>

      {loadError && (
        <div className="integration-alert error" role="alert">
          <AlertTriangle />
          <span>{loadError}</span>
          <button type="button" onClick={() => void load(true)}>
            Try again
          </button>
        </div>
      )}

      <div className="integration-tabs" role="tablist" aria-label="Provider type">
        {filters.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={filter === tab.value}
            key={tab.value}
            className={filter === tab.value ? "active" : ""}
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {(filter === "ALL" || filter === "AUTH") && (
        <section className="panel integration-security-note">
          <KeyRound />
          <div>
            <h3>Google sign-in with Firebase</h3>
            <p>{firebaseStatus ? (firebaseStatus.enabled
              ? "Google sign-in is configured for this deployment."
              : "Google sign-in needs Firebase configuration before customers or staff can sign in.")
              : "Authentication status could not be loaded. Refresh to try again."}</p>
            {firebaseStatus?.projectId && <p>Project: <strong>{firebaseStatus.projectId}</strong></p>}
            {firebaseStatus?.authDomain && <p>Authentication domain: <strong>{firebaseStatus.authDomain}</strong></p>}
            <p>Authentication is managed in Firebase Console and the hosting configuration. This status applies to the current deployment and is independent of the Test/Live provider workspace.</p>
            <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">Open Firebase Console</a>
          </div>
        </section>
      )}

      {visible.length ? (
        <div className="integration-provider-grid">
          {visible.map((item) => (
            <article className="panel integration-provider" key={item.id}>
              <div
                className="integration-provider-icon"
                style={{ background: kindColors[item.kind] }}
              >
                <ProviderIcon kind={item.kind} />
              </div>
              <div className="integration-provider-copy">
                <span>{kindLabels[item.kind]}</span>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
              </div>
              <div className="integration-badges" aria-label={`${item.name} status`}>
                <span
                  className={
                    item.connected || isPublicOnlyActive(item)
                      ? "connected"
                      : "muted"
                  }
                >
                  {isBrowserAnalytics(item)
                    ? "Browser tracking"
                    : isPublicOnlyActive(item)
                    ? "Active"
                    : item.connected
                      ? "Connected"
                      : item.provider === "resend" && item.configured && item.lastTest?.outcome === "UNSUPPORTED"
                        ? "Verify email delivery"
                      : "Not connected"}
                </span>
                <span className={item.configured ? "configured" : "warning"}>
                  {item.configured ? isBrowserAnalytics(item) ? "Configured; verify in provider" : "Configured" : "Setup needed"}
                </span>
                <span className={item.enabled ? "enabled" : "muted"}>
                  {item.enabled ? "Enabled" : "Disabled"}
                </span>
                {!item.capabilities.liveOperations && (
                  <span className="warning">Adapter unavailable</span>
                )}
              </div>
              <div className="integration-provider-meta">
                <span>{item.environment === "TEST" ? "Test" : "Live"}</span>
                <span>Priority {item.priority}</span>
                {!isBrowserAnalytics(item) && item.lastTest && item.lastTest.outcome !== "UNTESTED" && (
                  <span>Last test: {humanize(item.lastTest.outcome)}</span>
                )}
              </div>
              <button
                type="button"
                onClick={(event) => openItem(item, event.currentTarget)}
              >
                {item.configured ? isBrowserAnalytics(item) ? "Manage tracking" : "Manage connection" : "Set up provider"}
                <ChevronRight />
              </button>
            </article>
          ))}
        </div>
      ) : filter !== "AUTH" ? (
        <section className="panel integration-page-state integration-empty">
          <Code2 />
          <h2>No integrations in this view</h2>
          <p>
            No {environment.toLowerCase()} providers match the selected category.
          </p>
          <button type="button" className="secondary" onClick={() => setFilter("ALL")}>
            Show all integrations
          </button>
        </section>
      ) : null}

      <section className="panel integration-security-note">
        <KeyRound />
        <div>
          <h3>Secrets stay write-only</h3>
          <p>
            The API returns only masked credential metadata. Leave a secret field
            blank to preserve its stored value; disconnecting deliberately clears
            every credential for that provider and environment.
          </p>
        </div>
      </section>

      {selected && (
        <>
          <button
            type="button"
            className="integration-modal-backdrop"
            aria-label="Close integration configuration"
            onClick={closeDialog}
          />
          <section
            className="panel integration-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="integration-modal-title"
            ref={modalRef}
          >
            <header>
              <div
                className="integration-provider-icon"
                style={{ background: kindColors[selected.kind] }}
              >
                <ProviderIcon kind={selected.kind} />
              </div>
              <div>
                <p className="portal-eyebrow">
                  {selected.environment === "TEST" ? "Test" : "Live"} provider
                </p>
                <h2 id="integration-modal-title">{selected.name}</h2>
                <span>{selected.description}</span>
              </div>
              <button
                type="button"
                className="integration-modal-close"
                aria-label="Close"
                onClick={closeDialog}
                ref={closeButtonRef}
                disabled={busyAction !== null}
              >
                <X />
              </button>
            </header>

            <div className="integration-modal-status">
              <span
                className={
                  selected.connected || isPublicOnlyActive(selected)
                    ? "connected"
                    : "muted"
                }
              >
                {isBrowserAnalytics(selected)
                  ? "Browser tracking"
                  : isPublicOnlyActive(selected)
                  ? "Active"
                  : selected.connected
                    ? "Connected"
                    : selected.provider === "resend" && selected.configured && selected.lastTest?.outcome === "UNSUPPORTED"
                      ? "Verify email delivery"
                    : "Not connected"}
              </span>
              <span className={selected.configured ? "configured" : "warning"}>
                {selected.configured ? isBrowserAnalytics(selected) ? "Configured; verify in provider" : "Configured" : "Setup needed"}
              </span>
              <span className={selected.enabled ? "enabled" : "muted"}>
                {selected.enabled ? "Enabled" : "Disabled"}
              </span>
              {!selected.capabilities.liveOperations && (
                <span className="warning">Adapter unavailable</span>
              )}
              <small>Updated {formatDate(selected.updatedAt)}</small>
            </div>

            {!selected.capabilities.liveOperations && (
              <div className="integration-alert warning" role="status">
                <AlertTriangle />
                <span>
                  This provider is available for configuration, but no runtime
                  adapter is installed for live operations in this deployment.
                </span>
              </div>
            )}

            {notice && (
              <div className={`integration-alert ${notice.tone}`} role="status">
                {notice.tone === "success" ? <CheckCircle2 /> : <AlertTriangle />}
                <span>{notice.message}</span>
              </div>
            )}

            <div className="integration-modal-body">
              <section className="integration-form-section">
                <div>
                  <h3>Provider settings</h3>
                  <p>Choose whether this provider can participate in operations.</p>
                </div>
                <div className="integration-form-grid">
                  <label>
                    Priority
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      step="1"
                      value={priority}
                      onChange={(event) => setPriority(Number(event.target.value))}
                    />
                  </label>
                  <label className="integration-switch-row">
                    <span>
                      <b>Enable provider</b>
                      <small>
                        {selected.capabilities.liveOperations
                          ? `Allow use in ${selected.environment.toLowerCase()} operations.`
                          : "Unavailable until a runtime adapter is installed."}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) => setEnabled(event.target.checked)}
                      disabled={!selected.capabilities.liveOperations}
                    />
                  </label>
                </div>
              </section>

              {selected.credentialFields.length > 0 && (
                <section className="integration-form-section">
                  <div>
                    <h3>Credentials</h3>
                    <p>
                      Stored values are never loaded into these inputs. Enter only
                      secrets you want to add or replace.
                    </p>
                  </div>
                  <div className="integration-form-grid">
                    {selected.credentialFields.map((field) => (
                      <label key={field.key}>
                        <span>
                          {field.label}
                          {field.required && <em>Required</em>}
                        </span>
                        <input
                          type="password"
                          name={`integration-${selected.provider}-${field.key}`}
                          autoComplete="new-password"
                          value={credentials[field.key] || ""}
                          onChange={(event) =>
                            setCredentials((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                          placeholder={credentialPlaceholder(field)}
                        />
                        <small>
                          {field.configured
                            ? `Stored as ${field.masked || selected.maskedCredentials[field.key] || "a masked secret"}`
                            : "No credential is currently stored."}
                        </small>
                      </label>
                    ))}
                  </div>
                </section>
              )}

              {publicFields.length > 0 && (
                <section className="integration-form-section">
                  <div>
                    <h3>Public configuration</h3>
                    <p>Non-secret provider settings returned safely by the API.</p>
                  </div>
                  <div className="integration-form-grid">
                    {publicFields.map((field) => (
                      <label key={field.key}>
                        <span>
                          {field.label}
                          {field.required && <em>Required</em>}
                        </span>
                        <input
                          value={publicConfig[field.key] || ""}
                          onChange={(event) =>
                            setPublicConfig((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                </section>
              )}

              <section className="integration-test-panel">
                <div>
                  <h3>{isBrowserAnalytics(selected) ? "Verify browser tracking" : "Connection test"}</h3>
                  <p>
                    {isBrowserAnalytics(selected)
                      ? "Save and enable this integration, then opt in to tracking on the storefront. Verify incoming events in the provider's dashboard. A saved public ID confirms configuration, not event delivery."
                      : selected.capabilities.testConnection
                      ? "This tests the currently saved configuration. Connected is shown only after the backend receives a real successful provider response."
                      : "This provider does not expose a safe connection test."}
                  </p>
                  {formDirty && selected.capabilities.testConnection && (
                    <small className="integration-unsaved-note">
                      Save your changes before testing so the result cannot be
                      mistaken for a test of unsaved values.
                    </small>
                  )}
                  {!isBrowserAnalytics(selected) && selected.lastTest && (
                    <small>
                      {humanize(selected.lastTest.outcome)} · {formatDate(selected.lastTest.testedAt)}
                      {selected.lastTest.message ? ` · ${selected.lastTest.message}` : ""}
                    </small>
                  )}
                </div>
                {selected.capabilities.testConnection && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void testConnection()}
                    disabled={
                      busyAction !== null || !selected.configured || formDirty
                    }
                    title={
                      formDirty
                        ? "Save changes before testing"
                        : !selected.configured
                          ? "Configure this provider before testing"
                          : undefined
                    }
                  >
                    {busyAction === "test" ? (
                      <RefreshCw className="spin" />
                    ) : (
                      <Activity />
                    )}
                    {busyAction === "test" ? "Testing…" : "Test connection"}
                  </button>
                )}
              </section>

              {confirmDisconnect && (
                <section className="integration-disconnect-confirm" role="alert">
                  <AlertTriangle />
                  <div>
                    <h3>Disconnect {selected.name}?</h3>
                    <p>
                      This disables the provider and permanently clears all stored
                      credentials for this {selected.environment.toLowerCase()} connection.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={busyAction !== null}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void disconnect()}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "disconnect" ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                </section>
              )}
            </div>

            <footer>
              <div>
                {selected.capabilities.disconnect &&
                  (selected.configured || selected.enabled || selected.connected) &&
                  !confirmDisconnect && (
                    <button
                      type="button"
                      className="integration-disconnect"
                      onClick={() => setConfirmDisconnect(true)}
                      disabled={busyAction !== null}
                    >
                      Disconnect
                    </button>
                  )}
              </div>
              <div>
                <button
                  type="button"
                  className="secondary"
                  onClick={closeDialog}
                  disabled={busyAction !== null}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void save()}
                  disabled={busyAction !== null || Boolean(validationMessage)}
                  title={validationMessage || undefined}
                >
                  {busyAction === "save" ? (
                    <RefreshCw className="spin" />
                  ) : (
                    <Save />
                  )}
                  {busyAction === "save" ? "Saving…" : "Save configuration"}
                </button>
              </div>
              {validationMessage && <p>{validationMessage}</p>}
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
