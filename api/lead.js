/**
 * Lead intake proxy: funnel -> GHL -> LeadFi.
 *
 * The page POSTs here; this forwards an enriched payload to a GHL inbound
 * webhook. The GHL workflow creates the contact and applies the `lead-fi`
 * tag, which triggers the LeadFi workflow LeadFi already built. No LeadFi
 * credentials live here — that workflow holds them.
 *
 * This function exists because three things cannot be done on a static page:
 *
 *  1. ConsentIP. LeadFi requires it and rejects a blank one. A static page
 *     cannot see its own visitor's IP, and neither can Zapier or Make — they
 *     only see what the page sends them. The SOP suggests falling back to an
 *     office IP; that would record a Denver office as the place the consumer
 *     consented, so we fail soft instead.
 *  2. Name splitting. The funnel has one "Full Name" field; LeadFi needs
 *     First and Last separately, letters/spaces/apostrophes/hyphens only.
 *  3. US phone normalisation. LeadFi rejects anything else.
 *
 * Env vars (set in Vercel, never committed):
 *   GHL_WEBHOOK_URL — Inbound Webhook trigger URL from the GHL workflow
 */

// LeadFi requires: letters, spaces, apostrophes, hyphens. Nothing else.
function sanitiseName(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // fold accents rather than reject them
        .replace(/[^A-Za-z '-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** "Steve O'Brien-Smith Jr" -> { first: "Steve", last: "O'Brien-Smith Jr" } */
function splitName(fullName) {
    const raw = String(fullName || "");
    // Digits mean junk input. Sanitising would turn "J0hn Sm1th" into
    // "J / hn Sm th" and burn a paid LeadFi request that could never match.
    if (/\d/.test(raw)) return { first: "", last: "" };

    const clean = sanitiseName(raw);
    if (!clean) return { first: "", last: "" };
    const parts = clean.split(" ");
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** LeadFi accepts US numbers. Drop a leading country code, require 10 digits. */
function normalisePhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return digits.length === 10 ? digits : null;
}

/** The visitor's real IP. Vercel puts the client first in x-forwarded-for. */
function clientIp(req) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
    return req.headers["x-real-ip"] || req.socket?.remoteAddress || null;
}

/** ISO-8601 with timezone offset, e.g. 2026-07-29T14:03:11+00:00 */
function isoWithOffset(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function safeParse(s) {
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ ok: false, reason: "method_not_allowed" });
    }

    const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};

    // No consent, no pre-screen. This is the whole basis for the request.
    if (body.terms !== true && body.terms !== "true") {
        return res.status(200).json({ ok: false, reason: "no_consent" });
    }

    const webhook = process.env.GHL_WEBHOOK_URL;
    if (!webhook) {
        console.error("GHL_WEBHOOK_URL not set — lead not forwarded to CRM");
        return res.status(200).json({ ok: false, reason: "not_configured" });
    }

    const { first, last } = splitName(body.name);
    const phone = normalisePhone(body.phone);
    const ip = clientIp(req);

    // Fail soft on every validation problem. A lead we cannot pre-qualify is
    // still a lead — it must never be lost because LeadFi would reject it.
    // These are reported so a bad match rate is visible rather than silent.
    const problems = [];
    if (!first || !last) problems.push("name_unusable");
    if (!phone) problems.push("phone_not_us");
    if (!body.email) problems.push("email_missing");
    if (!ip) problems.push("ip_unavailable");

    // A name LeadFi cannot use is still a name the CRM needs. Fall back to
    // whatever the visitor typed so the contact is never created nameless —
    // it just does not get sent for pre-qualification.
    const rawName = String(body.name || "").trim();

    // Field names match what the "Lead Fi" workflow's inbound webhook already
    // receives from "Send To Lead Fi" — snake_case, E.164 phone, and the
    // consent IP in a custom field named exactly "IP".
    const payload = {
        first_name: first || rawName,
        last_name: last,
        full_name: rawName,
        email: String(body.email || "").trim(),
        phone: phone ? "+1" + phone : String(body.phone || "").trim(),
        IP: ip || "",
        country: "US",
        company_name: String(body.company || "").trim(),
        // Context for the CRM record. Not used by LeadFi.
        consent_date: isoWithOffset(new Date()),
        zip: String(body.zip || "").trim(),
        service: String(body.service || "").trim(),
        jobs_per_month: String(body.jobs_per_month || "").trim(),
        variant: String(body.variant || "").trim(),
        contact_source: "RankAngel Opt-in Funnel",
        source: "lead-funnel",
        // Tells the GHL workflow whether this lead is safe to send to LeadFi.
        // Leads that would fail validation still reach the CRM — they just
        // should not have the `lead-fi` tag applied.
        prequalifyEligible: problems.length === 0,
        prequalifyBlockedBy: problems.join(","),
    };

    // Dry run: echo the payload instead of forwarding it. Nothing reaches the
    // CRM, no workflow runs, no LeadFi request is made and nothing is charged.
    // Only ever returns the caller's own submission, so it exposes nothing.
    // Opt in explicitly with ?dryRun=1 — never triggered by a normal submit.
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.get("dryRun") === "1") {
        return res.status(200).json({
            ok: true,
            dryRun: true,
            wouldSendTo: webhook.replace(/\/[^/]{8,}$/, "/…"),
            payload,
        });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
        const upstream = await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!upstream.ok) {
            console.warn("GHL webhook rejected the lead", upstream.status);
            return res.status(200).json({ ok: false, reason: "ghl_" + upstream.status });
        }

        return res.status(200).json({
            ok: true,
            // Pre-qualification is asynchronous: the GHL workflow tags the
            // contact and LeadFi answers within about a minute, long after
            // the visitor has left. Nothing to route on here.
            prequalify: problems.length === 0 ? "queued" : "skipped",
            blockedBy: problems.join(",") || null,
        });
    } catch (err) {
        const aborted = err.name === "AbortError";
        console.error(aborted ? "GHL webhook timed out" : "GHL webhook threw", err.message);
        return res.status(200).json({ ok: false, reason: aborted ? "timeout" : "request_failed" });
    } finally {
        clearTimeout(timer);
    }
};
