import { useEffect, useRef, useState } from "react";
import { commerceApi } from "./commerce-api";

export type PostalLocation = { postalCode: string; country: "IN"; city: string; state: string; areas: Array<{ name: string; district: string; state: string }> };
export function usePostalLookup(postalCode: string, onResolved: (value: PostalLocation) => void) {
  const callback = useRef(onResolved); callback.current = onResolved;
  const [state, setState] = useState<{ pin: string; loading: boolean; message: string; location?: PostalLocation }>({ pin: "", loading: false, message: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!/^[1-9]\d{5}$/.test(postalCode)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState({ pin: postalCode, loading: true, message: "Finding your city and state…" });
      void commerceApi<PostalLocation>(`/api/v1/postal-codes/${postalCode}`, { signal: controller.signal })
        .then(location => {
          if (controller.signal.aborted) return;
          callback.current(location);
          const areas = location.areas.slice(0, 5).map(area => area.name).join(", ");
          setState({ pin: postalCode, loading: false, location, message: `${areas ? `Postal areas: ${areas}. ` : ""}Check the suggested city and state; you can edit both. Enter your house number and street separately.` });
        }).catch(error => {
          if (!controller.signal.aborted) setState({ pin: postalCode, loading: false, message: error instanceof Error ? error.message : "Enter your city and state manually." });
        });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [postalCode, attempt]);
  return { ...(state.pin === postalCode ? state : { loading: false, message: "", location: undefined }), retry: () => setAttempt(value => value + 1) };
}
