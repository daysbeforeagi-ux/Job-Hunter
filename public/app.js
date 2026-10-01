const state = { data: null, filter: "all", period: "week", activity: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("visible"), 4200);
}

function relativeTime(iso) {
  if (!iso) return "Never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function futureTime(iso) {
  if (!iso) return "Not scheduled";
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (minutes < 1) return "Starting shortly";
  if (minutes < 60) return `In ${minutes}m`;
  return `In ${Math.round(minutes / 60)}h`;
}

function statusLabel(value) {
  return ({
    ready: "Ready", saved: "Not applied yet", submitted: "Applied", not_interested: "Not interested",
    job_closed: "Unavailable", application_blocked: "Application blocked", queued: "Queued",
    analyzing: "Analyzing", skipped: "Skipped", withdrawn: "Withdrawn", failed: "Needs review",
    filling: "In progress", review: "Needs review", submission_pending: "Check submission"
  })[value] || value.replaceAll("_", " ");
}

function resumeName(id) {
  return state.data.resumeSets.find((set) => set.id === id)?.name || "Not selected";
}

function button(label, className, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", handler);
  return element;
}

async function withButton(element, workingLabel, operation) {
  const original = element.textContent;
  element.disabled = true;
  element.textContent = workingLabel;
  try { await operation(); }
  catch (error) { toast(error.message, true); }
  finally { element.textContent = original; element.disabled = false; }
}

async function setJobStatus(job, status, element) {
  await withButton(element, "Saving…", async () => {
    await api(`/api/jobs/${job.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
    toast(`${job.title}: ${statusLabel(status)}.`);
    await refresh(true);
  });
}

async function undoJobStatus(job, element) {
  await withButton(element, "Undoing…", async () => {
    await api(`/api/jobs/${job.id}/undo`, { method: "POST", body: "{}" });
    toast(`Restored ${job.title} to its previous status.`);
    await refresh(true);
  });
}

function renderJobs() {
  const jobs = state.data.jobs.filter((job) => state.filter === "all" || job.status === state.filter);
  const table = $("#jobs-table");
  table.replaceChildren();
  $("#empty-state").classList.toggle("hidden", jobs.length > 0);
  $("#queue-summary").textContent = `${state.data.jobs.length} tracked role${state.data.jobs.length === 1 ? "" : "s"} · ${state.data.metrics.counts.ready} ready`;

  for (const job of jobs) {
    const row = document.createElement("tr");
    const role = document.createElement("td");
    const title = document.createElement("span");
    title.className = "job-title";
    title.textContent = job.title;
    title.title = job.title;
    const company = document.createElement("span");
    company.className = "job-company";
    company.textContent = `${job.company} · ${job.location}`;
    role.append(title, company);

    const scoreCell = document.createElement("td");
    const score = document.createElement("span");
    score.className = `score ${job.score === null ? "none" : job.score < 80 ? "medium" : ""}`;
    score.textContent = job.score === null ? "—" : `${job.score}%`;
    scoreCell.append(score);

    const resumeCell = document.createElement("td");
    const resume = document.createElement("span");
    resume.className = "resume-chip";
    resume.textContent = resumeName(job.resumeSetId);
    resumeCell.append(resume);

    const statusCell = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = `status-chip status-${job.status}`;
    chip.textContent = statusLabel(job.status);
    statusCell.append(chip);

    const updated = document.createElement("td");
    updated.textContent = relativeTime(job.statusChangedAt || job.updatedAt);

    const actions = document.createElement("td");
    const actionWrap = document.createElement("div");
    actionWrap.className = "row-actions";
    const open = document.createElement("a");
    open.className = "row-link";
    open.href = job.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "View posting";
    open.title = "Open the original job posting";
    actionWrap.append(open);
    if (job.status !== "submitted") actionWrap.append(button("Applied", "row-apply", (event) => setJobStatus(job, "submitted", event.currentTarget)));

    const menu = document.createElement("details");
    menu.className = "status-menu";
    const summary = document.createElement("summary");
    summary.textContent = "More";
    const menuBody = document.createElement("div");
    menuBody.className = "status-menu-body";
    const choices = [
      ["Not applied yet", "saved"], ["Not interested", "not_interested"],
      ["Job unavailable", "job_closed"], ["Application blocked", "application_blocked"]
    ];
    for (const [label, status] of choices) {
      if (job.status !== status) menuBody.append(button(label, "menu-button", (event) => setJobStatus(job, status, event.currentTarget)));
    }
    if (job.previousStatus) menuBody.append(button(`Undo to ${statusLabel(job.previousStatus)}`, "menu-button undo", (event) => undoJobStatus(job, event.currentTarget)));
    menu.append(summary, menuBody);
    actionWrap.append(menu);
    actions.append(actionWrap);
    row.append(role, scoreCell, resumeCell, statusCell, updated, actions);
    table.append(row);
  }
}

function render() {
  const data = state.data;
  const hour = new Date().getHours();
  $("#greeting-period").textContent = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  $("#resume-count").textContent = data.resumeSets.length;

  const dailyScanInput = $("#daily-scan-limit");
  if (document.activeElement !== dailyScanInput) dailyScanInput.value = data.dailyScanning.pendingLimit || data.dailyScanning.activeLimit;
  const scheduledChange = data.dailyScanning.pendingLimit ? ` · ${data.dailyScanning.pendingLimit}/day starts ${data.dailyScanning.pendingEffectiveDate}` : "";
  $("#daily-scan-status").textContent = `${data.dailyScanning.scannedToday}/${data.dailyScanning.activeLimit} screened today${scheduledChange}`;

  const pending = [];
  if (!data.readiness.apiKeyConfigured) pending.push("Gemini API key is not configured");
  if (data.automation.lastError) pending.push(`Screening paused: ${data.automation.lastError}`);
  $("#notice").textContent = pending.length ? `${pending.join(". ")}.` : "";
  $("#notice").classList.toggle("hidden", !pending.length);
  $("#automation-button").disabled = !data.readiness.apiKeyConfigured || Boolean(data.readiness.activeAction);
  $("#add-resume-button").disabled = !data.readiness.apiKeyConfigured || Boolean(data.readiness.activeAction);
  $("#sync-button").disabled = !data.readiness.sheetsConfigured || Boolean(data.readiness.activeAction);

  const resumeList = $("#resume-list");
  resumeList.replaceChildren();
  for (const set of data.resumeSets) {
    const item = document.createElement("div");
    item.className = "simple-item";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = set.name;
    const roles = document.createElement("span");
    roles.textContent = set.targetRoles.slice(0, 3).join(" · ");
    copy.append(name, roles);
    const dot = document.createElement("span");
    dot.className = "ready-dot";
    item.append(copy, dot);
    resumeList.append(item);
  }

  const readiness = [
    ["Gemini screening + answers", data.readiness.apiKeyConfigured, data.readiness.apiKeyConfigured ? "Configured" : "Waiting for API key"],
    ["Screening mode", !data.automation.enabled && !data.automation.running, data.automation.running ? "Running now" : data.automation.enabled ? `${futureTime(data.automation.nextRunAt)} · scheduled` : "Manual · starts when you click Find & Rank"],
    ["Company ATS feeds", true, data.readiness.sourceCount ? `${data.readiness.sourceCount} optional feeds configured` : "Optional · grounded search is active"],
    ["Google Sheets", data.readiness.sheetsConfigured, data.readiness.sheetsConfigured ? "Ready to sync" : "Optional · not connected"],
    ["Manual final submission", true, "You review and submit every application"],
    ["Local privacy", true, "Dashboard available only on this Mac"]
  ];
  const readinessList = $("#readiness-list");
  readinessList.replaceChildren();
  for (const [name, ready, detail] of readiness) {
    const item = document.createElement("div");
    item.className = "simple-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    const description = document.createElement("span");
    description.textContent = detail;
    copy.append(title, description);
    const dot = document.createElement("span");
    dot.className = `ready-dot${ready ? "" : " pending"}`;
    item.append(copy, dot);
    readinessList.append(item);
  }
  renderJobs();
  renderActivity();
}

function renderActivity() {
  const activity = state.activity;
  if (!activity) return;
  const from = new Date(activity.from).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const through = new Date(activity.through).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const periodLabel = { week: "This week", month: "This month", year: "This year" }[activity.period];
  $("#activity-range").textContent = `${periodLabel} · ${from} – ${through} · ${activity.total} recorded outcome${activity.total === 1 ? "" : "s"}`;
  const metrics = [
    ["Jobs added", activity.added, "blue"],
    ["Ready to review", activity.counts.ready, "blue"],
    ["Skipped by screening", activity.counts.skipped, "gray"],
    ["Screening errors", activity.counts.failed, "orange"],
    ["Applied", activity.counts.submitted, "green"],
    ["Unavailable", activity.counts.job_closed, "gray"],
    ["Saved for later", activity.counts.saved, "blue"],
    ["Application blocked", activity.counts.application_blocked, "orange"],
    ["Not interested", activity.counts.not_interested, "gray"],
    ["Withdrawn", activity.counts.withdrawn, "gray"]
  ];
  const container = $("#activity-metrics");
  container.replaceChildren();
  for (const [label, value, tone] of metrics) {
    const card = document.createElement("article");
    card.className = `metric-card activity-metric ${tone}`;
    const title = document.createElement("span");
    title.className = "metric-label";
    title.textContent = label;
    const count = document.createElement("strong");
    count.className = "metric-value small";
    count.textContent = String(value);
    card.append(title, count);
    container.append(card);
  }
}

async function refresh(silent = false) {
  try {
    const [data, activity] = await Promise.all([
      api("/api/state"), api(`/api/metrics?period=${state.period}`)
    ]);
    state.data = data;
    state.activity = activity;
    render();
  }
  catch (error) { if (!silent) toast(error.message, true); }
}

async function changePeriod(period, element) {
  state.period = period;
  $$(".period-button").forEach((button) => {
    const active = button === element;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  try {
    state.activity = await api(`/api/metrics?period=${period}`);
    renderActivity();
  } catch (error) { toast(error.message, true); }
}

async function action(element, path, message) {
  await withButton(element, "Working…", async () => {
    const result = await api(path, { method: "POST", body: "{}" });
    toast(typeof message === "function" ? message(result) : message);
    await refresh(true);
  });
}

async function copyText(text, message) {
  await navigator.clipboard.writeText(text);
  toast(message);
}

const dialog = $("#add-job-dialog");
$("#add-job-button").addEventListener("click", () => { dialog.showModal(); $("#job-url").focus(); });
$("#close-dialog").addEventListener("click", () => dialog.close());
$("#cancel-dialog").addEventListener("click", () => dialog.close());
$("#add-job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/jobs", { method: "POST", body: JSON.stringify({ url: $("#job-url").value, source: $("#job-source").value }) });
    dialog.close();
    $("#add-job-form").reset();
    $("#job-source").value = "dashboard";
    toast(result.created ? "Job added to the queue." : "That job is already tracked.");
    await refresh(true);
  } catch (error) { toast(error.message, true); }
});

$("#refresh-button").addEventListener("click", () => refresh());
$("#automation-button").addEventListener("click", (event) => action(event.currentTarget, "/api/automation/run", (result) => `${result.discovered} found · ${result.added} new · ${result.ready} ready · ${result.skipped} skipped${result.discoveryErrors ? ` · ${result.discoveryErrors} source errors` : ""}.`));
$("#empty-automation-button").addEventListener("click", () => $("#automation-button").click());
$("#save-scan-limit").addEventListener("click", async (event) => {
  const limit = Number($("#daily-scan-limit").value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return toast("Enter a daily screening limit from 1 to 100.", true);
  await withButton(event.currentTarget, "Saving…", async () => {
    const result = await api("/api/settings/daily-scan-limit", { method: "POST", body: JSON.stringify({ limit }) });
    toast(result.pendingLimit
      ? `${result.pendingLimit} screenings/day will start on ${result.pendingEffectiveDate}.`
      : `Daily screening limit is ${result.activeLimit}; no future change is pending.`);
    await refresh(true);
  });
});
$("#sync-button").addEventListener("click", (event) => action(event.currentTarget, "/api/sheets/sync", (result) => `${result.rows} jobs synced to Google Sheets.`));

const resumeDialog = $("#add-resume-dialog");
$("#add-resume-button").addEventListener("click", () => { resumeDialog.showModal(); $("#resume-name").focus(); });
$("#close-resume-dialog").addEventListener("click", () => resumeDialog.close());
$("#cancel-resume-upload").addEventListener("click", () => resumeDialog.close());
$("#resume-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#resume-file").files?.[0];
  if (!file) return toast("Choose a PDF résumé to upload.", true);
  if (!$("#resume-ai-consent").checked) return toast("Confirm résumé text processing to continue.", true);
  const name = $("#resume-name").value.trim();
  await withButton($("#upload-resume-submit"), "Indexing résumé…", async () => {
    const response = await fetch(`/api/resumes?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Resume-AI-Consent": String($("#resume-ai-consent").checked) },
      body: file
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
    resumeDialog.close();
    $("#resume-form").reset();
    toast(`${result.resumeSet.name} added · ${result.resumeSetCount} résumé sets available for matching.`);
    await refresh(true);
  });
});

$$('.filter').forEach((element) => element.addEventListener("click", () => {
  $$('.filter').forEach((item) => item.classList.remove("active"));
  element.classList.add("active");
  state.filter = element.dataset.filter;
  renderJobs();
}));
$$('.nav-item').forEach((element) => element.addEventListener("click", () => {
  $$('.nav-item').forEach((item) => item.classList.remove("active"));
  element.classList.add("active");
  const target = { overview: "#overview", pipeline: "#pipeline", activity: "#activity", resumes: "#resumes", connections: "#connections" }[element.dataset.view];
  $(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
}));
$$('.period-button').forEach((element) => element.addEventListener("click", () => changePeriod(element.dataset.period, element)));

refresh();
setInterval(() => refresh(true), 15_000);
