import { pcm16ToFloat } from "./pcm-utils.js";
import { userFacingError, tokenErrorMessage, closeDetail } from "./error-messages.js";
import { buildSetupMessage, messageDataToText } from "./live-setup.js";
import { createTranscriptRecorder } from "./transcript-recorder.js";
import { createNoteSaver, postNote } from "./notes-client.js";
import { createNotesApi, createNotesPanel } from "./notes-list-client.js";

const statusElement = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const errorElement = document.querySelector("#error-message");
const inputTranscriptElement = document.querySelector("#input-transcript");
const outputTranscriptElement = document.querySelector("#output-transcript");
const startButton = document.querySelector("#start-button");
const interruptButton = document.querySelector("#interrupt-button");
const stopButton = document.querySelector("#stop-button");
const historyNoteElement = document.querySelector("#history-note");
const autoSaveRow = document.querySelector("#autosave-row");
const autoSaveSwitch = document.querySelector("#autosave-switch");
const noteSaveBox = document.querySelector("#note-save-box");
const noteSaveMessage = document.querySelector("#note-save-message");
const noteSaveRetry = document.querySelector("#note-save-retry");
const noteSaveHint = document.querySelector("#note-save-hint");
const footerNoteElement = document.querySelector("#footer-note");
const notesSection = document.querySelector("#notes-panel");
const notesToggle = document.querySelector("#notes-toggle");
const notesBody = document.querySelector("#notes-body");
const notesStatusMessage = document.querySelector("#notes-status-message");
const notesStatusActions = document.querySelector("#notes-status-actions");
const notesRetry = document.querySelector("#notes-retry");
const notesStatusRefresh = document.querySelector("#notes-status-refresh");
const notesBusy = document.querySelector("#notes-busy");
const notesConfirm = document.querySelector("#notes-confirm");
const notesConfirmText = document.querySelector("#notes-confirm-text");
const notesConfirmYes = document.querySelector("#notes-confirm-yes");
const notesConfirmNo = document.querySelector("#notes-confirm-no");
const notesListView = document.querySelector("#notes-list-view");
const notesCount = document.querySelector("#notes-count");
const notesRefresh = document.querySelector("#notes-refresh");
const notesEmpty = document.querySelector("#notes-empty");
const notesItems = document.querySelector("#notes-items");
const notesDeleteAll = document.querySelector("#notes-delete-all");
const notesDetailView = document.querySelector("#notes-detail-view");
const notesBack = document.querySelector("#notes-back");
const notesDetailTitle = document.querySelector("#notes-detail-title");
const notesDetailMeta = document.querySelector("#notes-detail-meta");
const notesDetailBody = document.querySelector("#notes-detail-body");
const notesDeleteOne = document.querySelector("#notes-delete-one");

const SYSTEM_INSTRUCTION =
  "あなたは日本語で自然に会話する音声アシスタントです。" +
  "簡潔で親しみやすく、相手の発話に直接答えてください。";
const AUDIO_SAMPLE_RATE = 24000;
const INPUT_MIME_TYPE = "audio/pcm;rate=16000";
const GOOGLE_SCRIPT_TIMEOUT_MS = 10000;
const AUTO_SAVE_KEY = "ken.autoSaveNotes";
const HOSTED_HISTORY_NOTE = "音声は保存されません。「自動保存」がオンのとき、会話の文字起こしが、メモとして保存されます（あなただけが見られます）。";

let lifecycle = 0;
let isStarting = false;
let isConnected = false;
let socket = null;
let audioContext = null;
let microphoneStream = null;
let microphoneSource = null;
let captureNode = null;
let mutedCaptureGain = null;
let scheduledPlayback = new Set();
let nextPlaybackTime = 0;
let suppressPlayback = false;
let committedInputTranscript = "";
let interimInputTranscript = "";
let outputTranscript = "";
const transcriptRecorder = createTranscriptRecorder();
// Hosted (Google sign-in) mode: the ID token lives only in memory, never in storage.
let authRequired = false;
let authClientId = null;
let idToken = null;
let conversationActive = false;
// Saving a finished conversation as a note. It reads the ID token at the moment of each request.
const noteSaver = createNoteSaver({ send: (note) => postNote(note, { idToken }), onChange: renderNoteSave });
// Notes panel (hosted version only): the list, one note, deleting. Its state lives in notes-list-client.js and this part
// only draws it. It reads the ID token at the moment of each request, and it does not touch the conversation code above.
const HOSTED_FOOTER_NOTE = "個人用のアプリです。許可された1人だけが使えます。";
const notesPanel = createNotesPanel({ api: createNotesApi({ getIdToken: () => idToken }), onChange: renderNotes });
let renderedNotesListVersion = -1;
let renderedNotesDetailVersion = -1;
let renderedNotesScreen = "list";
let renderedNotesConfirm = false;
let lastOpenedNoteId = null;

function setStatus(message, state) {
  statusText.textContent = message;
  statusElement.dataset.state = state;
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function clearError() {
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function updateControls() {
  startButton.disabled = isStarting || isConnected || (authRequired && !idToken);
  interruptButton.disabled = !isConnected;
  stopButton.disabled = !(isStarting || isConnected || socket || microphoneStream || audioContext);
}

function renderInputTranscript() {
  const value = committedInputTranscript + interimInputTranscript;
  inputTranscriptElement.textContent = value || "話した内容がここに表示されます。";
}

function resetTranscripts() {
  committedInputTranscript = "";
  interimInputTranscript = "";
  outputTranscript = "";
  renderInputTranscript();
  outputTranscriptElement.textContent = "Gemini の返答がここに表示されます。";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function stopScheduledPlayback() {
  for (const source of scheduledPlayback) {
    try {
      source.stop();
    } catch {
      // A source that already ended does not need additional handling.
    }
    try {
      source.disconnect();
    } catch {
      // It may already be disconnected.
    }
  }
  scheduledPlayback.clear();
  nextPlaybackTime = audioContext ? audioContext.currentTime : 0;
}

function playAudioChunk(base64Data) {
  if (suppressPlayback || !audioContext || audioContext.state === "closed") return;

  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const samples = pcm16ToFloat(bytes);
  if (samples.length === 0) return;

  const buffer = audioContext.createBuffer(1, samples.length, AUDIO_SAMPLE_RATE);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const startAt = Math.max(audioContext.currentTime + 0.02, nextPlaybackTime);
  nextPlaybackTime = startAt + buffer.duration;
  scheduledPlayback.add(source);
  source.onended = () => {
    scheduledPlayback.delete(source);
    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
  };
  source.start(startAt);
}

function appendTranscript(current, next) {
  if (!next) return current;
  return current + next;
}

function handleServerMessage(message) {
  if (message.error) {
    throw new Error("Gemini Live API からエラー応答を受信しました。");
  }

  const content = message.serverContent;
  if (!content) return;

  if (content.interrupted) {
    stopScheduledPlayback();
    suppressPlayback = false;
  }

  if (content.inputTranscription?.text) {
    committedInputTranscript = appendTranscript(committedInputTranscript, content.inputTranscription.text);
    interimInputTranscript = "";
    renderInputTranscript();
    transcriptRecorder.add("user", content.inputTranscription.text);
  }

  if (content.interimInputTranscription?.text) {
    interimInputTranscript = content.interimInputTranscription.text;
    renderInputTranscript();
  }

  if (content.outputTranscription?.text) {
    outputTranscript = appendTranscript(outputTranscript, content.outputTranscription.text);
    outputTranscriptElement.textContent = outputTranscript;
    transcriptRecorder.add("ai", content.outputTranscription.text);
  }

  for (const part of content.modelTurn?.parts ?? []) {
    if (part.inlineData?.data && (part.inlineData.mimeType ?? "audio/pcm").startsWith("audio/pcm")) {
      playAudioChunk(part.inlineData.data);
    }
  }

  if (content.turnComplete) suppressPlayback = false;
}

function releaseAudioResources({ closeSocket = true } = {}) {
  const activeSocket = socket;
  socket = null;
  if (closeSocket && activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
    try {
      activeSocket.close(1000, "User ended session");
    } catch {
      // Cleanup continues even if the socket is already closing.
    }
  }

  if (captureNode) {
    try {
      captureNode.port.postMessage({ type: "stop" });
      captureNode.port.close();
      captureNode.disconnect();
    } catch {
      // The audio graph may already have stopped.
    }
    captureNode = null;
  }

  if (microphoneSource) {
    try {
      microphoneSource.disconnect();
    } catch {
      // The node may already be disconnected.
    }
    microphoneSource = null;
  }

  if (mutedCaptureGain) {
    try {
      mutedCaptureGain.disconnect();
    } catch {
      // The node may already be disconnected.
    }
    mutedCaptureGain = null;
  }

  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) track.stop();
    microphoneStream = null;
  }

  stopScheduledPlayback();
  const context = audioContext;
  audioContext = null;
  if (context && context.state !== "closed") {
    return context.close().catch(() => {});
  }
  return Promise.resolve();
}

async function stopSession() {
  lifecycle += 1;
  isStarting = false;
  isConnected = false;
  await releaseAudioResources();
  suppressPlayback = false;
  clearError();
  setStatus("未接続", "idle");
  updateControls();
  saveEndedConversation();
}

async function failSession(message) {
  lifecycle += 1;
  isStarting = false;
  isConnected = false;
  await releaseAudioResources();
  suppressPlayback = false;
  showError(message);
  setStatus("エラー", "error");
  updateControls();
  saveEndedConversation();
}

let lastCloseDetail = "";

async function handleUnexpectedClose() {
  if (!isStarting && !isConnected) return;
  lifecycle += 1;
  isStarting = false;
  isConnected = false;
  await releaseAudioResources({ closeSocket: false });
  showError(`Gemini Live との接続が切れました。「会話を開始」から再接続してください。${lastCloseDetail ? `（${lastCloseDetail}）` : ""}`);
  setStatus("接続が切断されました", "error");
  updateControls();
  saveEndedConversation();
}

function connectWebSocket(token, model, websocketBaseUrl, runId) {
  return new Promise((resolve, reject) => {
    let setupFinished = false;
    const wsUrl = new URL(websocketBaseUrl);
    wsUrl.searchParams.set("access_token", token);
    const activeSocket = new WebSocket(wsUrl.toString());
    socket = activeSocket;

    activeSocket.addEventListener("open", () => {
      if (runId !== lifecycle) {
        activeSocket.close();
        return;
      }
      const setup = buildSetupMessage(model, SYSTEM_INSTRUCTION);
      activeSocket.send(JSON.stringify(setup));
    });

    // Messages are decoded asynchronously (binary frames), so process them strictly in arrival order.
    let messageChain = Promise.resolve();
    activeSocket.addEventListener("message", (event) => {
      messageChain = messageChain.then(async () => {
        let stage = "decode";
        try {
          const text = await messageDataToText(event.data);
          stage = "parse";
          const message = JSON.parse(text);
          stage = "handle";
          if (message.setupComplete && !setupFinished) {
            setupFinished = true;
            resolve();
          }
          handleServerMessage(message);
        } catch {
          const label = { decode: "受信形式", parse: "JSON 解析", handle: "メッセージ処理" }[stage];
          if (!setupFinished) {
            reject(new Error(`Gemini Live から正しい応答を受信できませんでした。（${label}）`));
          } else {
            void failSession(`Gemini Live から不正な応答を受信したため、接続を終了しました。（${label}）`);
          }
        }
      });
    });

    activeSocket.addEventListener("error", () => {
      if (!setupFinished) {
        reject(new Error("Gemini Live に接続できませんでした。API の利用状況とネットワークを確認してください。"));
      } else {
        void failSession("Gemini Live との通信でエラーが発生しました。");
      }
    });

    activeSocket.addEventListener("close", (closeEvent) => {
      lastCloseDetail = closeDetail(closeEvent?.code, closeEvent?.reason);
      if (!setupFinished) {
        reject(new Error(`Gemini Live の接続がセットアップ完了前に終了しました。${lastCloseDetail ? `（${lastCloseDetail}）` : ""}`));
      }
      if (socket === activeSocket) {
        socket = null;
        void handleUnexpectedClose();
      }
    });
  });
}

async function startSession() {
  if (isStarting || isConnected) return;
  const runId = ++lifecycle;
  isStarting = true;
  clearError();
  resetTranscripts();
  transcriptRecorder.reset();
  noteSaver.reset();
  setStatus("接続中…", "connecting");
  updateControls();

  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
      throw new Error("このブラウザーは必要な音声機能に対応していません。最新の Chrome または Edge でお試しください。");
    }

    audioContext = new AudioContext();
    nextPlaybackTime = 0;
    suppressPlayback = false;
    const microphoneRequest = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const requestedStream = await microphoneRequest;
    if (runId !== lifecycle) {
      for (const track of requestedStream.getTracks()) track.stop();
      return;
    }
    microphoneStream = requestedStream;
    await audioContext.resume();
    if (runId !== lifecycle) return;

    const headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (authRequired) headers.Authorization = `Bearer ${idToken}`;
    const tokenResponse = await fetch("/api/live-token", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: "{}",
    });
    if (!tokenResponse.ok) {
      if (authRequired && tokenResponse.status === 401) {
        idToken = null;
        updateControls();
      }
      const errorBody = await tokenResponse.json().catch(() => null);
      const errorCode = typeof errorBody?.error === "string" ? errorBody.error : undefined;
      throw new Error(tokenErrorMessage(tokenResponse.status, errorCode, errorBody));
    }
    const tokenData = await tokenResponse.json().catch(() => {
      throw new Error(tokenErrorMessage(401));
    });
    if (typeof tokenData.token !== "string" || typeof tokenData.model !== "string" || typeof tokenData.websocket_url !== "string") {
      throw new Error("サーバーから不正なセッション情報が返されました。");
    }
    if (runId !== lifecycle) return;

    await connectWebSocket(tokenData.token, tokenData.model, tokenData.websocket_url, runId);
    if (runId !== lifecycle) return;

    await audioContext.audioWorklet.addModule("/pcm-worklet.js");
    if (runId !== lifecycle) return;

    microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
    captureNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { chunkSamples: 320 },
    });
    mutedCaptureGain = audioContext.createGain();
    mutedCaptureGain.gain.value = 0;
    captureNode.port.onmessage = (event) => {
      if (event.data?.type !== "audio" || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 512 * 1024) return;
      const bytes = new Uint8Array(event.data.buffer);
      socket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: bytesToBase64(bytes),
            mimeType: INPUT_MIME_TYPE,
          },
        },
      }));
    };

    microphoneSource.connect(captureNode);
    captureNode.connect(mutedCaptureGain);
    mutedCaptureGain.connect(audioContext.destination);
    if (runId !== lifecycle) return;

    isConnected = true;
    conversationActive = true;
    isStarting = false;
    setStatus("会話中", "connected");
    updateControls();
  } catch (error) {
    if (runId !== lifecycle) return;
    await releaseAudioResources();
    if (runId !== lifecycle) return;
    showError(userFacingError(error));
    setStatus("エラー", "error");
  } finally {
    if (runId === lifecycle) {
      isStarting = false;
      updateControls();
    }
  }
}

function renderNoteSave(view) {
  noteSaveBox.hidden = !view.visible;
  noteSaveMessage.textContent = view.message;
  noteSaveRetry.hidden = !view.showRetry;
  noteSaveRetry.disabled = view.retryDisabled;
  noteSaveHint.hidden = !view.hint;
  noteSaveHint.textContent = view.hint;
}

function readAutoSaveSetting() {
  try {
    return localStorage.getItem(AUTO_SAVE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeAutoSaveSetting(value) {
  try {
    localStorage.setItem(AUTO_SAVE_KEY, value ? "true" : "false");
  } catch {
    // Without storage the switch still works for this page view.
  }
}

function showAutoSaveControls() {
  autoSaveRow.hidden = false;
  historyNoteElement.textContent = HOSTED_HISTORY_NOTE;
}

function showNotesPanel() {
  notesSection.hidden = false;
}

function showHostedFooter() {
  footerNoteElement.textContent = HOSTED_FOOTER_NOTE;
}

// One note in the list: a button with its time, its title and, for a note that was cut short, a mark.
// Everything goes in with textContent; nothing from a note is ever read as HTML.
function buildNotesItem(item) {
  const entry = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "notes-item";
  button.dataset.noteId = item.id;
  const date = document.createElement("span");
  date.className = "notes-item-date";
  date.textContent = item.dateText;
  const title = document.createElement("span");
  title.className = "notes-item-title";
  title.textContent = item.titleText;
  button.append(date, title);
  if (item.truncatedMark !== "") {
    const mark = document.createElement("span");
    mark.className = "notes-item-mark";
    mark.textContent = item.truncatedMark;
    button.append(mark);
  }
  entry.append(button);
  return entry;
}

function focusNotesItem(id) {
  for (const button of notesItems.querySelectorAll("button")) {
    if (button.dataset.noteId === id) {
      button.focus();
      return;
    }
  }
}

function renderNotes(view) {
  const locked = view.busy;
  notesToggle.textContent = view.open ? "メモを閉じる" : "メモを開く";
  notesToggle.setAttribute("aria-expanded", view.open ? "true" : "false");
  notesBody.hidden = !view.open;
  if (!view.open) lastOpenedNoteId = null;

  notesStatusMessage.textContent = view.status.message;
  notesStatusMessage.hidden = view.status.message === "";
  notesRetry.hidden = !view.status.showRetry;
  notesRetry.disabled = locked;
  notesStatusRefresh.hidden = !view.status.showRefresh;
  notesStatusRefresh.disabled = locked;
  notesStatusActions.hidden = !view.status.showRetry && !view.status.showRefresh;
  notesBusy.textContent = view.busyText;
  notesBusy.hidden = view.busyText === "";

  // The list and the body are drawn again only when they changed, so that a focused button is not replaced meanwhile.
  if (view.listVersion !== renderedNotesListVersion) {
    renderedNotesListVersion = view.listVersion;
    notesItems.replaceChildren(...(view.list === null ? [] : view.list.items.map(buildNotesItem)));
  }
  if (view.detailVersion !== renderedNotesDetailVersion) {
    renderedNotesDetailVersion = view.detailVersion;
    notesDetailTitle.textContent = view.detail === null ? "" : view.detail.titleText;
    notesDetailMeta.textContent = view.detail === null ? "" : [view.detail.dateText, view.detail.truncatedMark].filter(Boolean).join(" ");
    notesDetailBody.textContent = view.detail === null ? "" : view.detail.body;
    notesDetailBody.scrollTop = 0;
  }

  const onList = view.screen === "list";
  notesListView.hidden = !onList;
  notesDetailView.hidden = onList;
  notesCount.textContent = view.list === null ? "" : view.list.countText;
  notesCount.hidden = view.list === null;
  notesEmpty.textContent = view.list === null ? "" : view.list.emptyText;
  notesEmpty.hidden = view.list === null || view.list.emptyText === "";
  notesRefresh.disabled = locked;
  notesDeleteAll.hidden = !view.canAskDeleteAll;
  notesDeleteAll.disabled = locked;
  for (const button of notesItems.querySelectorAll("button")) button.disabled = locked || view.confirm !== null;
  notesBack.disabled = locked;
  notesDeleteOne.hidden = !view.canAskDeleteOne;
  notesDeleteOne.disabled = locked;

  notesConfirm.hidden = view.confirm === null;
  if (view.confirm !== null) {
    notesConfirmText.textContent = view.confirm.text;
    notesConfirmYes.textContent = view.confirm.yesLabel;
    notesConfirmNo.textContent = view.confirm.noLabel;
  }
  notesConfirmYes.disabled = locked;
  notesConfirmNo.disabled = locked;

  // Where the focus goes when the screen changes: the question opens on "cancel" (the safe answer), a note opens on
  // "back to the list", and going back returns to the note that was open.
  const screenChanged = view.screen !== renderedNotesScreen;
  renderedNotesScreen = view.screen;
  const confirmAppeared = view.confirm !== null && !renderedNotesConfirm;
  renderedNotesConfirm = view.confirm !== null;
  if (view.open && confirmAppeared) notesConfirmNo.focus();
  else if (view.open && screenChanged) {
    if (view.screen === "detail") notesBack.focus();
    else if (lastOpenedNoteId !== null) focusNotesItem(lastOpenedNoteId);
  }
}

// Called after the clean-up of a conversation that was really running. Never waits and never throws,
// so the end-of-conversation code that calls it behaves as before whatever happens here.
function saveEndedConversation() {
  if (!conversationActive) return;
  conversationActive = false;
  try {
    if (!authRequired || !autoSaveSwitch.checked) return;
    void noteSaver.submit(transcriptRecorder.take());
  } catch {
    // Saving is best effort.
  }
}

function interruptPlayback() {
  if (!isConnected || !audioContext) return;
  stopScheduledPlayback();
  suppressPlayback = true;
}

function onGoogleCredential(response) {
  if (!response || typeof response.credential !== "string" || !response.credential) return;
  idToken = response.credential;
  clearError();
  setStatus("サインイン済み", "idle");
  updateControls();
}

async function initSignIn() {
  let config;
  try {
    const res = await fetch("/api/auth-config", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) {
      showError(
        res.status === 404
          ? "Googleログインの設定がサーバーにありません。Cloudflare Pages の環境変数 AUTH_PROVIDER と GOOGLE_CLIENT_ID を確認してください。"
          : `Googleログイン設定を取得できませんでした（HTTP ${res.status}）。Cloudflare Pages の設定とアクセス制御を確認してください。`,
      );
      return;
    }
    config = await res.json();
  } catch {
    return;
  }
  if (config?.provider !== "google" || typeof config.clientId !== "string" || !config.clientId) return;

  authRequired = true;
  authClientId = config.clientId;
  showAutoSaveControls();
  showNotesPanel();
  showHostedFooter();
  updateControls();

  const container = document.querySelector("#google-signin");
  const attachButton = () => {
    if (!window.google?.accounts?.id) {
      showError("Google サインインを読み込めませんでした。ページを再読み込みしてください。");
      return;
    }
    window.google.accounts.id.initialize({
      client_id: authClientId,
      callback: onGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.renderButton(container, { theme: "outline", size: "large", text: "signin_with", locale: "ja" });
    clearError();
  };

  // The module may finish its config fetch after the window load event has fired.
  // Waiting for the script itself avoids registering a load listener too late.
  if (window.google?.accounts?.id) {
    attachButton();
  } else {
    const googleScript = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (!googleScript) {
      showError("Google サインインのスクリプトが見つかりません。");
      return;
    }
    const onLoadFailure = () => {
      showError("Google サインインを読み込めませんでした。通信設定を確認してください。");
    };
    googleScript.addEventListener("load", attachButton, { once: true });
    googleScript.addEventListener("error", onLoadFailure, { once: true });
    // If the script failed before the listeners above were attached, no event fires at all.
    // Check after a deadline so the user is never left with a silent, empty sign-in area.
    setTimeout(() => {
      if (!window.google?.accounts?.id) onLoadFailure();
    }, GOOGLE_SCRIPT_TIMEOUT_MS);
  }
}

startButton.addEventListener("click", () => void startSession());
interruptButton.addEventListener("click", interruptPlayback);
stopButton.addEventListener("click", () => void stopSession());
autoSaveSwitch.addEventListener("change", () => writeAutoSaveSetting(autoSaveSwitch.checked));
noteSaveRetry.addEventListener("click", () => void noteSaver.retry());
notesToggle.addEventListener("click", () => {
  if (notesPanel.getView().open) notesPanel.close();
  else void notesPanel.open();
});
notesRefresh.addEventListener("click", () => void notesPanel.refresh());
notesStatusRefresh.addEventListener("click", () => void notesPanel.refresh());
notesRetry.addEventListener("click", () => void notesPanel.retry());
notesItems.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-note-id]") : null;
  if (!button) return;
  lastOpenedNoteId = button.dataset.noteId;
  void notesPanel.select(button.dataset.noteId);
});
notesBack.addEventListener("click", () => void notesPanel.back());
notesDeleteOne.addEventListener("click", () => void notesPanel.askDeleteOne());
notesDeleteAll.addEventListener("click", () => void notesPanel.askDeleteAll());
notesConfirmYes.addEventListener("click", () => void notesPanel.confirmDelete());
notesConfirmNo.addEventListener("click", () => void notesPanel.cancelConfirm());
autoSaveSwitch.checked = readAutoSaveSetting();

setStatus("未接続", "idle");
updateControls();
void initSignIn();
