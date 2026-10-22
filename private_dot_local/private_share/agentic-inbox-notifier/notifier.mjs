#!/usr/bin/env node
// Agentic Inbox desktop notifier.
//
// Listens on the realtime stream of every mailbox in every configured
// deployment and shows a desktop notification (notify-send) for each new
// Inbox message, with an Open button. Mail the app files elsewhere (Spam,
// blocked senders, forgeries of our own domains) never notifies.
//
// Config: ~/.config/agentic-inbox-notifier/config.json (or $NOTIFIER_CONFIG)
//   { "deployments": [{ "name": "work", "origin": "https://…" }], "mute": ["a@b.c"] }
// Each deployment sits behind Cloudflare Access; its service token lives in
// GNOME Keyring:
//   secret-tool lookup service agentic-inbox-notifier deployment <name> field client_id|client_secret
// A deployment with "access": false (local dev) is reached without a token.
//
//   node notifier.mjs          run (normally as the systemd user service)
//   node notifier.mjs --test   show one sample notification and exit
//   NOTIFIER_DRY_RUN=1         log notifications instead of showing them

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = process.env.NOTIFIER_CONFIG ?? join(homedir(), ".config/agentic-inbox-notifier/config.json");
/** Mailbox lists are re-read this often, so new mailboxes are picked up. */
const DISCOVERY_MS = 10 * 60_000;
/** Keepalive: the mailbox answers "ping" with "pong" without waking up. */
const PING_MS = 30_000;
/** No frame for this long means the connection is dead (e.g. after suspend). */
const STALE_MS = 2.5 * PING_MS;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A failed mailbox list is retried this soon at first (the network may not be up yet). */
const DISCOVERY_RETRY_MIN_MS = 30_000;
/** Connections that never open for this long get a diagnosis (a dropped one is normal). */
const FAILING_FOR_MS = 5 * 60_000;
/** A problem worth acting on is shown on the desktop at most this often. */
const PROBLEM_NOTICE_MS = 60 * 60_000;
const SEEN_CAP = 2_000;

function log(message, fields = {}) {
	console.log(JSON.stringify({ message, ...fields }));
}

function readConfig() {
	const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

	if (!Array.isArray(config.deployments) || config.deployments.length === 0) {
		throw new Error(`${CONFIG_PATH}: "deployments" must list at least one { name, origin }`);
	}

	for (const d of config.deployments) {
		if (typeof d.name !== "string" || typeof d.origin !== "string") throw new Error(`${CONFIG_PATH}: each deployment needs a name and an origin`);
	}

	return { deployments: config.deployments, mute: new Set((config.mute ?? []).map((m) => String(m).toLowerCase())) };
}

/** The Access service-token headers for a deployment, read from GNOME Keyring. */
function accessHeaders(deployment) {
	if (deployment.access === false) return {};
	const lookup = (field) =>
		execFileSync("secret-tool", ["lookup", "service", "agentic-inbox-notifier", "deployment", deployment.name, "field", field], { encoding: "utf8" }).trim();

	return { "CF-Access-Client-Id": lookup("client_id"), "CF-Access-Client-Secret": lookup("client_secret") };
}

/** GNOME renders a subset of markup in the body; show text as text. */
function escapeMarkup(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Open `url` in the default browser. The user manager starts it as its own
 * unit rather than as our child: a child inherits this service's sandbox
 * (private /tmp, read-only home), where Chrome can't reach the running
 * instance and aborts, and it would be killed whenever this service stops.
 */
function openInBrowser(url) {
	const child = spawn("systemd-run", ["--user", "--quiet", "--collect", "--property=ExitType=cgroup", "--description=Open mail notification link", "--", "xdg-open", url], { stdio: "ignore" });

	child.on("exit", (code) => {
		if (code !== 0) log("opening the browser failed", { url, code });
	});
	child.on("error", (e) => log("opening the browser failed", { url, error: e.message }));
}

/** Show a notification; "Open" (or clicking it) opens `url` in the browser. */
function notify({ title, body, url, urgency = "normal", icon = "mail-unread" }) {
	// NOTIFIER_DRY_RUN=1 logs notifications instead of showing them (for testing).
	if (process.env.NOTIFIER_DRY_RUN) {
		log("would notify", { title, body, url });

		return;
	}

	const args = ["--app-name=Mail", `--icon=${icon}`, "--category=email.arrived", `--urgency=${urgency}`, title, escapeMarkup(body)];

	if (url) args.unshift("--action=default=Open", "--action=open=Open");
	const child = spawn("notify-send", args, { stdio: ["ignore", "pipe", "ignore"] });
	let chosen = "";

	child.stdout.on("data", (chunk) => {
		chosen += chunk;
	});
	child.on("close", () => {
		if (url && ["open", "default"].includes(chosen.trim())) openInBrowser(url);
	});
	child.on("error", (e) => log("notify-send failed", { error: e.message }));
}

class MailboxStream {
	constructor(deployment, mailboxId, seen) {
		this.deployment = deployment;
		this.mailboxId = mailboxId;
		this.seen = seen;
		this.backoff = BACKOFF_MIN_MS;
		this.closed = false;
		this.connect();
	}

	connect() {
		if (this.closed) return;
		const origin = new URL(this.deployment.origin);
		const url = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/api/v1/mailboxes/${encodeURIComponent(this.mailboxId)}/stream`;
		let headers;

		try {
			headers = accessHeaders(this.deployment);
		} catch (e) {
			this.deployment.reportProblem(`can't read its Access token from the keyring (${e.message.split("\n")[0]})`);
			this.retry();

			return;
		}

		const ws = new WebSocket(url, { headers });
		let opened = false;
		this.ws = ws;
		this.lastFrameAt = Date.now();

		ws.addEventListener("open", () => {
			opened = true;
			this.backoff = BACKOFF_MIN_MS;
			this.deployment.connectionOpened();
			log("connected", { deployment: this.deployment.name, mailbox: this.mailboxId });
			this.pinger = setInterval(() => this.keepAlive(), PING_MS);
		});
		ws.addEventListener("message", (event) => {
			this.lastFrameAt = Date.now();
			this.handle(String(event.data));
		});
		ws.addEventListener("close", () => {
			clearInterval(this.pinger);

			if (this.ws !== ws || this.closed) return;
			// A connection that drops after opening is routine (WARP, Wi-Fi,
			// edge restarts); only one that never opens counts as failing.
			if (opened) log("disconnected", { deployment: this.deployment.name, mailbox: this.mailboxId });
			else this.deployment.connectionFailed();
			this.retry();
		});
	}

	keepAlive() {
		if (Date.now() - this.lastFrameAt > STALE_MS) {
			log("stale connection, reconnecting", { deployment: this.deployment.name, mailbox: this.mailboxId });
			this.ws?.close();
			this.ws = undefined;
			clearInterval(this.pinger);
			this.retry();

			return;
		}

		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("ping");
	}

	retry() {
		if (this.closed) return;
		const delay = this.backoff * (0.5 + Math.random());
		this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.connect(), delay);
	}

	handle(text) {
		let event;

		try {
			event = JSON.parse(text);
		} catch {
			return; // "pong"
		}

		if (event?.type !== "email.created" || event.folder !== "inbox" || typeof event.emailId !== "string") return;

		if (this.seen.has(event.emailId)) return;

		if (this.seen.size >= SEEN_CAP) this.seen.clear();
		this.seen.add(event.emailId);
		const sender = typeof event.sender === "string" && event.sender ? event.sender : "Unknown sender";
		const subject = typeof event.subject === "string" && event.subject.trim() ? event.subject.trim() : "(no subject)";
		const conversation = typeof event.threadId === "string" && event.threadId ? event.threadId : event.emailId;
		const mailboxPath = `/mailbox/${encodeURIComponent(this.mailboxId)}/emails/inbox/${encodeURIComponent(conversation)}`;

		log("new mail", { deployment: this.deployment.name, mailbox: this.mailboxId, emailId: event.emailId });
		notify({ title: sender, body: `${subject}\nto ${this.mailboxId}`, url: new URL(mailboxPath, this.deployment.origin).href });
	}

	close() {
		this.closed = true;
		clearTimeout(this.timer);
		clearInterval(this.pinger);
		this.ws?.close();
	}
}

class Deployment {
	constructor(config, mute) {
		Object.assign(this, config);
		this.mute = mute;
		this.streams = new Map();
		this.seen = new Set();
		this.failingSince = null;
		this.problemShownAt = 0;
		this.discoveryRetry = DISCOVERY_RETRY_MIN_MS;
	}

	/**
	 * One request to the mailbox list: `ok`, `auth` (Access turned the token
	 * away), `network` (unreachable: offline, DNS, TLS) or `HTTP <status>`.
	 */
	async probe() {
		let response;

		try {
			response = await fetch(new URL("/api/v1/mailboxes", this.origin), { headers: accessHeaders(this), redirect: "manual" });
		} catch (e) {
			return { status: e.message.includes("secret-tool") ? "keyring" : "network", detail: e.message.split("\n")[0] };
		}

		if (response.ok) return { status: "ok", mailboxes: (await response.json()).map((m) => String(m.id).toLowerCase()) };

		// Access answers a missing, expired or revoked token with its login redirect.
		if ([301, 302, 303, 307, 401, 403].includes(response.status)) return { status: "auth" };

		return { status: `HTTP ${response.status}` };
	}

	/** Report what's worth acting on; being offline isn't. */
	explain(result, context) {
		if (result.status === "auth") this.reportProblem(`${context}: Access rejects the notifier's token (it may have expired or been revoked)`);
		else if (result.status === "keyring") this.reportProblem(`${context}: can't read its Access token from the keyring`);
		else if (result.status === "network") log("unreachable", { deployment: this.name, context, detail: result.detail });
		else this.reportProblem(`${context}: the server answered ${result.status}`);
	}

	async discover() {
		clearTimeout(this.discoveryTimer);
		const result = await this.probe();

		if (result.status !== "ok") {
			this.explain(result, "can't list its mailboxes");
			// Try again soon: at login the network may still be coming up.
			this.discoveryTimer = setTimeout(() => void this.discover(), this.discoveryRetry);
			this.discoveryRetry = Math.min(this.discoveryRetry * 2, BACKOFF_MAX_MS);

			return;
		}

		this.discoveryRetry = DISCOVERY_RETRY_MIN_MS;
		const wanted = new Set(result.mailboxes.filter((id) => !this.mute.has(id)));

		for (const [id, stream] of this.streams) {
			if (!wanted.has(id)) {
				stream.close();
				this.streams.delete(id);
				log("mailbox gone", { deployment: this.name, mailbox: id });
			}
		}

		for (const id of wanted) {
			if (!this.streams.has(id)) this.streams.set(id, new MailboxStream(this, id, this.seen));
		}

		log("watching", { deployment: this.name, mailboxes: [...wanted] });
	}

	connectionOpened() {
		this.failingSince = null;
	}

	/** A connection that never opened; after FAILING_FOR_MS of only those, find out why. */
	connectionFailed() {
		this.failingSince ??= Date.now();

		if (Date.now() - this.failingSince < FAILING_FOR_MS || this.diagnosing) return;
		this.diagnosing = true;
		void this.probe()
			.then((result) => {
				if (result.status === "ok") log("streams failing while the API answers", { deployment: this.name });
				else this.explain(result, "can't connect");
			})
			.finally(() => {
				this.diagnosing = false;
			});
	}

	/** Log every problem; show it on the desktop at most once an hour. */
	reportProblem(reason) {
		log("problem", { deployment: this.name, reason });

		if (Date.now() - this.problemShownAt < PROBLEM_NOTICE_MS) return;
		this.problemShownAt = Date.now();
		notify({ title: "Mail notifier", body: `${this.name} ${reason}.`, urgency: "low", icon: "dialog-warning" });
	}
}

if (process.argv.includes("--test")) {
	notify({ title: "jane@example.com", body: "Test notification\nto inbox@example.com", url: "https://example.com/" });
	setTimeout(() => process.exit(0), 500);
} else {
	const { deployments, mute } = readConfig();
	const running = deployments.map((d) => new Deployment(d, mute));
	const discoverAll = () => Promise.all(running.map((d) => d.discover()));

	await discoverAll();
	setInterval(discoverAll, DISCOVERY_MS);

	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			for (const d of running) for (const stream of d.streams.values()) stream.close();
			process.exit(0);
		});
	}
}
