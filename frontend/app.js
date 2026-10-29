import { pcm16ToFloat } from "./pcm-utils.js";
import { userFacingError, tokenErrorMessage, closeDetail } from "./error-messages.js";
import { buildSetupMessage, messageDataToText } from "./live-setup.js";
import { createTranscriptRecorder } from "./transcript-recorder.js";
import { createNoteSaver, postNote } from "./notes-client.js";

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
autoSaveSwitch.checked = readAutoSaveSetting();

setStatus("未接続", "idle");
updateControls();
void initSignIn();
