import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

// Keep writes ordered even if a module is closed and reopened during a save.
const queues = new Map<string, Promise<unknown>>();
export function useModuleDraft<T>(path: string, method: "PUT" | "POST" = "PUT", field = "response") {
  const [status, setStatus] = useState("");
  const draft = useMemo(() => {
    let storageKey = "", ownerId = "", value: T, dirty = false, revision = 0;
    let inFlight: { revision: number; promise: Promise<boolean> } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const report = (message: string) => { if (active) setStatus(message); };
    const clearTimer = () => { clearTimeout(timer); timer = undefined; };
    const flush = (): Promise<boolean> => {
      clearTimer();
      if (!storageKey || !dirty) return Promise.resolve(true);
      if (inFlight?.revision === revision) return inFlight.promise;
      const savedRevision = revision;
      const body = JSON.stringify({ [field]: value, studentId: ownerId });
      report("Saving…");
      const request = (queues.get(storageKey) ?? Promise.resolve()).catch(() => {}).then(() =>
        api(path, { method, body, keepalive: new Blob([body]).size <= 60000 }),
      );
      queues.set(storageKey, request);
      const completion = request.then(() => {
        if (revision === savedRevision) { dirty = false; report("Saved automatically"); }
        return true;
      }).catch(() => {
        report("Not saved to your account yet. Retrying; keep this page open.");
        if (active) timer = setTimeout(() => { void flush(); }, 5000);
        return false;
      }).finally(() => { if (queues.get(storageKey) === request) queues.delete(storageKey); if (inFlight?.promise === completion) inFlight = undefined; });
      inFlight = { revision: savedRevision, promise: completion };
      return completion;
    };
    return {
      mount() { active = true; },
      restore(studentId: string, serverValue: T, serverUpdatedAt = ""): T {
        ownerId = studentId;
        storageKey = `simlife-module-draft:${studentId}:${path}`;
        value = serverValue;
        try {
          const local = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (local?.updatedAt > serverUpdatedAt) {
            value = local.value; dirty = true; revision++;
            timer = setTimeout(() => { void flush(); }, 500);
          }
        } catch { /* Account work is available when device storage is blocked. */ }
        return value;
      },
      change(next: T) {
        value = next; dirty = true; revision++;
        try { localStorage.setItem(storageKey, JSON.stringify({ value, updatedAt: new Date().toISOString() })); }
        catch { /* Account autosave still works. */ }
        report("Saving…"); clearTimer(); timer = setTimeout(() => { void flush(); }, 600);
      },
      flush,
      async beforeSubmit() {
        // Wait for queued writes before Submit clears the draft on the server.
        const saved = await flush();
        await queues.get(storageKey)?.catch(() => {});
        clearTimer();
        return saved;
      },
      submitted() {
        clearTimer(); dirty = false; revision++;
        try { localStorage.removeItem(storageKey); } catch { /* Optional backup. */ }
        report("Submitted");
      },
      dispose() { active = false; void flush(); },
    };
  }, [path, method, field]);
  useEffect(() => {
    draft.mount();
    const flush = () => { void draft.flush(); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", hidden);
      draft.dispose();
    };
  }, [draft]);
  return { ...draft, status };
}
