/**
 * LeadFi pre-qualification proxy.
 *
 * The funnel is a static page, so it cannot see the visitor's IP address.
 * LeadFi requires ConsentIP and ConsentDate on every request — two of its six
 * mandatory fields exist purely to record that the person consented, and when.
 * This function is where those are captured truthfully.
 *
 * It also normalises the two things LeadFi rejects most often: a single
 * "Full Name" field, and phone numbers that are not US-formatted.
 *
 * The LeadFi response is deliberately NOT returned to the browser in full.
 * Only the routing decision (qualification + tier) goes back; the credit
 * score, limits and DTI stay server-side.
 *
 * Env vars (set in Vercel, never committed):
 *   LEADFI_API_KEY    — Dashboard > API & MCP
 *   LEADFI_TRACK_ID   — Dashboard > Packages
 *   LEADFI_MODE       — "test" (default, sandbox/mock) or "live" (real pull)
 */

const ENDPOINTS = {
    test: "https://api.leadfi.ai/api/v2/pre-qualify-test/",
    live: "https://api.leadfi.ai/api/v2/pre-qualify/",
};

// LeadFi requires: letters, spaces, apostrophes, hyphens. Nothing else.
function sanitiseName(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip accents rather than reject them
        .replace(/[^A-Za-z '-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** "Steve O'Brien-Smith Jr" -> { first: "Steve", last: "O'Brien-Smith Jr" } */
function splitName(fullName) {
    const raw = String(fullName || "");
    // Digits in a name mean junk input. Sanitising would turn "J0hn Sm1th"
    // into "J / hn Sm th" and burn a paid request that could never match.
    if (/\d/.test(raw)) return { first: "", last: "" };

    const clean = sanitiseName(raw);
    if (!clean) return { first: "", last: "" };
    const parts = clean.split(" ");
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** LeadFi accepts US numbers, 10-15 digits. Drop a leading US country code. */
function normalisePhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return digits.length === 10 ? digits : null;
}

/**
 * The visitor's real IP. Vercel puts the client first in x-forwarded-for.
 * We never substitute an office IP: this field records where the consumer
 * consented, and a stand-in would make that record false.
 */
function clientIp(req) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
    return req.headers["x-real-ip"] || req.socket?.remoteAddress || null;
}

/** ISO-8601 with timezone offset, e.g. 2026-07-29T14:03:11+00:00 */
function isoWithOffset(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
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

    const apiKey = process.env.LEADFI_API_KEY;
    const trackId = process.env.LEADFI_TRACK_ID;
    if (!apiKey || !trackId) {
        console.error("LeadFi credentials missing — skipping pre-qualification");
        return res.status(200).json({ ok: false, reason: "not_configured" });
    }

    const { first, last } = splitName(body.name);
    const phone = normalisePhone(body.phone);
    const ip = clientIp(req);

    // Fail soft on every validation problem. A lead we cannot pre-qualify is
    // still a lead — it must never be lost because LeadFi would reject it.
    if (!first || !last) return res.status(200).json({ ok: false, reason: "name_unusable" });
    if (!phone) return res.status(200).json({ ok: false, reason: "phone_not_us" });
    if (!body.email) return res.status(200).json({ ok: false, reason: "email_missing" });
    if (!ip) return res.status(200).json({ ok: false, reason: "ip_unavailable" });

    const payload = {
        FirstName: first,
        LastName: last,
        Email: String(body.email).trim(),
        Phone: phone,
        ConsentDate: isoWithOffset(new Date()),
        ConsentIP: ip,
    };
    if (/^\d{5}$/.test(String(body.zip || "").trim())) payload.Zip = String(body.zip).trim();

    const mode = process.env.LEADFI_MODE === "live" ? "live" : "test";

    // Never let a slow or failing LeadFi hold up the funnel.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
        const upstream = await fetch(ENDPOINTS[mode], {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "track-id": trackId,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        const data = await upstream.json().catch(() => ({}));

        // LeadFi returns HTTP 200/201 for both success and failure; Status is
        // the field that actually tells you which.
        const failed =
            String(data.Status || "").toLowerCase() !== "success" ||
            (Array.isArray(data.Errors) && data.Errors.length > 0);

        if (failed) {
            console.warn("LeadFi returned a failure", {
                mode,
                code: data.Code,
                errors: data.Errors,
            });
            return res.status(200).json({
                ok: false,
                reason: "leadfi_failed",
                code: data.Code || null,
            });
        }

        // Routing data only. Credit score, limits and DTI stay on the server.
        return res.status(200).json({
            ok: true,
            mode,
            qualification: data["Pre Qualification"] || null,
            tier: data.Tier || null,
        });
    } catch (err) {
        const aborted = err.name === "AbortError";
        console.error(aborted ? "LeadFi timed out" : "LeadFi request threw", err.message);
        return res.status(200).json({ ok: false, reason: aborted ? "timeout" : "request_failed" });
    } finally {
        clearTimeout(timer);
    }
};

function safeParse(s) {
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}
