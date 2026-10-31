import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Static checks of how app.js, index.html and styles.css use the notes panel (work 3-B2).
// Nothing here runs the page; the behaviour of the panel itself is tested in test_notes_list_client.mjs.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const app = sourceOf("../frontend/app.js");
const html = sourceOf("../frontend/index.html");
const css = sourceOf("../frontend/styles.css");

function functionBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start);
  return source.slice(start, end);
}

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} not found`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `${to} not found after ${from}`);
  return source.slice(start, end);
}

// ---------- the save of 3-B1 is as it was ----------

test("app.js still starts a save in exactly three places, and the new code adds none", () => {
  const callPattern = /saveEndedConversation\(\);/g;
  assert.equal([...app.matchAll(callPattern)].length, 3);
  for (const header of ["async function stopSession(", "async function failSession(", "async function handleUnexpectedClose("]) {
    assert.equal([...functionBody(app, header).matchAll(callPattern)].length, 1, header);
  }
  assert.equal([...app.matchAll(/transcriptRecorder\.take\(\)/g)].length, 1);
  assert.equal([...app.matchAll(/noteSaver\.reset\(\)/g)].length, 1);
  assert.equal([...app.matchAll(/noteSaver\.submit\(/g)].length, 1);
  assert.equal([...app.matchAll(/noteSaver\.retry\(\)/g)].length, 1);
});

test("the notes panel code never touches the conversation, the recorder or the saver", () => {
  const forbidden = /noteSaver|transcriptRecorder|startSession|stopSession|failSession|handleUnexpectedClose|saveEndedConversation|conversationActive|isConnected|isStarting|lifecycle|socket|audioContext|microphone/;
  const drawing = between(app, "function showNotesPanel(", "// Called after the clean-up of a conversation");
  assert.doesNotMatch(drawing, forbidden);
  const wiring = between(app, "notesToggle.addEventListener(", "autoSaveSwitch.checked = readAutoSaveSetting();");
  assert.doesNotMatch(wiring, forbidden);
  const setup = between(app, "const HOSTED_FOOTER_NOTE", "let lastOpenedNoteId = null;");
  assert.doesNotMatch(setup, forbidden);
  for (const header of [
    "async function stopSession(", "async function failSession(", "async function handleUnexpectedClose(",
    "async function startSession(", "function saveEndedConversation(", "function releaseAudioResources(",
  ]) {
    assert.doesNotMatch(functionBody(app, header), /notesPanel|renderNotes|notesSection/, header);
  }
});

test("the sign-in code is not changed by the panel: the ID token is only read, never set or cleared", () => {
  assert.equal([...app.matchAll(/idToken\s*=[^=]/g)].length, 3, "declaration, the one place that clears it, and the sign-in callback");
  assert.equal([...app.matchAll(/^\s+idToken = null/gm)].length, 1);
  assert.ok(app.includes("createNotesApi({ getIdToken: () => idToken })"), "the token is read at the moment of each request");
  assert.equal([...app.matchAll(/createNotesApi\(/g)].length, 1, "the api is only handed to the panel, nothing else calls it");
});

test("app.js starts no new request of its own: the two fetches it had are the only ones", () => {
  assert.equal([...app.matchAll(/\bfetch\(/g)].length, 2);
  assert.ok(app.includes('fetch("/api/live-token"'));
  assert.ok(app.includes('fetch("/api/auth-config"'));
});

// ---------- hosted version only ----------

test("the panel is hidden in the page, and shown from one place: the hosted-version branch of initSignIn", () => {
  assert.match(html, /<section id="notes-panel"[^>]*\shidden>/);
  assert.equal([...app.matchAll(/notesSection\.hidden = false/g)].length, 1);
  assert.equal([...app.matchAll(/showNotesPanel\(\);/g)].length, 1);
  assert.equal([...app.matchAll(/showHostedFooter\(\);/g)].length, 1);
  const init = functionBody(app, "async function initSignIn(");
  const authOn = init.indexOf("authRequired = true;");
  assert.ok(authOn >= 0);
  assert.ok(init.indexOf("showNotesPanel();") > authOn, "after the hosted version was established");
  assert.ok(init.indexOf("showHostedFooter();") > authOn);
  assert.ok(init.indexOf("showAutoSaveControls();") < init.indexOf("showNotesPanel();"), "next to the 3-B1 switch");
  // Every early return of initSignIn (no hosted version) comes before it, so nothing is shown or called there.
  for (const match of init.matchAll(/\breturn;/g)) assert.ok(match.index < authOn || match.index > init.indexOf("showNotesPanel();"), "no early exit in between");
});

test("the footer: the original words stay in the page, wrapped in one span, and only the hosted branch replaces them", () => {
  assert.ok(html.includes('<span id="footer-note">ローカル利用向けの試作アプリです。公開サーバーには配置しないでください。</span>'));
  assert.equal([...app.matchAll(/footerNoteElement\.textContent/g)].length, 1);
  assert.equal(functionBody(app, "function showHostedFooter(").includes("footerNoteElement.textContent = HOSTED_FOOTER_NOTE;"), true);
  assert.ok(app.includes('const HOSTED_FOOTER_NOTE = "個人用のアプリです。許可された1人だけが使えます。";'));
});

test("nothing in the panel is requested or drawn at load time: the panel starts closed and no code opens it on its own", () => {
  assert.match(html, /<div id="notes-body"[^>]*\shidden>/);
  assert.equal([...app.matchAll(/notesPanel\.open\(\)/g)].length, 1, "only the toggle button opens it");
  const open = [...app.matchAll(/notesPanel\.open\(\)/g)][0].index;
  assert.ok(app.lastIndexOf("notesToggle.addEventListener", open) > app.lastIndexOf("\n\n", open) - 400);
  assert.doesNotMatch(app, /setInterval\(/);
  assert.doesNotMatch(between(app, "function showNotesPanel(", "// Called after the clean-up of a conversation"), /setTimeout|setInterval/);
});

// ---------- safe drawing ----------

test("the panel code builds elements and sets text; it never inserts HTML, and uses no browser dialogs or storage", () => {
  const code = [
    between(app, "function showNotesPanel(", "// Called after the clean-up of a conversation"),
    between(app, "notesToggle.addEventListener(", "autoSaveSwitch.checked = readAutoSaveSetting();"),
  ].join("\n");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.insertAdjacent|createContextualFragment|DOMParser/i);
  assert.doesNotMatch(code, /\bconfirm\(|\balert\(|\bprompt\(|localStorage|sessionStorage|indexedDB|\bconsole\b/);
  assert.match(code, /createElement\("li"\)/);
  assert.match(code, /notesDetailBody\.textContent = /);
  assert.match(code, /title\.textContent = item\.titleText/);
  assert.match(code, /replaceChildren\(/);
  // Every value that comes from a note goes in through textContent or a data attribute, never through markup.
  assert.doesNotMatch(code, /\.innerText\s*=/);
  assert.doesNotMatch(app, /sessionStorage|indexedDB|\bconsole\b|innerHTML|outerHTML|insertAdjacentHTML/i);
});

test("the body of a note is shown in a <pre> that keeps line breaks and wraps long lines, inside a frame that scrolls", () => {
  assert.match(html, /<pre id="notes-detail-body"/);
  const rule = between(css, ".notes-detail-body {", "}");
  assert.match(rule, /white-space:\s*pre-wrap/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
  assert.match(rule, /max-height:/);
  assert.match(rule, /overflow:\s*auto/);
});

// ---------- the page ----------

test("every element app.js looks up exists in index.html, and no id is used twice", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  const wanted = [...app.matchAll(/querySelector\("#([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(wanted.length > 30);
  for (const id of wanted) assert.ok(ids.includes(id), `#${id} is missing from index.html`);
});

test("the panel has its own message area (a live region) and does not use the save result area of 3-B1", () => {
  assert.match(html, /<div id="notes-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.includes('id="note-save"'), "the 3-B1 area is still there");
  const saveArea = between(html, '<div id="note-save"', "</section>");
  assert.doesNotMatch(saveArea, /notes-/, "and the panel is not inside it");
  assert.equal([...app.matchAll(/noteSaveMessage\.textContent/g)].length, 1, "only renderNoteSave writes there");
  const panelPart = between(app, "function showNotesPanel(", "// Called after the clean-up of a conversation");
  assert.doesNotMatch(panelPart, /noteSave/);
});

test("the panel sits below the transcripts and before the footer, and the page still loads app.js the same way", () => {
  const transcripts = html.indexOf('<section class="transcript-grid"');
  const panel = html.indexOf('<section id="notes-panel"');
  const footer = html.indexOf('<footer class="page-footer">');
  assert.ok(transcripts >= 0 && panel > transcripts && footer > panel);
  assert.equal([...html.matchAll(/<script\b/g)].length, 2, "the two scripts it had; no inline script was added");
  assert.ok(html.includes('<script type="module" src="/app.js"></script>'));
  assert.ok(app.includes('import { createNotesApi, createNotesPanel } from "./notes-list-client.js";'), "written like the other imports");
  assert.ok(app.includes('import { createNoteSaver, postNote } from "./notes-client.js";'));
});

test("the buttons of the panel are tall enough for a finger, and the panel hides what is hidden", () => {
  assert.match(css, /\.notes-panel \.button\s*\{\s*min-height:\s*48px;\s*\}/);
  assert.match(between(css, ".notes-item {", "}"), /min-height:\s*56px/);
  assert.match(css, /\.notes-panel \[hidden\], \.notes-panel\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
  for (const id of ["notes-toggle", "notes-retry", "notes-status-refresh", "notes-confirm-yes", "notes-confirm-no", "notes-refresh", "notes-delete-all", "notes-back", "notes-delete-one"]) {
    assert.match(html, new RegExp(`<button id="${id}" class="button [^"]*" type="button"`), id);
  }
  assert.doesNotMatch(css, /@import|url\(/, "no new outside file");
});

test("the delete buttons are asked for only through the panel's question, never wired straight to a delete", () => {
  assert.match(app, /notesDeleteOne\.addEventListener\("click", \(\) => void notesPanel\.askDeleteOne\(\)\)/);
  assert.match(app, /notesDeleteAll\.addEventListener\("click", \(\) => void notesPanel\.askDeleteAll\(\)\)/);
  assert.match(app, /notesConfirmYes\.addEventListener\("click", \(\) => void notesPanel\.confirmDelete\(\)\)/);
  assert.equal([...app.matchAll(/confirmDelete\(\)/g)].length, 1);
  assert.doesNotMatch(app, /\.remove\(|\.removeAll\(/);
});

// ---------- the change is additions only ----------

// These need the git history of the commit 3-B2 started from. Without it (a download of the files only) they are skipped.
function originalOf(path) {
  const r = spawnSync("git", ["show", `cb1468c:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 && typeof r.stdout === "string" && r.stdout !== "" ? r.stdout : null;
}

function isSubsequence(before, after) {
  let i = 0;
  for (const line of after) if (i < before.length && line === before[i]) i += 1;
  return i === before.length;
}

test("app.js: every line of the version 3-B2 started from is still there, in order (only lines were added)", (t) => {
  const before = originalOf("frontend/app.js");
  if (before === null) return t.skip("git history of cb1468c is not available");
  assert.ok(isSubsequence(before.split("\n"), app.split("\n")));
});

test("styles.css: the version 3-B2 started from is unchanged at the start; the panel's rules were appended", (t) => {
  const before = originalOf("frontend/styles.css");
  if (before === null) return t.skip("git history of cb1468c is not available");
  assert.ok(css.startsWith(before));
});

test("index.html: only the footer line changed; the rest of the old lines are all still there, in order", (t) => {
  const before = originalOf("frontend/index.html");
  if (before === null) return t.skip("git history of cb1468c is not available");
  const footerLine = "        <p>ローカル利用向けの試作アプリです。公開サーバーには配置しないでください。</p>";
  const beforeLines = before.split("\n");
  assert.equal(beforeLines.filter((line) => line === footerLine).length, 1);
  const kept = beforeLines.filter((line) => line !== footerLine);
  assert.ok(isSubsequence(kept, html.split("\n")));
  assert.ok(!html.split("\n").includes(footerLine), "the old footer line is replaced by the wrapped one");
});
