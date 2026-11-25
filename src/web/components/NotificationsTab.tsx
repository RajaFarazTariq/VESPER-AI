import { AlertTriangle, BellRing, CalendarClock, Laptop, ListTodo, Send, Sunrise, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { NotificationPrefsDto, NotificationsDto, PushDeviceDto } from "../../shared/types";
import { api, ApiError } from "../api/client";
import {
  browserTimeZone,
  currentSubscription,
  notificationPermission,
  parseTime,
  PushError,
  pushSupport,
  reminderTime,
  savedDeviceId,
  saveDeviceId,
  subscribe,
  testResult,
  thisDeviceLabel,
  unsubscribe,
  type PushSupport,
} from "../lib/push";
import { Toggle } from "./SettingsDialog";

/** This browser: can it get notifications, is it allowed, is it switched on (subscribed and known to the server)? */
interface ThisDevice {
  support: PushSupport;
  permission: ReturnType<typeof notificationPermission>;
  /** The browser has a subscription made with the server's current key. */
  subscribed: boolean;
  deviceId: string | null;
}

type Notice = { text: string; tone: "info" | "error" };
type PrefsPatch = Partial<Pick<NotificationPrefsDto, "briefingEnabled" | "briefingTime" | "meetingAlerts" | "meetingMinutes">>;

const MEETING_MINUTES = [5, 10, 15, 30];
const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const shortDateTime = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const errorText = (e: unknown, fallback: string) => (e instanceof PushError || e instanceof ApiError ? e.message : fallback);

const button =
  "inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-50";
const primary =
  "inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-50";

/**
 * Settings → Notifications (v0.18.0): VESPER's notifications on the user's own devices (Web Push): switch them on for
 * this browser, the devices that have them, a test, the daily briefing, meeting alerts and upcoming reminders.
 * Changes save at once (with the browser's time zone).
 */
export function NotificationsTab() {
  const [data, setData] = useState<NotificationsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [device, setDevice] = useState<ThisDevice | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const zone = browserTimeZone();

  const load = useCallback(async () => {
    try {
      const next = await api.notifications.get();
      setData(next);
      setLoadError(null);
      const subscription = await currentSubscription(next.publicKey);
      setDevice({
        support: pushSupport(),
        permission: notificationPermission(),
        subscribed: Boolean(subscription?.keyMatches),
        deviceId: savedDeviceId(),
      });
    } catch (e) {
      setLoadError(errorText(e, "Couldn't load your notification settings."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one action at a time; the notice says how it went. */
  const run = async (name: string, action: () => Promise<Notice | null>, fallback: string) => {
    setBusy(name);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (e) {
      setNotice({ text: errorText(e, fallback), tone: "error" });
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (loadError && !data) return <p className="text-sm text-[var(--danger)]">{loadError}</p>;
  if (!data || !device) return <p className="text-sm text-[var(--text-soft)]">Loading…</p>;

  const thisId = device.deviceId && data.devices.some((d) => d.id === device.deviceId) ? device.deviceId : null;
  const on = device.subscribed && thisId !== null && device.permission === "granted";

  const turnOn = () =>
    run(
      "on",
      async () => {
        // The browser's permission prompt comes first, while the tap still counts.
        const subscription = await subscribe(data.publicKey);
        const { device: saved } = await api.notifications.addDevice({ ...subscription, label: thisDeviceLabel(), timeZone: browserTimeZone() });
        saveDeviceId(saved.id);
        return { text: "Notifications are on for this device. Send a test to check that they arrive.", tone: "info" };
      },
      "Couldn't switch notifications on.",
    );

  /** Off here: the server forgets this browser, and the browser drops its subscription. */
  const turnOffHere = async () => {
    const id = device.deviceId;
    try {
      if (id) await api.notifications.removeDevice(id);
    } catch (e) {
      // Already removed (e.g. from another device) is fine.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
    await unsubscribe();
    saveDeviceId(null);
  };
  const turnOff = () =>
    run(
      "off",
      async () => {
        await turnOffHere();
        return { text: "Notifications are off for this device.", tone: "info" };
      },
      "Couldn't switch notifications off.",
    );

  const remove = (d: PushDeviceDto) =>
    run(
      `remove:${d.id}`,
      async () => {
        if (d.id === thisId) await turnOffHere();
        else await api.notifications.removeDevice(d.id);
        return null;
      },
      "Couldn't remove that device.",
    );

  const savePrefs = async (patch: PrefsPatch) => {
    const before = data.prefs;
    setData({ ...data, prefs: { ...before, ...patch } });
    setNotice(null);
    try {
      const { prefs } = await api.notifications.updatePrefs(patch);
      setData((d) => (d ? { ...d, prefs } : d));
    } catch (e) {
      setData((d) => (d ? { ...d, prefs: before } : d));
      setNotice({ text: errorText(e, "Couldn't save that change."), tone: "error" });
    }
  };

  const cancelReminder = async (id: string) => {
    setBusy(`reminder:${id}`);
    try {
      await api.cancelReminder(id);
      setData((d) => (d ? { ...d, reminders: d.reminders.filter((r) => r.id !== id) } : d));
    } catch (e) {
      setNotice({ text: errorText(e, "Couldn't cancel that reminder."), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const { prefs } = data;
  return (
    <div className="space-y-6 text-sm">
      <Section icon={<BellRing size={20} />} title="Notifications on this device">
        <p className="text-[var(--text-soft)]">
          Reminders you ask for, your daily briefing and meeting alerts arrive as notifications on the devices you switch on here, even when VESPER
          isn't open.
        </p>
        <ThisDeviceStatus
          device={device}
          on={on}
          busy={busy}
          onTurnOn={() => void turnOn()}
          onTurnOff={() => void turnOff()}
        />

        {data.devices.length ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-[var(--text-soft)]">Your devices with notifications on</p>
            <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
              {data.devices.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                  <Laptop size={15} className="shrink-0 text-[var(--text-soft)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {d.label}
                      {d.id === thisId ? <span className="ml-2 rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[11px] font-normal text-[var(--text-soft)]">This device</span> : null}
                    </span>
                    <span className="block text-xs text-[var(--text-soft)]">
                      Added {shortDate(d.createdAt)} · {d.lastOkAt ? `last notification ${shortDateTime(d.lastOkAt)}` : "no notification yet"}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove(d)}
                    className="shrink-0 rounded p-1.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] disabled:opacity-40"
                    aria-label={`Remove ${d.label}`}
                    title="Remove: no more notifications there"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy !== null || data.devices.length === 0}
            onClick={() => void run("test", async () => ({ text: testResult(await api.notifications.test()), tone: "info" }), "Couldn't send a test.")}
            className={button}
            title={data.devices.length ? undefined : "Switch notifications on for a device first"}
          >
            <Send size={14} /> {busy === "test" ? "Sending…" : "Send a test notification"}
          </button>
        </div>
        {notice ? (
          <p role="status" className={notice.tone === "error" ? "text-[var(--danger)]" : "text-[var(--text-soft)]"}>
            {notice.text}
          </p>
        ) : null}
      </Section>

      <Section icon={<Sunrise size={20} />} title="Daily briefing" divided>
        <Toggle
          checked={prefs.briefingEnabled}
          onChange={(briefingEnabled) => void savePrefs({ briefingEnabled })}
          label="A briefing every day"
          hint="A notification with your calendar and reminders: before 15:00 about today, from 15:00 about tomorrow. Tap it to hear VESPER read it."
        />
        <div className={`ml-12 space-y-1.5 ${prefs.briefingEnabled ? "" : "pointer-events-none opacity-50"}`}>
          <BriefingTime value={prefs.briefingTime} disabled={!prefs.briefingEnabled} onSave={(briefingTime) => void savePrefs({ briefingTime })} />
          <p className="text-xs text-[var(--text-soft)]">
            {prefs.briefingTime} · {prefs.timeZone}
          </p>
        </div>
      </Section>

      <Section icon={<CalendarClock size={20} />} title="Meeting alerts" divided>
        <Toggle
          checked={prefs.meetingAlerts}
          onChange={(meetingAlerts) => void savePrefs({ meetingAlerts })}
          label="Before each calendar event"
          hint="Needs Google Calendar connected (Settings → Connections)."
        />
        <label className={`ml-12 flex items-center gap-2 ${prefs.meetingAlerts ? "" : "pointer-events-none opacity-50"}`}>
          <select
            value={prefs.meetingMinutes}
            disabled={!prefs.meetingAlerts}
            onChange={(e) => void savePrefs({ meetingMinutes: Number(e.target.value) })}
            aria-label="Minutes before the event"
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          >
            {MEETING_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
          <span className="text-[var(--text-soft)]">before it starts</span>
        </label>
      </Section>

      <Section icon={<ListTodo size={20} />} title="Upcoming reminders" divided>
        {data.reminders.length === 0 ? (
          <p className="rounded-lg bg-[var(--bg-soft)] px-3 py-3 text-[var(--text-soft)]">
            No reminders yet. Ask VESPER, for example: “Remind me at 5 PM to call the bank.”
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {data.reminders.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block [overflow-wrap:anywhere]">{r.text}</span>
                  <span className="block text-xs text-[var(--text-soft)]">
                    {reminderTime(r.dueAt, r.timeZone)}
                    {r.timeZone !== zone ? ` · ${r.timeZone}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy === `reminder:${r.id}`}
                  onClick={() => void cancelReminder(r.id)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] disabled:opacity-40"
                  aria-label={`Cancel reminder: ${r.text}`}
                >
                  <X size={13} /> Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="rounded-lg bg-[var(--bg-soft)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
        <p className="font-medium text-[var(--text)]">Good to know</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            Notifications come through your browser, so it must be running (in the background is fine). If it's closed, a reminder waits about an hour
            and the briefing two hours, then it's dropped.
          </li>
          <li>On a phone: keep Chrome allowed to show notifications (phone Settings → Apps → Chrome → Notifications), and don't let battery saving stop it.</li>
          <li>On Windows: Do not disturb (Focus) hides them; notifications must be on for your browser in Settings → System → Notifications.</li>
          <li>They go only to the devices listed here, encrypted on the way: the browser's push service delivers them but can't read them.</li>
        </ul>
      </div>
    </div>
  );
}

function Section({ icon, title, divided = false, children }: { icon: ReactNode; title: string; divided?: boolean; children: ReactNode }) {
  return (
    <section className={`space-y-4 ${divided ? "border-t border-[var(--border)] pt-5" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-[var(--accent)]" aria-hidden="true">
          {icon}
        </span>
        <h3 className="font-medium">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/** Whether this browser gets notifications, and the button to change that (or why it can't). */
function ThisDeviceStatus({
  device,
  on,
  busy,
  onTurnOn,
  onTurnOff,
}: {
  device: ThisDevice;
  on: boolean;
  busy: string | null;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  const warning = (children: ReactNode) => (
    <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
  if (device.support === "ios-home-screen") {
    return warning(
      <>
        On iPhone and iPad, notifications work only for VESPER added to the Home Screen: tap Share → Add to Home Screen, open VESPER from there, then
        switch them on here.
      </>,
    );
  }
  if (device.support === "insecure") return warning("Notifications need a secure (https) connection to VESPER.");
  if (device.support === "unsupported") {
    return warning("This browser can't show VESPER notifications. Chrome, Edge, Opera and Firefox can (on a computer or Android).");
  }
  if (device.permission === "denied") {
    return warning(
      <>
        Notifications are blocked for this site. To allow them, click the padlock (or site icon) at the left of the address bar → Notifications →
        Allow, then reload this page. On Android: tap the icon left of the address → Permissions → Notifications.
      </>,
    );
  }
  const label = thisDeviceLabel();
  return on ? (
    <div className="flex flex-wrap items-center gap-3">
      <p>
        On for this device <span className="text-[var(--text-soft)]">({label})</span>
      </p>
      <button type="button" disabled={busy !== null} onClick={onTurnOff} className={button}>
        {busy === "off" ? "Turning off…" : "Turn off on this device"}
      </button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy !== null} onClick={onTurnOn} className={primary}>
        <BellRing size={15} /> {busy === "on" ? "Turning on…" : "Turn on for this device"}
      </button>
      <span className="text-xs text-[var(--text-soft)]">
        {device.permission === "granted" ? label : `${label} · your browser asks for permission`}
      </span>
    </div>
  );
}

/**
 * The briefing's time ("HH:MM"). Saved a moment after the last change (a picker changes the value as you scroll), or
 * at once when leaving the field.
 */
function BriefingTime({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (time: string) => void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(value);
  saved.current = value;

  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const commit = (raw: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const time = parseTime(raw);
    if (time && time !== saved.current) onSave(time);
  };

  return (
    <label className="flex items-center gap-2">
      <span className="text-[var(--text-soft)]">At</span>
      <input
        type="time"
        value={draft}
        disabled={disabled}
        required
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(next), 800);
        }}
        onBlur={(e) => commit(e.target.value)}
        aria-label="Briefing time"
        className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
      />
    </label>
  );
}
