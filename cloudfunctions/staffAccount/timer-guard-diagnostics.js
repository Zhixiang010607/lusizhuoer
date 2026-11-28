"use strict";

// Observation only: no caller authorization, SQL, SMS, or raw identity logging.
function contextEnvironment(context) {
  if (context.environment !== undefined) {
    try {
      const parsed = JSON.parse(context.environment);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
      return { state: "json", values: parsed };
    } catch (_) { return { state: "invalid", values: {} }; }
  }
  if (typeof context.environ === "string") {
    const values = {};
    for (const part of context.environ.split(";")) {
      const index = part.indexOf("=");
      const key = part.slice(0, index);
      if (index > 0 && ["TCB_UUID", "TCB_CONTEXT_KEYS", "TRIGGER_SRC"].includes(key)) {
        values[key] = part.slice(index + 1);
      }
    }
    return { state: "legacy", values };
  }
  return { state: "absent", values: {} };
}

function recordTimerGuardDiagnostic({ event = {}, context = {}, env = process.env,
  identity, identityReadOk, version, logger = console, now = Date.now }) {
  // A logging failure must never change the existing fail-closed UID decision.
  try {
    const current = contextEnvironment(context);
    const hasUid = value => Boolean(String(value || "").trim());
    const declaresUid = value => typeof value === "string" && value.split(",").includes("TCB_UUID");
    const has = key => Object.prototype.hasOwnProperty.call(current.values, key);
    const eventTime = Date.parse(event.Time);
    const snapshot = {
      schemaVersion: 1,
      version: /^v[0-9]+$/.test(version) ? version : "unknown",
      decision: !identityReadOk ? "identity-unverified" : hasUid(identity?.uid) ? "uid-rejected" : "allowed",
      sdkIdentityReadOk: identityReadOk === true,
      sdkUidPresent: identityReadOk ? hasUid(identity?.uid) : null,
      runtimeUidPresent: hasUid(env.TCB_UUID),
      runtimeKeysDeclareUid: declaresUid(env.TCB_CONTEXT_KEYS),
      runtimeSourceTimer: String(env.TRIGGER_SRC || "").toLowerCase() === "timer",
      runtimeFunctionMatches: env.SCF_FUNCTIONNAME === "staffAccount",
      contextFunctionPresent: Boolean(context.function_name),
      contextFunctionMatches: context.function_name ? context.function_name === "staffAccount" : null,
      contextNamespacePresent: Boolean(context.namespace),
      contextNamespaceMatches: context.namespace && (env.CLOUDBASE_ENV_ID || env.TCB_ENV)
        ? context.namespace === (env.CLOUDBASE_ENV_ID || env.TCB_ENV) : null,
      contextEnvironmentState: current.state,
      contextUidPresent: has("TCB_UUID") ? hasUid(current.values.TCB_UUID) : null,
      contextKeysDeclareUid: has("TCB_CONTEXT_KEYS") ? declaresUid(current.values.TCB_CONTEXT_KEYS) : null,
      contextSourceTimer: has("TRIGGER_SRC") ? current.values.TRIGGER_SRC === "timer" : null,
      eventHasAction: Object.prototype.hasOwnProperty.call(event, "action"),
      eventTimeValid: Number.isFinite(eventTime),
      eventTimeWithinTwoMinutes: Number.isFinite(eventTime) && Math.abs(now() - eventTime) <= 120000
    };
    logger.info("review-sms-timer-guard", snapshot);
  } catch (_) { /* diagnostics must not authorize, deny, or mask an error */ }
}

module.exports = { recordTimerGuardDiagnostic };
